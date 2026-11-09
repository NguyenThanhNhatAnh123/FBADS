// Chuyển brief / lần bấm nút sang Agent trên localhost.
// Agent không chạy (lỗi kết nối) → giữ trong agent_queue, thử lại mỗi 30 giây; sau 10 phút báo
// "Agent không phản hồi" lên Telegram (một lần), tiếp tục thử cho tới khi Agent sống lại (tối đa 24 giờ).

import type { BridgeConfig } from './config.ts';
import type { BridgeStore, QueueRow } from './db.ts';
import type { TgUpdate } from '../shared/telegram.ts';
import { inboxFields } from './router.ts';
import { logger } from '../shared/log.ts';

const log = logger('forwarder');

export interface Notifier {
  (text: string): Promise<unknown>;
}

export class AgentForwarder {
  private readonly cfg: BridgeConfig;
  private readonly store: BridgeStore;
  private readonly notify: Notifier;
  private loop: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(cfg: BridgeConfig, store: BridgeStore, notify: Notifier, now: () => number = Date.now) {
    this.cfg = cfg;
    this.store = store;
    this.notify = notify;
    this.now = now;
  }

  get agentBase(): string {
    return `http://${this.cfg.agentHost}:${this.cfg.agentPort}`;
  }

  enqueue(update: TgUpdate, endpoint: '/brief' | '/callback', fallbackInbox: boolean): number {
    const id = this.store.enqueueAgent(update.update_id ?? null, endpoint, update, fallbackInbox, new Date(this.now()).toISOString());
    void this.kick();
    return id;
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.kick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Chạy vòng chuyển tin; gọi trong lúc đang chạy thì vòng hiện tại chạy thêm một lượt.
   * Promise trả về xong khi hàng đợi rỗng hoặc mục đầu phải chờ tới lượt thử lại.
   */
  kick(): Promise<void> {
    if (this.loop) {
      this.again = true;
      return this.loop;
    }
    this.loop = (async () => {
      try {
        do {
          this.again = false;
          await this.drain();
        } while (this.again);
      } finally {
        this.loop = null;
      }
    })();
    return this.loop;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const head = this.store.headOfQueue();
      if (!head) return;
      if (new Date(head.next_at).getTime() > this.now()) return; // giữ thứ tự: chờ mục đầu
      const ok = await this.deliver(head);
      if (!ok) return;
    }
  }

  private async deliver(row: QueueRow): Promise<boolean> {
    const nowMs = this.now();
    let res: Response;
    try {
      res = await fetch(`${this.agentBase}${row.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-key': this.cfg.bridgeKey },
        body: row.payload,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      await this.retryLater(row, `Không kết nối được Agent: ${(err as Error).message}`, nowMs);
      return false;
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { handled?: boolean };
      this.store.updateQueue(row.id, { delivered_at: new Date(nowMs).toISOString(), tries: row.tries + 1, last_error: null });
      if (body.handled === false && row.fallback_inbox) {
        const u = JSON.parse(row.payload) as TgUpdate;
        if (u.message) this.store.addInbox({ message_id: u.message.message_id, chat_id: u.message.chat.id, ...inboxFields(u.message) });
        if (u.update_id) this.store.setRouted(u.update_id, 'inbox', 'Agent không dùng tin này');
      }
      if (row.notified_at) await this.notify(`✅ Agent đã phản hồi lại, đã chuyển tin chờ (mục #${row.id}).`).catch(() => {});
      return true;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      this.store.updateQueue(row.id, { failed_at: new Date(nowMs).toISOString(), last_error: '401 từ Agent: BRIDGE_KEY hai bên không khớp' });
      await this.notify('🔴 Bridge không chuyển được tin sang Agent: BRIDGE_KEY ở .env.bridge và .env.agent không khớp.').catch(() => {});
      return true;
    }
    if (res.status >= 500 || res.status === 429) {
      await this.retryLater(row, `Agent trả ${res.status}: ${text.slice(0, 200)}`, nowMs);
      return false;
    }
    // 4xx khác: lỗi dữ liệu, không thử lại.
    this.store.updateQueue(row.id, { failed_at: new Date(nowMs).toISOString(), last_error: `Agent trả ${res.status}: ${text.slice(0, 200)}` });
    log.error(`Agent từ chối mục #${row.id} (${res.status})`, text.slice(0, 200));
    return true;
  }

  private async retryLater(row: QueueRow, error: string, nowMs: number): Promise<void> {
    const ageMs = nowMs - new Date(row.created_at).getTime();
    const patch: Partial<QueueRow> = {
      tries: row.tries + 1,
      last_error: error,
      next_at: new Date(nowMs + this.cfg.agentRetryEveryS * 1000).toISOString(),
    };
    if (ageMs >= this.cfg.agentGiveUpAfterH * 3600_000) {
      patch.failed_at = new Date(nowMs).toISOString();
      this.store.updateQueue(row.id, patch);
      await this.notify(`🔴 Agent không phản hồi quá ${this.cfg.agentGiveUpAfterH} giờ — bỏ mục #${row.id}. Gửi lại brief khi Agent chạy lại.`).catch(() => {});
      return;
    }
    if (!row.notified_at && ageMs >= this.cfg.agentNotifyAfterMin * 60_000) {
      patch.notified_at = new Date(nowMs).toISOString();
      const what = row.endpoint === '/brief' ? 'brief' : 'lần bấm nút';
      await this.notify(
        `⚠ Agent không phản hồi (${this.cfg.agentNotifyAfterMin} phút). Bridge đang giữ ${this.store.pendingQueueCount()} ${what} trong hàng đợi và sẽ chuyển ngay khi Agent chạy lại.\nLỗi: ${error}`,
      ).catch(() => {});
    }
    this.store.updateQueue(row.id, patch);
    log.warn(`Mục #${row.id}: ${error} — thử lại sau ${this.cfg.agentRetryEveryS}s`);
  }

  async agentHealth(): Promise<{ ok: boolean; halted?: boolean; queue?: number; error?: string }> {
    try {
      const res = await fetch(`${this.agentBase}/health`, { headers: { 'x-bridge-key': this.cfg.bridgeKey }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const j = (await res.json()) as { halted?: boolean; queue?: number };
      return { ok: true, halted: j.halted, queue: j.queue };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async agentBilling(): Promise<unknown> {
    const res = await fetch(`${this.agentBase}/billing`, { headers: { 'x-bridge-key': this.cfg.bridgeKey }, signal: AbortSignal.timeout(30_000) });
    const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    return j;
  }
}
