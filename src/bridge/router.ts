// Phân loại update Telegram trong vài mili giây (quy tắc ở mục "Webhook và quy tắc chuyển tin").

import type { TgMessage, TgUpdate } from '../shared/telegram.ts';

export type Route =
  | { to: 'agent'; endpoint: '/brief' | '/callback'; fallbackInbox: boolean; why: string }
  | { to: 'jobs'; what: 'brief' | 'command' | 'button' | 'reply' } // BRIEF_HANDLER=claude: bridge tự xử lý
  | { to: 'buttons'; data: string }
  | { to: 'inbox'; message: TgMessage }
  | { to: 'ignore'; why: string };

export interface ClassifyOptions {
  /** Có khi BRIEF_HANDLER=claude. */
  jobs?: { isEditPrompt: (messageId: number) => boolean };
}

export const AGENT_COMMANDS = /^\/(retry|status|help|start)(@\w+)?(\s|$)/i;
export const BRIEF_PREFIX = /^#(new|add)\b/i;

export function chatIdOf(u: TgUpdate): number | null {
  return u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? u.edited_message?.chat.id ?? null;
}

export function kindOf(u: TgUpdate): string {
  if (u.message) return 'message';
  if (u.callback_query) return 'callback_query';
  if (u.edited_message) return 'edited_message';
  return 'other';
}

export function classify(u: TgUpdate, isClaudeMessage: (messageId: number) => boolean, opts: ClassifyOptions = {}): Route {
  if (opts.jobs) return classifyJobs(u, opts.jobs);
  if (u.callback_query) {
    const data = u.callback_query.data ?? '';
    if (data.startsWith('ag:')) return { to: 'agent', endpoint: '/callback', fallbackInbox: false, why: 'nút ag:' };
    if (data.startsWith('cl:')) return { to: 'buttons', data };
    return { to: 'ignore', why: `callback_data lạ: ${data.slice(0, 20)}` };
  }
  if (u.edited_message) return { to: 'ignore', why: 'tin đã sửa (không xử lý lại brief)' };
  const m = u.message;
  if (!m) return { to: 'ignore', why: 'loại update không dùng' };
  const text = (m.text ?? m.caption ?? '').trimStart();
  if (BRIEF_PREFIX.test(text)) return { to: 'agent', endpoint: '/brief', fallbackInbox: false, why: 'brief' };
  if (AGENT_COMMANDS.test(text)) return { to: 'agent', endpoint: '/brief', fallbackInbox: false, why: 'lệnh Agent' };
  // Trả lời vào tin của bot mà không phải tin Claude gửi → tin của Agent (ví dụ "Sửa gì?").
  // Agent trả handled=false nếu không dùng tới → bridge đưa vào hộp thư Claude.
  const r = m.reply_to_message;
  if (r && r.from?.is_bot && !isClaudeMessage(r.message_id)) return { to: 'agent', endpoint: '/brief', fallbackInbox: true, why: 'trả lời tin Agent' };
  return { to: 'inbox', message: m };
}

/** BRIEF_HANDLER=claude: brief, lệnh, nút bj: và trả lời "Sửa gì?" do bridge xử lý; nút cl: và tin tự do như cũ. */
function classifyJobs(u: TgUpdate, jobs: NonNullable<ClassifyOptions['jobs']>): Route {
  if (u.callback_query) {
    const data = u.callback_query.data ?? '';
    if (data.startsWith('bj:')) return { to: 'jobs', what: 'button' };
    if (data.startsWith('cl:')) return { to: 'buttons', data };
    return { to: 'ignore', why: `callback_data lạ: ${data.slice(0, 20)}` };
  }
  if (u.edited_message) return { to: 'ignore', why: 'tin đã sửa (không xử lý lại brief)' };
  const m = u.message;
  if (!m) return { to: 'ignore', why: 'loại update không dùng' };
  const text = (m.text ?? m.caption ?? '').trimStart();
  if (BRIEF_PREFIX.test(text)) return { to: 'jobs', what: 'brief' };
  if (AGENT_COMMANDS.test(text)) return { to: 'jobs', what: 'command' };
  const r = m.reply_to_message;
  if (r && r.from?.is_bot && jobs.isEditPrompt(r.message_id)) return { to: 'jobs', what: 'reply' };
  return { to: 'inbox', message: m };
}

/** Rút gọn tin thành dòng hộp thư. */
export function inboxFields(m: TgMessage): {
  text: string | null;
  file_id: string | null;
  file_kind: string | null;
  file_name: string | null;
  reply_to: number | null;
  reply_to_text: string | null;
} {
  let file_id: string | null = null;
  let file_kind: string | null = null;
  let file_name: string | null = null;
  if (m.photo?.length) {
    file_id = m.photo[m.photo.length - 1].file_id;
    file_kind = 'photo';
  } else if (m.document) {
    file_id = m.document.file_id;
    file_kind = 'document';
    file_name = m.document.file_name ?? null;
  } else if (m.video) {
    file_id = m.video.file_id;
    file_kind = 'video';
    file_name = m.video.file_name ?? null;
  } else if (m.voice) {
    file_id = m.voice.file_id;
    file_kind = 'voice';
  } else if (m.audio) {
    file_id = m.audio.file_id;
    file_kind = 'audio';
    file_name = m.audio.file_name ?? null;
  }
  const r = m.reply_to_message;
  return {
    text: m.text ?? m.caption ?? null,
    file_id,
    file_kind,
    file_name,
    reply_to: r?.message_id ?? null,
    reply_to_text: r ? (r.text ?? r.caption ?? '').slice(0, 300) || null : null,
  };
}
