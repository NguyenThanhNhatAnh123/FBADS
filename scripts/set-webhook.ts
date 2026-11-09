// Đặt webhook Telegram trỏ vào bridge: npm run set-webhook
// Cần TG_BOT_TOKEN, TG_WEBHOOK_SECRET, BRIDGE_PUBLIC_URL trong .env.bridge.

import { TelegramApi } from '../src/shared/telegram.ts';

const token = process.env.TG_BOT_TOKEN;
const secret = process.env.TG_WEBHOOK_SECRET;
const base = process.env.BRIDGE_PUBLIC_URL?.replace(/\/$/, '');
if (!token || !secret || !base) {
  console.error('Thiếu TG_BOT_TOKEN, TG_WEBHOOK_SECRET hoặc BRIDGE_PUBLIC_URL');
  process.exit(1);
}
const tg = new TelegramApi(token);
const url = `${base}/tg/webhook`;
await tg.setWebhook(url, secret);
const info = await tg.getWebhookInfo();
console.log('setWebhook OK →', info.url);
console.log('pending_update_count:', info.pending_update_count, info.last_error_message ? `· lỗi gần nhất: ${info.last_error_message}` : '');

// Thử request giả không có secret_token → phải bị 401.
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"update_id":1}' });
console.log(`Request giả không có secret_token → HTTP ${res.status} ${res.status === 401 ? '✓' : '✗ (phải là 401)'}`);
