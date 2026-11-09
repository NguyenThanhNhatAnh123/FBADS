// Chế độ dự phòng: Agent tự nhận tin bằng long polling (getUpdates), không cần bridge.
// Dùng khi chạy thử Giai đoạn 1 trước khi dựng bridge + Cloudflare Tunnel.
// Telegram không cho getUpdates khi đã đặt webhook → khi bridge chạy thì TẮT chế độ này (TG_POLLING=0).

import type { AgentApp } from './app.ts';
import { TelegramError, sleep, type TelegramApi, type TgUpdate } from '../shared/telegram.ts';
import { logger } from '../shared/log.ts';

const log = logger('polling');

export function startPolling(tg: TelegramApi, app: AgentApp): () => void {
  let stopped = false;
  let offset = 0;
  void (async () => {
    log.info('Bật long polling (TG_POLLING=1) — không dùng cùng lúc với bridge');
    while (!stopped) {
      try {
        const updates = await tg.call<TgUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await app.handleUpdate(u);
          } catch (err) {
            log.error(`Xử lý update ${u.update_id} lỗi`, err);
          }
        }
      } catch (err) {
        if (err instanceof TelegramError && err.code === 409) {
          log.error('Bot đang có webhook (bridge đang chạy) → dừng polling. Đặt TG_POLLING=0.');
          return;
        }
        log.warn('getUpdates lỗi, thử lại sau 5s', err);
        await sleep(5000);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
