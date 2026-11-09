// Server MCP (Streamable HTTP, không giữ phiên) cho custom connector trên claude.ai.
// 7 tool + get_billing_status; mọi tool chỉ làm việc với đúng một chat của chủ shop — không tool nào nhận chat_id.
// Cố ý KHÔNG có: tool tạo/bật/tắt quảng cáo, gửi tới chat khác, đọc lịch sử chat cũ, đọc file trên server.

import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeStore } from './db.ts';
import type { Outbox } from './outbox.ts';
import type { AgentForwarder } from './forwarder.ts';
import type { TelegramApi } from '../shared/telegram.ts';
import { TelegramError } from '../shared/telegram.ts';
import { toTelegramMarkdown } from './outbox.ts';
import type { BridgeConfig } from './config.ts';
import type { PollingState } from './polling.ts';

export interface McpDeps {
  cfg: BridgeConfig;
  store: BridgeStore;
  outbox: Outbox;
  tg: TelegramApi;
  forwarder: AgentForwarder;
  polling?: PollingState; // chỉ có khi BRIDGE_POLLING=1
  jobs?: { summary(): Record<string, unknown> }; // BRIEF_HANDLER=claude
}

/** Polling coi là ổn khi bot không có webhook và getUpdates vừa thành công (mỗi vòng ≤ 25s). */
const POLL_STALE_MS = 90_000;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** "m12" → inbox 12; "b3" → button press 3. Số trần không chấp nhận để tránh nhầm hai bảng. */
export function parseItemId(id: string | number): { table: 'inbox' | 'press'; n: number } | null {
  const m = /^([mb])(\d+)$/.exec(String(id).trim());
  if (!m) return null;
  return { table: m[1] === 'm' ? 'inbox' : 'press', n: Number(m[2]) };
}

function sinceNumber(v: string | number | undefined, prefix: 'm' | 'b'): number {
  if (v === undefined || v === null || v === '') return 0;
  const s = String(v).trim();
  const m = new RegExp(`^${prefix}?(\\d+)$`).exec(s);
  return m ? Number(m[1]) : 0;
}

export function buildMcpServer(d: McpDeps): McpServer {
  const server = new McpServer({ name: 'telegram-bridge', version: '1.0.0' });

  const logged = async (tool: string, bytes: number, fn: () => Promise<{ result: ToolResult; messageId?: number | null }>): Promise<ToolResult> => {
    try {
      const { result, messageId } = await fn();
      d.store.log(tool, bytes, messageId ?? null, result.isError ? result.content[0]?.text : undefined);
      return result;
    } catch (err) {
      const msg = err instanceof TelegramError ? err.message : (err as Error).message;
      d.store.log(tool, bytes, null, msg);
      return fail(msg);
    }
  };

  server.registerTool(
    'send_message',
    {
      title: 'Gửi tin Telegram',
      description:
        'Gửi một tin văn bản lên chat Telegram của chủ shop. Hỗ trợ Markdown kiểu Telegram (*đậm*, _nghiêng_, `code`, [chữ](link)); ' +
        '**đậm** và tiêu đề # được tự chuyển. Tin dài hơn 4.096 ký tự được tự chia thành nhiều tin. Markdown sai cú pháp thì gửi dạng chữ thường. ' +
        'Truyền dedupe_key để không gửi lặp: nếu đã có tin cùng khoá trong dedupe_hours giờ gần đây thì bỏ qua và trả skipped=true.',
      inputSchema: {
        text: z.string().min(1).max(40_000).describe('Nội dung tin'),
        silent: z.boolean().optional().describe('true = gửi không kèm thông báo âm thanh'),
        dedupe_key: z.string().min(1).max(120).optional().describe('Khoá chống gửi lặp, ví dụ "billing-H3-80"'),
        dedupe_hours: z.number().min(0.1).max(24 * 31).optional().describe('Cửa sổ chống lặp tính bằng giờ (mặc định 24)'),
      },
    },
    async ({ text, silent, dedupe_key, dedupe_hours }) =>
      logged('send_message', Buffer.byteLength(text), async () => {
        if (dedupe_key) {
          const prev = d.store.findDedupe(dedupe_key, dedupe_hours ?? 24);
          if (prev) return { result: ok({ skipped: true, reason: 'đã gửi tin cùng dedupe_key', previous_message_id: prev.message_id, previous_at: prev.at }) };
        }
        const r = await d.outbox.sendText(text, { silent });
        d.store.addOutgoing(r.ids, 'send_message');
        if (dedupe_key) d.store.saveDedupe(dedupe_key, r.ids[0]);
        return { result: ok({ message_id: r.ids[0], message_ids: r.ids, parts: r.ids.length, parse_mode: r.parseMode ?? 'plain' }), messageId: r.ids[0] };
      }),
  );

  server.registerTool(
    'send_file',
    {
      title: 'Gửi file Telegram',
      description:
        'Gửi một file (CSV, PNG biểu đồ, PDF báo cáo...) lên chat của chủ shop. Truyền nội dung base64 (tối đa 10 MB) hoặc một URL công khai. ' +
        'Không đọc được file trên server. Ảnh PNG/JPG được gửi dạng ảnh xem trực tiếp.',
      inputSchema: {
        filename: z.string().min(1).max(200).describe('Tên file kèm đuôi, ví dụ ads_2026-11-07.csv'),
        content_base64: z.string().optional().describe('Nội dung file mã hoá base64'),
        url: z.string().url().optional().describe('URL công khai (http/https) của file'),
        caption: z.string().max(4000).optional().describe('Chú thích kèm file'),
      },
    },
    async ({ filename, content_base64, url, caption }) => {
      const bytes = content_base64 ? Math.floor((content_base64.length * 3) / 4) : 0;
      return logged('send_file', bytes, async () => {
        if (!!content_base64 === !!url) return { result: fail('Truyền đúng một trong hai: content_base64 hoặc url') };
        const name = path.basename(filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';
        const ext = path.extname(name).toLowerCase();
        const method = IMAGE_EXT.has(ext) ? 'sendPhoto' : 'sendDocument';
        const longCaption = caption && caption.length > 1024;
        const cap = caption && !longCaption ? toTelegramMarkdown(caption) : undefined;

        let file: Parameters<TelegramApi['sendFile']>[2];
        if (content_base64) {
          const data = Buffer.from(content_base64.replace(/\s/g, ''), 'base64');
          if (!data.length) return { result: fail('content_base64 rỗng hoặc sai') };
          if (data.length > MAX_FILE_BYTES) return { result: fail(`File ${data.length} byte vượt giới hạn 10 MB`) };
          file = { kind: 'buffer', filename: name, data, contentType: mimeFor(ext) };
        } else {
          const u = new URL(url!);
          if (!['http:', 'https:'].includes(u.protocol)) return { result: fail('Chỉ nhận URL http/https') };
          file = { kind: 'url', url: u.toString() };
        }

        await d.outbox.limiter.take();
        let msg;
        try {
          msg = await d.tg.sendFile(method, d.cfg.ownerChatId, file, { caption: cap, parse_mode: cap ? 'Markdown' : undefined });
        } catch (err) {
          if (err instanceof TelegramError && err.isParseError && cap) {
            msg = await d.tg.sendFile(method, d.cfg.ownerChatId, file, { caption: caption!.slice(0, 1024) });
          } else if (err instanceof TelegramError && method === 'sendPhoto') {
            msg = await d.tg.sendFile('sendDocument', d.cfg.ownerChatId, file, { caption: caption?.slice(0, 1024) });
          } else throw err;
        }
        const ids = [msg.message_id];
        if (longCaption) {
          const r = await d.outbox.sendText(caption!, {});
          ids.push(...r.ids);
        }
        d.store.addOutgoing(ids, 'send_file');
        return { result: ok({ message_id: msg.message_id }), messageId: msg.message_id };
      });
    },
  );

  server.registerTool(
    'send_approval',
    {
      title: 'Gửi tin có nút',
      description:
        'Gửi tin có tối đa 4 nút bấm (ví dụ đề xuất tắt ad / tăng budget). `ref` là mã việc do Claude đặt để nhận lại lần bấm. ' +
        'Chủ shop bấm một lần; lần bấm được lưu và đọc bằng list_button_presses ở lượt chạy sau. Tool này không tự thực hiện thay đổi nào trên quảng cáo.',
      inputSchema: {
        text: z.string().min(1).max(4000),
        ref: z.string().min(1).max(64).describe('Mã việc, ví dụ "scale-2026-11-07-ad123"'),
        buttons: z
          .array(z.object({ id: z.string().min(1).max(32), label: z.string().min(1).max(64) }))
          .min(1)
          .max(4),
      },
    },
    async ({ text, ref, buttons }) =>
      logged('send_approval', Buffer.byteLength(text), async () => {
        const ids = new Set(buttons.map((b) => b.id));
        if (ids.size !== buttons.length) return { result: fail('id của các nút phải khác nhau') };
        const approvalId = d.store.addApproval(ref, text, 'Markdown', buttons);
        const kb = buttons.map((b, i) => ({ text: b.label, callback_data: `cl:${approvalId}:${i}` }));
        const rows = kb.length <= 2 ? [kb] : [kb.slice(0, 2), kb.slice(2)];
        const r = await d.outbox.sendText(text, { replyMarkup: { inline_keyboard: rows } });
        const messageId = r.ids[r.ids.length - 1];
        d.store.setApprovalMessage(approvalId, messageId, r.parseMode);
        d.store.addOutgoing(r.ids, 'send_approval');
        return { result: ok({ message_id: messageId, approval_id: approvalId, ref }), messageId };
      }),
  );

  server.registerTool(
    'list_inbox',
    {
      title: 'Đọc hộp thư',
      description:
        'Danh sách tin tự do chủ shop gõ trên Telegram (không phải brief #NEW/#ADD) chưa được xử lý. ' +
        'Mỗi mục có id dạng "m12"; xử lý xong thì gọi mark_handled để lượt sau không đọc lại. Chỉ đọc.',
      inputSchema: {
        since_id: z.union([z.string(), z.number()]).optional().describe('Chỉ lấy mục sau id này, ví dụ "m12"'),
        limit: z.number().int().min(1).max(100).optional().describe('Mặc định 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since_id, limit }) =>
      logged('list_inbox', 0, async () => {
        const n = limit ?? 20;
        const rows = d.store.listInbox(sinceNumber(since_id, 'm'), n + 1);
        const items = rows.slice(0, n).map((r) => ({
          id: `m${r.id}`,
          text: r.text ?? '',
          at: r.at,
          ...(r.reply_to ? { reply_to: { message_id: r.reply_to, text: r.reply_to_text ?? '' } } : {}),
          ...(r.file_id ? { file: { kind: r.file_kind, name: r.file_name } } : {}),
        }));
        return { result: ok({ items, more: rows.length > n }) };
      }),
  );

  server.registerTool(
    'list_button_presses',
    {
      title: 'Đọc lần bấm nút',
      description: 'Danh sách lần bấm nút (của tin gửi bằng send_approval) chưa được xử lý. Lọc theo ref nếu cần. Mỗi mục có id dạng "b3". Chỉ đọc.',
      inputSchema: {
        ref: z.string().max(64).optional(),
        since_id: z.union([z.string(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, since_id }) =>
      logged('list_button_presses', 0, async () => {
        const rows = d.store.listPresses(ref ?? null, sinceNumber(since_id, 'b'));
        return { result: ok({ items: rows.map((r) => ({ id: `b${r.id}`, ref: r.ref, button_id: r.button_id, label: r.label, at: r.at })) }) };
      }),
  );

  server.registerTool(
    'mark_handled',
    {
      title: 'Đánh dấu đã xử lý',
      description: 'Đánh dấu tin hộp thư ("m12") hoặc lần bấm nút ("b3") đã xử lý để lượt sau không đọc lại.',
      inputSchema: { ids: z.array(z.union([z.string(), z.number()])).min(1).max(200) },
    },
    async ({ ids }) =>
      logged('mark_handled', 0, async () => {
        const inbox: number[] = [];
        const press: number[] = [];
        const bad: string[] = [];
        for (const raw of ids) {
          const p = parseItemId(raw);
          if (!p) bad.push(String(raw));
          else (p.table === 'inbox' ? inbox : press).push(p.n);
        }
        const marked = d.store.markHandled(inbox, press);
        return { result: ok({ marked, ...(bad.length ? { invalid_ids: bad, hint: 'id phải dạng "m12" hoặc "b3"' } : {}) }) };
      }),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Tình trạng bridge',
      description:
        'Bot còn sống, bridge đang nhận được tin Telegram (webhook đặt đúng, hoặc polling khi test local), Agent có phản hồi, số tin / lần bấm chưa xử lý, số mục đang chờ chuyển Agent. Chỉ đọc.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      logged('get_status', 0, async () => {
        const expected = d.cfg.publicUrl ? `${d.cfg.publicUrl}/tg/webhook` : null;
        const [me, wh, agent] = await Promise.allSettled([
          d.tg.getMe(),
          d.tg.getWebhookInfo(),
          d.jobs ? Promise.resolve(d.jobs.summary()) : d.forwarder.agentHealth(),
        ]);
        const bot = me.status === 'fulfilled' ? { ok: true, username: me.value.username } : { ok: false, error: String((me as PromiseRejectedResult).reason) };
        const p = d.polling;
        const webhook =
          wh.status !== 'fulfilled'
            ? { ok: false, mode: p ? 'polling' : 'webhook', error: String((wh as PromiseRejectedResult).reason) }
            : p
              ? {
                  // Test local: không được có webhook, và vòng getUpdates phải vừa chạy được.
                  ok: !wh.value.url && p.running && !!p.lastOkAt && Date.now() - Date.parse(p.lastOkAt) < POLL_STALE_MS,
                  mode: 'polling',
                  url: wh.value.url || null,
                  last_poll_ok_at: p.lastOkAt,
                  updates_received: p.updates,
                  last_error: p.lastError,
                }
              : {
                  ok: !!wh.value.url && (!expected || wh.value.url === expected),
                  mode: 'webhook',
                  url: wh.value.url || null,
                  expected,
                  pending_update_count: wh.value.pending_update_count,
                  last_error: wh.value.last_error_message ?? null,
                };
        const ag = agent.status === 'fulfilled' ? agent.value : { ok: false, error: String((agent as PromiseRejectedResult).reason) };
        return {
          result: ok({
            bot,
            webhook,
            agent: ag,
            inbox_unhandled: d.store.countUnhandledInbox(),
            button_presses_unhandled: d.store.countUnhandledPresses(),
            agent_queue_pending: d.store.pendingQueueCount(),
          }),
        };
      }),
  );

  server.registerTool(
    'get_billing_status',
    {
      title: 'Số dư và ngưỡng thanh toán',
      description:
        'Đọc số dư (balance), đã chi, spend cap và chu kỳ ngưỡng thanh toán của tài khoản quảng cáo H3 qua Agent (Graph API). ' +
        'Dùng cho cảnh báo sắp chạm ngưỡng khi connector Facebook Ads không trả các số này. Tiền theo cent của đơn vị tiền tệ tài khoản. Chỉ đọc.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      logged('get_billing_status', 0, async () =>
        d.jobs
          ? { result: fail('Bridge đang chạy BRIEF_HANDLER=claude (không có Agent dùng token Meta): đọc số dư và ngưỡng thanh toán bằng connector Facebook Ads.') }
          : { result: ok(await d.forwarder.agentBilling()) },
      ),
  );

  return server;
}

function mimeFor(ext: string): string {
  return (
    {
      '.csv': 'text/csv',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.pdf': 'application/pdf',
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }[ext] ?? 'application/octet-stream'
  );
}
