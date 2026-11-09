// Chế độ test local: bridge tự nhận tin bằng long polling (getUpdates) thay cho webhook,
// nên chạy được cả luồng Telegram → bridge → Agent / hộp thư Claude mà không cần Cloudflare Tunnel.
// Mỗi update đi qua đúng handleUpdate() mà /tg/webhook dùng, nên hành vi giống hệt khi chạy thật.
//
// Telegram không cho getUpdates khi bot đang có webhook → lúc bật, bridge tự gỡ webhook
// (không xoá tin đang chờ). Chỉ một tiến trình được getUpdates: để TG_POLLING=0 bên Agent.

import { handleUpdate, type BridgeDeps } from './server.ts';
import { TelegramError, sleep, type TgUpdate } from '../shared/telegram.ts';
import { logger } from '../shared/log.ts';

const log = logger('bridge-poll');

export interface PollingState {
  running: boolean;
  lastOkAt: string | null; // lần getUpdates thành công gần nhất
  lastError: string | null;
  updates: number; // số update đã nhận từ khi bật
}

export const newPollingState = (): PollingState => ({ running: false, lastOkAt: null, lastError: null, updates: 0 });

export interface PollingOptions {
  timeoutS?: number; // long polling timeout của getUpdates (Telegram tối đa 50; TelegramApi cắt ở 30s)
  errorDelayMs?: number;
  conflictDelayMs?: number;
}

/** Bật vòng getUpdates. Trả hàm dừng; await hàm đó để chờ vòng lặp kết thúc. */
export function startBridgePolling(d: BridgeDeps, state: PollingState, opts: PollingOptions = {}): () => Promise<void> {
  const timeoutS = opts.timeoutS ?? 25;
  const errorDelayMs = opts.errorDelayMs ?? 5_000;
  const conflictDelayMs = opts.conflictDelayMs ?? 10_000;
  let stopped = false;
  let offset = 0;

  const loop = (async () => {
    state.running = true;
    try {
      const info = await d.tg.getWebhookInfo();
      if (info.url) {
        await d.tg.call('deleteWebhook', { drop_pending_updates: false });
        log.warn(`Đã gỡ webhook ${info.url} để chạy BRIDGE_POLLING (tin đang chờ vẫn giữ). Chạy thật lại: BRIDGE_POLLING=0 rồi khởi động lại bridge.`);
      }
    } catch (err) {
      log.warn('Không kiểm tra / gỡ được webhook, vẫn thử getUpdates', err);
    }
    log.info('Bật BRIDGE_POLLING: bridge tự nhận tin Telegram bằng getUpdates (chế độ test local, không cần tunnel)');

    // Lần đầu và lần đầu sau mỗi lỗi gọi timeout 0 (trả về ngay) để get_status biết ngay polling đã thông,
    // thay vì chờ một vòng long polling 25 giây.
    let quick = true;
    while (!stopped) {
      let updates: TgUpdate[];
      try {
        updates = await d.tg.call<TgUpdate[]>('getUpdates', { offset, timeout: quick ? 0 : timeoutS, allowed_updates: ['message', 'callback_query'] });
        quick = false;
        if (state.lastError) log.info('getUpdates chạy lại bình thường');
        state.lastOkAt = new Date().toISOString();
        state.lastError = null;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        const repeated = state.lastError === msg; // lỗi kéo dài: chỉ ghi log lần đầu
        state.lastError = msg;
        quick = true;
        if (err instanceof TelegramError && err.code === 409) {
          if (!repeated) log.error('getUpdates bị 409: Agent đang chạy TG_POLLING=1 hoặc có webhook mới được đặt. Để TG_POLLING=0 bên Agent; bridge tự thử lại.', err.description);
          await sleep(conflictDelayMs);
        } else {
          if (!repeated) log.warn(`getUpdates lỗi, thử lại mỗi ${errorDelayMs / 1000}s`, err);
          await sleep(errorDelayMs);
        }
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1; // lần getUpdates sau sẽ xác nhận với Telegram là đã nhận
        state.updates++;
        try {
          const r = await handleUpdate(d, u);
          log.debug(`update ${u.update_id} → ${r}`);
        } catch (err) {
          // Giống webhook: ghi log và đi tiếp; update trùng khi khởi động lại bị chặn theo update_id.
          log.error(`Xử lý update ${u.update_id} lỗi`, err);
        }
      }
    }
    state.running = false;
  })();

  return async () => {
    stopped = true;
    await loop;
  };
}
