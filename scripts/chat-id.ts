// Tìm chat_id để điền TG_ALLOWED_CHAT_IDS: nhắn một tin bất kỳ cho bot, rồi chạy  npm run chat-id
// Chưa đặt webhook → đọc getUpdates (không xoá tin chờ). Đã đặt webhook → đọc các chat bridge đã ghi nhận.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { TelegramApi, TelegramError, type TgUpdate } from '../src/shared/telegram.ts';

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.error('Thiếu TG_BOT_TOKEN trong .env.bridge');
  process.exit(1);
}
const tg = new TelegramApi(token);
const me = await tg.call<{ username: string }>('getMe');
console.log(`Bot: @${me.username}\n`);

const allowed = (process.env.TG_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const mark = (id: number | string) => (allowed.includes(String(id)) ? '  ✓ đã có trong TG_ALLOWED_CHAT_IDS' : '');

try {
  const updates = await tg.call<TgUpdate[]>('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const seen = new Map<number, string>();
  for (const u of updates) {
    const m = u.message ?? u.edited_message;
    if (!m) continue;
    const c = m.chat as { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
    const who = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '');
    seen.set(c.id, `${c.type} · ${who}${c.username ? ` (@${c.username})` : ''} · "${(m.text ?? '').slice(0, 40)}"`);
  }
  if (!seen.size) {
    console.log(`Chưa thấy tin nào. Mở Telegram, nhắn "hi" cho @${me.username}, rồi chạy lại lệnh này.`);
  } else {
    console.log('Các chat đã nhắn cho bot:');
    for (const [id, desc] of seen) console.log(`  ${id}   ${desc}${mark(id)}`);
    console.log('\nĐiền id của chủ shop vào TG_ALLOWED_CHAT_IDS trong CẢ .env.bridge và .env.agent.');
  }
} catch (err) {
  if (!(err instanceof TelegramError && err.code === 409)) throw err;
  // Webhook đang đặt → Telegram không cho getUpdates; xem các chat bridge đã nhận.
  const dbFile = process.env.BRIDGE_DB || 'data/bridge.db';
  console.log('Webhook đang đặt nên không đọc getUpdates được — xem các chat bridge đã nhận:');
  if (!fs.existsSync(dbFile)) {
    console.log(`  (chưa có ${dbFile} — chạy bridge, nhắn "hi" cho bot, rồi chạy lại)`);
    process.exit(0);
  }
  const db = new Database(dbFile, { readonly: true });
  const rows = db
    .prepare(`SELECT chat_id, COUNT(*) AS n, MAX(at) AS last FROM updates WHERE chat_id IS NOT NULL GROUP BY chat_id ORDER BY last DESC`)
    .all() as Array<{ chat_id: number; n: number; last: string }>;
  if (!rows.length) console.log(`  (chưa có tin nào — nhắn "hi" cho @${me.username} rồi chạy lại)`);
  for (const r of rows) console.log(`  ${r.chat_id}   ${r.n} tin, gần nhất ${r.last}${mark(r.chat_id)}`);
  db.close();
}
