// Telegram Bot API giả: ghi lại mọi lời gọi, trả message_id tăng dần.

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface TgCall {
  method: string;
  body: Record<string, any>;
}

export interface FakeTelegram {
  base: string;
  calls: TgCall[];
  /** updates: hàng đợi cho getUpdates; conflict: giả lập một tiến trình khác cũng đang getUpdates (409). */
  state: { webhookUrl: string; failParseOnce: boolean; updates: Array<Record<string, any>>; conflict: boolean };
  /** Đưa một update vào hàng đợi getUpdates (update_id do test tự đặt). */
  pushUpdate(u: Record<string, any>): void;
  sent(method?: string): TgCall[];
  lastText(): string;
  /** Tin gửi gần nhất có inline keyboard chứa nút có chữ `label`. */
  findButton(label: RegExp): { data: string; messageId: number } | null;
  close(): Promise<void>;
}

async function readRaw(req: express.Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: TgCall[] = [];
  const results = new Map<TgCall, number>();
  const state = { webhookUrl: '', failParseOnce: false, updates: [] as Array<Record<string, any>>, conflict: false };
  let nextId = 1000;
  const app = express();
  app.use(async (req, res) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
    if (!m) return res.status(404).json({ ok: false });
    const method = m[2];
    const ct = String(req.headers['content-type'] ?? '');
    const raw = await readRaw(req);
    let body: Record<string, any> = {};
    if (ct.includes('application/json')) body = JSON.parse(raw.toString() || '{}');
    else if (ct.includes('multipart/form-data')) {
      const fd = await new Response(new Uint8Array(raw), { headers: { 'content-type': ct } }).formData();
      for (const [k, v] of fd.entries()) body[k] = typeof v === 'string' ? (k === 'reply_markup' ? JSON.parse(v) : v) : `<file ${(v as File).name} ${(v as File).size}B>`;
    }
    const call = { method, body };
    calls.push(call);
    if (method === 'getMe') return res.json({ ok: true, result: { id: 1, is_bot: true, username: 'test_bot' } });
    if (method === 'getWebhookInfo') return res.json({ ok: true, result: { url: state.webhookUrl, pending_update_count: 0 } });
    if (method === 'setWebhook') {
      state.webhookUrl = body.url;
      return res.json({ ok: true, result: true });
    }
    if (method === 'deleteWebhook') {
      state.webhookUrl = '';
      return res.json({ ok: true, result: true });
    }
    if (method === 'getUpdates') {
      const conflict = state.webhookUrl
        ? "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"
        : state.conflict
          ? 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
          : '';
      if (conflict) return res.status(409).json({ ok: false, error_code: 409, description: conflict });
      const offset = Number(body.offset ?? 0);
      state.updates = state.updates.filter((u) => u.update_id >= offset); // offset xác nhận các update cũ
      // Long polling rút gọn: chờ tối đa 100 ms khi chưa có gì, tránh vòng lặp quay rỗng.
      for (let i = 0; i < 10 && !state.updates.length && Number(body.timeout ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 10));
      return res.json({ ok: true, result: [...state.updates] });
    }
    if (method.startsWith('send')) {
      if (state.failParseOnce && body.parse_mode) {
        state.failParseOnce = false;
        return res.status(400).json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity" });
      }
      const id = nextId++;
      results.set(call, id);
      return res.json({ ok: true, result: { message_id: id, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text } });
    }
    return res.json({ ok: true, result: true });
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    state,
    pushUpdate: (u) => void state.updates.push(u),
    sent: (method?: string) => calls.filter((c) => (method ? c.method === method : c.method.startsWith('send'))),
    lastText: () => {
      const c = [...calls].reverse().find((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
      return c?.body.text ?? '';
    },
    findButton(label: RegExp) {
      for (const c of [...calls].reverse()) {
        const kb = c.body.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>> | undefined;
        if (!kb) continue;
        for (const row of kb)
          for (const b of row)
            if (label.test(b.text)) return { data: b.callback_data, messageId: c.method === 'sendMessage' ? results.get(c)! : Number(c.body.message_id) };
      }
      return null;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
