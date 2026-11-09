// Client Telegram Bot API tối giản, dùng chung cho Agent (gửi tin) và bridge (nhận + gửi tin).
// Agent và bridge dùng cùng một bot token; chỉ bridge nhận update (webhook).

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.ts';

const log = logger('telegram');

// ---- Kiểu dữ liệu Telegram (chỉ phần cần dùng) ----
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  video?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string };
  audio?: { file_id: string; file_name?: string };
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}
export interface ForceReply {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}
export type ReplyMarkup = InlineKeyboard | ForceReply;

export type ParseMode = 'HTML' | 'Markdown' | 'MarkdownV2';

export interface SendOpts {
  parse_mode?: ParseMode;
  reply_markup?: ReplyMarkup;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  disable_preview?: boolean;
}

export class TelegramError extends Error {
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram ${method} lỗi ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
  /** Lỗi do Markdown/HTML sai cú pháp — gửi lại dạng văn bản thường được. */
  get isParseError(): boolean {
    return this.code === 400 && /can't parse entities|can't find end of the entity|unsupported start tag/i.test(this.description);
  }
  get isNotModified(): boolean {
    return this.code === 400 && /message is not modified/i.test(this.description);
  }
}

export type FileInput =
  | { kind: 'buffer'; filename: string; data: Buffer; contentType?: string }
  | { kind: 'path'; filePath: string; filename?: string }
  | { kind: 'url'; url: string }
  | { kind: 'file_id'; fileId: string };

export class TelegramApi {
  private readonly base: string;

  constructor(token: string, apiBase = process.env.TG_API_BASE || 'https://api.telegram.org') {
    this.base = `${apiBase.replace(/\/$/, '')}/bot${token}`;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body[k] = v;
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        return this.call<T>(method, params, attempt + 1);
      }
      throw err;
    }
    return this.handle<T>(method, res, () => this.call<T>(method, params, attempt + 1), attempt);
  }

  private async callForm<T>(method: string, form: () => Promise<FormData>, attempt = 0): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      body: await form(),
      signal: AbortSignal.timeout(180_000),
    });
    return this.handle<T>(method, res, () => this.callForm<T>(method, form, attempt + 1), attempt);
  }

  private async handle<T>(method: string, res: Response, retry: () => Promise<T>, attempt: number): Promise<T> {
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (json.ok) return json.result as T;
    const code = json.error_code ?? res.status;
    const retryAfter = json.parameters?.retry_after;
    if (code === 429 && retryAfter && attempt < 2) {
      log.warn(`429 từ Telegram (${method}), chờ ${retryAfter}s`);
      await sleep(retryAfter * 1000 + 250);
      return retry();
    }
    if (code >= 500 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return retry();
    }
    throw new TelegramError(method, code, json.description ?? res.statusText, retryAfter);
  }

  // ---- Các hàm tiện dụng ----

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  sendMessage(chatId: number | string, text: string, opts: SendOpts = {}): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode,
      reply_markup: opts.reply_markup,
      disable_notification: opts.disable_notification,
      reply_parameters: opts.reply_to_message_id
        ? { message_id: opts.reply_to_message_id, allow_sending_without_reply: true }
        : undefined,
      link_preview_options: opts.disable_preview ? { is_disabled: true } : undefined,
    });
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: { parse_mode?: ParseMode; reply_markup?: InlineKeyboard; disable_preview?: boolean } = {},
  ): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: opts.parse_mode,
        reply_markup: opts.reply_markup ?? { inline_keyboard: [] },
        link_preview_options: opts.disable_preview ? { is_disabled: true } : undefined,
      });
    } catch (err) {
      if (err instanceof TelegramError && err.isNotModified) return;
      throw err;
    }
  }

  async editMessageReplyMarkup(chatId: number | string, messageId: number, markup?: InlineKeyboard): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: markup ?? { inline_keyboard: [] },
      });
    } catch (err) {
      if (err instanceof TelegramError && err.isNotModified) return;
      throw err;
    }
  }

  async answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<void> {
    try {
      await this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
    } catch (err) {
      // Callback quá hạn (>15 phút) thì Telegram trả 400 — không ảnh hưởng xử lý.
      log.warn('answerCallbackQuery thất bại', err);
    }
  }

  getWebhookInfo(): Promise<{ url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number }> {
    return this.call('getWebhookInfo');
  }

  setWebhook(url: string, secretToken: string): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 10,
    });
  }

  /** Gửi file kèm caption. method: sendDocument | sendPhoto | sendVideo. */
  sendFile(
    method: 'sendDocument' | 'sendPhoto' | 'sendVideo',
    chatId: number | string,
    file: FileInput,
    opts: { caption?: string; parse_mode?: ParseMode; disable_notification?: boolean; reply_markup?: ReplyMarkup } = {},
  ): Promise<TgMessage> {
    const field = method === 'sendDocument' ? 'document' : method === 'sendPhoto' ? 'photo' : 'video';
    if (file.kind === 'url' || file.kind === 'file_id') {
      return this.call<TgMessage>(method, {
        chat_id: chatId,
        [field]: file.kind === 'url' ? file.url : file.fileId,
        caption: opts.caption,
        parse_mode: opts.parse_mode,
        disable_notification: opts.disable_notification,
        reply_markup: opts.reply_markup,
      });
    }
    return this.callForm<TgMessage>(method, async () => {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      if (opts.caption) form.set('caption', opts.caption);
      if (opts.parse_mode) form.set('parse_mode', opts.parse_mode);
      if (opts.disable_notification) form.set('disable_notification', 'true');
      if (opts.reply_markup) form.set('reply_markup', JSON.stringify(opts.reply_markup));
      if (file.kind === 'buffer') {
        form.set(field, new Blob([new Uint8Array(file.data)], { type: file.contentType ?? 'application/octet-stream' }), file.filename);
      } else {
        const blob = await fs.openAsBlob(file.filePath);
        form.set(field, blob, file.filename ?? path.basename(file.filePath));
      }
      return form;
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape cho parse_mode HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Chia văn bản dài thành nhiều đoạn ≤ limit, ưu tiên cắt ở xuống dòng. */
export function chunkText(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}
