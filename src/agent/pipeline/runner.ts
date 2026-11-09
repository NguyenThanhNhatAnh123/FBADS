// Chạy các bước của một brief theo thứ tự, ghi `step` vào DB trước/sau mỗi bước.
// Một hàng đợi tuần tự: brief chạy lần lượt để giới hạn budget không bị vượt do chạy song song.

import type { Deps, RequestContext, StepEnv } from './types.ts';
import { StopError, WaitError } from './types.ts';
import { STEPS, STATUS_AFTER, stepsFor, type StepName } from './steps.ts';
import { TERMINAL } from '../db.ts';
import { MetaApiError, MetaTokenError } from '../meta/graph.ts';
import { DriveAccessError } from '../drive.ts';
import { CopyRulesError } from '../copy/writer.ts';
import { deleteOwnedObjects, errText } from '../approval.ts';
import { escapeHtml } from '../../shared/telegram.ts';
import { logger } from '../../shared/log.ts';

const log = logger('runner');

const STEP_LABEL: Record<StepName, string> = {
  resolve_campaign: 'tìm campaign',
  product: 'lấy dữ liệu sản phẩm',
  media: 'tải creative từ Drive',
  copy: 'viết copy',
  upload: 'tải media lên Meta',
  creatives: 'tạo creative / Post ID',
  reuse_posts: 'dùng lại Post ID',
  campaign: 'tạo campaign',
  adset: 'tạo adset',
  ads: 'tạo ad',
  previews: 'lấy preview',
  approval: 'gửi tin duyệt',
};

export class Runner {
  private readonly deps: Deps;
  private chain: Promise<void> = Promise.resolve();
  private pending = new Set<number>();
  /** Khác null khi token Meta hỏng: mọi brief dừng cho tới khi /retry hoặc khởi động lại. */
  halted: string | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  get queueSize(): number {
    return this.pending.size;
  }

  isQueued(id: number): boolean {
    return this.pending.has(id);
  }

  /** Đưa brief vào hàng đợi; trả về promise xong khi brief chạy xong (để test chờ được). */
  enqueue(requestId: number, opts: { resumed?: boolean } = {}): Promise<void> {
    if (this.pending.has(requestId)) return this.chain;
    this.pending.add(requestId);
    const job = this.chain.then(async () => {
      try {
        await this.run(requestId, !!opts.resumed);
      } catch (err) {
        log.error(`Brief #${requestId} lỗi ngoài dự kiến`, err);
      } finally {
        this.pending.delete(requestId);
      }
    });
    this.chain = job;
    return job;
  }

  /** Chờ hàng đợi chạy hết (dùng khi tắt server / trong test). */
  idle(): Promise<void> {
    return this.chain;
  }

  private env(requestId: number): StepEnv {
    const { store } = this.deps;
    const env: StepEnv = {
      deps: this.deps,
      req: store.getRequest(requestId)!,
      ctx: store.getContext<RequestContext>(requestId),
      reload() {
        env.req = store.getRequest(requestId)!;
        env.ctx = store.getContext<RequestContext>(requestId);
      },
      patch(p) {
        store.patchContext(requestId, p as Record<string, unknown>);
        env.ctx = store.getContext<RequestContext>(requestId);
      },
      warn(msg) {
        const w = [...(env.ctx.warnings ?? [])];
        if (!w.includes(msg)) w.push(msg);
        env.patch({ warnings: w });
      },
    };
    return env;
  }

  private async run(requestId: number, resumed: boolean): Promise<void> {
    const { store } = this.deps;
    const req = store.getRequest(requestId);
    if (!req || TERMINAL.includes(req.status) || req.status === 'waiting' || req.status === 'pending_approval') return;
    const ctx = store.getContext<RequestContext>(requestId);
    if (!ctx.brief) {
      store.updateRequest(requestId, { status: 'failed', error: 'Thiếu brief đã đọc' });
      return;
    }
    const steps = stepsFor(ctx.brief);
    let i = req.step ? Math.max(0, steps.indexOf(req.step as StepName)) : 0;
    store.patchContext(requestId, { resumed });
    log.info(`Brief #${requestId}: chạy từ bước ${steps[i]}${resumed ? ' (chạy tiếp sau khởi động lại)' : ''}`);

    let current: StepName = steps[i];
    try {
      for (; i < steps.length; i++) {
        current = steps[i];
        if (this.halted) throw new WaitError('token', this.halted);
        store.updateRequest(requestId, { step: current });
        const env = this.env(requestId);
        await STEPS[current](env);
        const status = STATUS_AFTER[current];
        store.updateRequest(requestId, { step: steps[i + 1] ?? 'done', ...(status ? { status } : {}) });
        if (resumed) {
          store.patchContext(requestId, { resumed: false });
          resumed = false;
        }
      }
      log.info(`Brief #${requestId}: xong, chờ duyệt`);
    } catch (err) {
      await this.fail(requestId, current, err);
    }
  }

  private async fail(requestId: number, step: StepName, err: unknown): Promise<void> {
    const { store, tg } = this.deps;
    const req = store.getRequest(requestId)!;
    const chatId = req.chat_id!;
    const send = (html: string) => tg.sendMessage(chatId, html, { parse_mode: 'HTML', disable_preview: true }).catch((e) => log.error('Không gửi được tin báo lỗi', e));

    // 1) Chờ chủ shop: không dọn gì.
    if (err instanceof WaitError || err instanceof DriveAccessError) {
      const reason = err instanceof WaitError ? err.reason : 'drive';
      store.updateRequest(requestId, { status: 'waiting', step, error: (err as Error).message });
      store.patchContext(requestId, { waitingReason: reason, failedStep: step });
      store.audit('agent', 'request_waiting', { requestId, detail: { reason, step, message: (err as Error).message } });
      if (reason === 'drive') {
        await send(
          `📂 Brief #${requestId}: không truy cập được link Drive.\n` +
            `Share file/thư mục creative cho <code>${escapeHtml(this.deps.drive.serviceAccountEmail)}</code> quyền <b>Người xem</b>, rồi gõ <code>/retry ${requestId}</code>.`,
        );
      }
      return;
    }

    // 2) Token Meta hỏng: dừng mọi brief, cảnh báo đỏ.
    if (err instanceof MetaTokenError) {
      const first = !this.halted;
      this.halted = err.ownerText;
      store.updateRequest(requestId, { status: 'waiting', step, error: err.message });
      store.patchContext(requestId, { waitingReason: 'token', failedStep: step });
      store.audit('system', 'meta_token_invalid', { requestId, detail: err.body });
      if (first) {
        await send(
          `🔴🔴 <b>TOKEN META HẾT HẠN HOẶC BỊ THU HỒI</b>\nAgent đã dừng mọi brief.\n\n${escapeHtml(err.ownerText)}\n\n` +
            `Cập nhật <code>META_TOKEN</code> trong .env.agent, khởi động lại Agent (pm2 restart agent), rồi gõ <code>/retry ${requestId}</code>.`,
        );
      }
      return;
    }

    // 3) Lỗi khác: dừng brief, dọn object vừa tạo, báo lỗi gốc.
    let detail: string;
    if (err instanceof MetaApiError) detail = err.ownerText;
    else if (err instanceof CopyRulesError) detail = `Copy vẫn vi phạm quy tắc sau 3 lần viết:\n${err.issues.map((s) => `• ${s}`).join('\n')}`;
    else detail = (err as Error)?.message ?? String(err);
    if (!(err instanceof StopError)) log.error(`Brief #${requestId} lỗi ở bước ${step}`, err);

    let cleanupNote = '';
    const owned = store.listMetaObjects(requestId).filter((o) => o.owned && o.level !== 'creative');
    if (owned.length) {
      const errors = await deleteOwnedObjects(this.deps, requestId, true);
      cleanupNote = errors.length
        ? `\n\n⚠ Đã cố xoá object vừa tạo nhưng còn sót:\n${errors.map((e) => `• ${escapeHtml(e)}`).join('\n')}`
        : `\n\nĐã xoá ${owned.length} object (campaign/adset/ad) vừa tạo của brief này.`;
    }
    // Object do brief tạo đã xoá → lần /retry phải tạo lại từ bước đó.
    const ctx = store.getContext<RequestContext>(requestId);
    const steps = stepsFor(ctx.brief!);
    let retryIdx = steps.indexOf(step);
    const clear: Record<string, unknown> = { failedStep: step };
    if (ctx.campaign?.owned) {
      clear.campaign = undefined;
      retryIdx = Math.min(retryIdx, steps.indexOf('campaign'));
    }
    if (ctx.adset?.owned) {
      clear.adset = undefined;
      retryIdx = Math.min(retryIdx, steps.indexOf('adset'));
    }
    store.patchContext(requestId, clear);
    store.updateRequest(requestId, { status: 'failed', step: steps[Math.max(0, retryIdx)], error: detail });
    store.audit('agent', 'request_failed', { requestId, detail: { step, error: detail } });
    await send(
      `🔴 Brief #${requestId} lỗi ở bước <b>${STEP_LABEL[step]}</b>:\n<pre>${escapeHtml(detail.slice(0, 2500))}</pre>${cleanupNote}\n\n` +
        `Sửa nguyên nhân rồi gõ <code>/retry ${requestId}</code> để chạy lại từ bước hỏng (không tạo trùng bài trên Page).`,
    );
  }
}

export function errorSummary(err: unknown): string {
  return errText(err);
}
