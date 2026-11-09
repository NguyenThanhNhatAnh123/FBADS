// Gửi tin lên Telegram cho các tool MCP: tối đa 30 tin/phút (vượt thì xếp hàng),
// tự chia tin dài hơn 4.096 ký tự, Markdown sai cú pháp thì gửi lại dạng chữ thường.

import { chunkText, TelegramError, type InlineKeyboard, type TelegramApi, type TgMessage, sleep } from '../shared/telegram.ts';

export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(perMinute: number, now: () => number = Date.now, wait: (ms: number) => Promise<void> = sleep) {
    this.perMinute = perMinute;
    this.now = now;
    this.wait = wait;
  }

  /** Chờ tới lượt; các lời gọi được xếp hàng theo thứ tự. */
  take(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        this.stamps = this.stamps.filter((s) => t - s < 60_000);
        if (this.stamps.length < this.perMinute) {
          this.stamps.push(t);
          return;
        }
        await this.wait(60_000 - (t - this.stamps[0]) + 5);
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

/**
 * Chuyển Markdown kiểu thường gặp (**đậm**, # tiêu đề) sang Markdown của Telegram (legacy):
 * *đậm*, _nghiêng_, `code`, ```khối```, [chữ](link).
 */
export function toTelegramMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ');
}

export class Outbox {
  private readonly tg: TelegramApi;
  private readonly chatId: number;
  readonly limiter: RateLimiter;

  constructor(tg: TelegramApi, chatId: number, limiter: RateLimiter) {
    this.tg = tg;
    this.chatId = chatId;
    this.limiter = limiter;
  }

  /** Gửi văn bản (tự chia đoạn). Trả về message_id của từng đoạn. */
  async sendText(text: string, o: { silent?: boolean; replyMarkup?: InlineKeyboard; markdown?: boolean } = {}): Promise<{ ids: number[]; parseMode: 'Markdown' | null }> {
    const md = o.markdown !== false;
    const prepared = md ? toTelegramMarkdown(text) : text;
    const parts = chunkText(prepared, 4096);
    const ids: number[] = [];
    let mode: 'Markdown' | null = md ? 'Markdown' : null;
    for (const [i, part] of parts.entries()) {
      await this.limiter.take();
      const markup = i === parts.length - 1 ? o.replyMarkup : undefined;
      let msg: TgMessage;
      try {
        msg = await this.tg.sendMessage(this.chatId, part, {
          parse_mode: mode ?? undefined,
          disable_notification: o.silent,
          reply_markup: markup,
          disable_preview: true,
        });
      } catch (err) {
        if (!(err instanceof TelegramError && err.isParseError) || !mode) throw err;
        // Markdown hỏng → gửi lại đúng đoạn đó dạng chữ thường.
        mode = null;
        msg = await this.tg.sendMessage(this.chatId, md ? stripMd(part) : part, {
          disable_notification: o.silent,
          reply_markup: markup,
          disable_preview: true,
        });
      }
      ids.push(msg.message_id);
    }
    return { ids, parseMode: mode };
  }
}

function stripMd(s: string): string {
  return s.replace(/[*_`]/g, '');
}
