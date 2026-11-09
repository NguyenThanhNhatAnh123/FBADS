// Checklist nghiệm thu MCP Telegram bridge, với Telegram + Agent giả và MCP client thật.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFakeTelegram, type FakeTelegram } from './helpers/fakeTelegram.ts';
import type { BridgeConfig } from '../src/bridge/config.ts';
import { BridgeStore } from '../src/bridge/db.ts';
import { TelegramApi, type TgUpdate } from '../src/shared/telegram.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import { buildBridgeApp } from '../src/bridge/server.ts';

const OWNER = 777001;
const SECRET = 'webhook_secret_0123456789';
const MCP_TOKEN = 'mcp-token-0123456789abcdefghijklmnopqrstuv';
const KEY = 'bridge-key-0123456789abcdefghij';

// ---- Agent giả ----
let agentHits: Array<{ path: string; body: TgUpdate; key: string }> = [];
let agentHandled = true;
let agentServer: Server | null = null;
let agentPort = 0;
const agentApp = express();
agentApp.use(express.json());
agentApp.post(['/brief', '/callback'], (req, res) => {
  agentHits.push({ path: req.path, body: req.body, key: String(req.header('x-bridge-key')) });
  res.json({ ok: true, handled: agentHandled });
});
agentApp.get('/health', (_req, res) => res.json({ ok: true, halted: false, queue: 0 }));
agentApp.get('/billing', (_req, res) => res.json({ ok: true, account: { balance: '41000' }, payment_cycle: { threshold_amount: 50000 } }));
function agentUp(port = 0): Promise<void> {
  return new Promise((r) => {
    agentServer = agentApp.listen(port, '127.0.0.1', () => {
      agentPort = (agentServer!.address() as AddressInfo).port;
      r();
    });
  });
}
function agentDown(): Promise<void> {
  return new Promise((r) => (agentServer ? agentServer.close(() => r()) : r()));
}

let tg: FakeTelegram;
let bridgeServer: Server;
let base: string;
let store: BridgeStore;
let forwarder: AgentForwarder;
let offset = 0; // dời đồng hồ của forwarder để giả lập thời gian trôi
let cfg: BridgeConfig;
let seq = 1;

before(async () => {
  await agentUp();
  tg = await startFakeTelegram();
  cfg = {
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'https://bridge.example.com',
    dbFile: ':memory:',
    tgBotToken: 'TEST',
    tgWebhookSecret: SECRET,
    tgAllowedChatIds: [OWNER],
    ownerChatId: OWNER,
    mcpToken: MCP_TOKEN,
    mcpAllowPathToken: false,
    polling: false,
    agentPort,
    agentHost: '127.0.0.1',
    bridgeKey: KEY,
    sendPerMinute: 1000,
    agentRetryEveryS: 0,
    agentNotifyAfterMin: 10,
    agentGiveUpAfterH: 24,
  };
  store = new BridgeStore(':memory:');
  const api = new TelegramApi('TEST', tg.base);
  const outbox = new Outbox(api, OWNER, new RateLimiter(cfg.sendPerMinute));
  forwarder = new AgentForwarder(cfg, store, (t) => outbox.sendText(t, { markdown: false }), () => Date.now() + offset);
  const app = buildBridgeApp({ cfg, store, tg: api, outbox, forwarder });
  bridgeServer = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
  tg.state.webhookUrl = 'https://bridge.example.com/tg/webhook';
});

after(async () => {
  await agentDown();
  await tg.close();
  await new Promise((r) => bridgeServer.close(() => r(undefined)));
  store.close();
});

beforeEach(() => {
  agentHits = [];
  agentHandled = true;
});

function hook(update: Record<string, unknown>, secret = SECRET) {
  return fetch(`${base}/tg/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify({ update_id: seq++, ...update }),
  });
}
const msg = (text: string, extra: Record<string, unknown> = {}, chatId = OWNER) => ({
  message: { message_id: 5000 + seq, date: 0, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, text, ...extra },
});

async function mcp(token = MCP_TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...JSON.parse(r.content[0].text), _isError: !!r.isError };
}
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

test('webhook thiếu / sai secret_token → 401', async () => {
  assert.equal((await hook(msg('hi'), '')).status, 401);
  assert.equal((await hook(msg('hi'), 'wrong_secret_0123456789')).status, 401);
  assert.equal((await hook(msg('hi'))).status, 200);
});

test('#NEW → Agent nhận trong 2 giây, kèm X-Bridge-Key', async () => {
  const t0 = Date.now();
  await hook(msg('#NEW\nTK: H3'));
  assert.ok(await waitFor(() => agentHits.length === 1));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(agentHits[0].path, '/brief');
  assert.equal(agentHits[0].key, KEY);
  assert.match(agentHits[0].body.message!.text!, /^#NEW/);
});

test('nút ag: và lệnh /retry, /status → Agent', async () => {
  await hook({ callback_query: { id: 'q1', from: { id: OWNER, is_bot: false }, data: 'ag:1:ok:1:abcdefghijkl', message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' } } } });
  await hook(msg('/retry 3'));
  await hook(msg('/status'));
  assert.ok(await waitFor(() => agentHits.length === 3));
  assert.deepEqual(agentHits.map((h) => h.path), ['/callback', '/brief', '/brief']);
});

test('Tắt Agent, gửi #NEW → bridge giữ trong agent_queue; sau 10 phút báo; bật lại thì brief được chuyển', async () => {
  await agentDown();
  await hook(msg('#NEW\nTK: H3\nSản phẩm: queued'));
  await forwarder.kick();
  assert.equal(store.pendingQueueCount(), 1);
  assert.equal(agentHits.length, 0);
  const sentBefore = tg.sent('sendMessage').length;
  offset += 11 * 60_000;
  await forwarder.kick();
  const notice = tg.sent('sendMessage').slice(sentBefore).find((m) => /Agent không phản hồi/.test(m.body.text));
  assert.ok(notice, 'có tin "Agent không phản hồi"');
  assert.equal(notice!.body.chat_id, OWNER);
  await agentUp(agentPort);
  await forwarder.kick();
  assert.equal(store.pendingQueueCount(), 0);
  assert.equal(agentHits.length, 1);
  assert.match(agentHits[0].body.message!.text!, /queued/);
});

test('get_status: bot, webhook, Agent đều ổn', async () => {
  const c = await mcp();
  const s = await call(c, 'get_status');
  assert.equal(s.bot.ok, true);
  assert.equal(s.webhook.ok, true);
  assert.equal(s.agent.ok, true);
  assert.equal(typeof s.inbox_unhandled, 'number');
  const tools = await c.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    'get_billing_status',
    'get_status',
    'list_button_presses',
    'list_inbox',
    'mark_handled',
    'send_approval',
    'send_file',
    'send_message',
    'stage_drive_media',
  ]);
  await c.close();
});

test('send_message: đúng chat, tự chia tin > 4.096 ký tự, Markdown hỏng thì gửi chữ thường', async () => {
  const c = await mcp();
  const n0 = tg.sent('sendMessage').length;
  const r = await call(c, 'send_message', { text: '**Báo cáo ngày**\nROAS 2.1' });
  assert.equal(typeof r.message_id, 'number');
  const m = tg.sent('sendMessage')[n0];
  assert.equal(m.body.chat_id, OWNER);
  assert.equal(m.body.text, '*Báo cáo ngày*\nROAS 2.1');
  assert.equal(m.body.parse_mode, 'Markdown');

  const long = Array.from({ length: 200 }, (_, i) => `Dòng ${i}: ${'x'.repeat(40)}`).join('\n');
  const r2 = await call(c, 'send_message', { text: long });
  assert.ok(r2.parts >= 2);

  tg.state.failParseOnce = true;
  const r3 = await call(c, 'send_message', { text: 'ad_name_with_underscore *lẻ' });
  assert.equal(r3.parse_mode, 'plain');
  assert.equal(r3._isError, false);
  await c.close();
});

test('send_message với dedupe_key: mốc cảnh báo chỉ gửi một lần trong cửa sổ', async () => {
  const c = await mcp();
  const a = await call(c, 'send_message', { text: '⚠ H3 đã dùng 82% ngưỡng thanh toán', dedupe_key: 'billing-H3-80', dedupe_hours: 12 });
  assert.equal(typeof a.message_id, 'number');
  const n = tg.sent('sendMessage').length;
  const b = await call(c, 'send_message', { text: '⚠ H3 đã dùng 85% ngưỡng thanh toán', dedupe_key: 'billing-H3-80', dedupe_hours: 12 });
  assert.equal(b.skipped, true);
  assert.equal(tg.sent('sendMessage').length, n, 'không gửi thêm');
  const c90 = await call(c, 'send_message', { text: '⚠ H3 đã dùng 91%', dedupe_key: 'billing-H3-90', dedupe_hours: 12 });
  assert.equal(typeof c90.message_id, 'number');
  await c.close();
});

test('send_file: CSV 1 MB về đúng chat; không nhận cả base64 lẫn url', async () => {
  const c = await mcp();
  const csv = Buffer.alloc(1024 * 1024, 'a,b,c\n').toString('base64');
  const r = await call(c, 'send_file', { filename: '../../etc/ads.csv', content_base64: csv, caption: 'Chi tiết ad' });
  assert.equal(typeof r.message_id, 'number');
  const d = tg.sent('sendDocument').pop()!;
  assert.equal(Number(d.body.chat_id), OWNER);
  assert.match(d.body.document, /<file ads\.csv 1048576B>/);
  const bad = await call(c, 'send_file', { filename: 'x.csv', content_base64: 'YQ==', url: 'https://example.com/x.csv' });
  assert.equal(bad._isError, true);
  await c.close();
});

test('send_approval 2 nút, bấm 1 nút → list_button_presses đúng ref, button_id; mark_handled xong không trả lại', async () => {
  const c = await mcp();
  const r = await call(c, 'send_approval', {
    text: 'Đề xuất tăng budget 20% cho camp Raven?',
    ref: 'scale-raven-0711',
    buttons: [
      { id: 'yes', label: 'Tăng 20%' },
      { id: 'no', label: 'Giữ nguyên' },
    ],
  });
  const kb = tg.sent('sendMessage').pop()!.body.reply_markup.inline_keyboard;
  assert.equal(kb[0].length, 2);
  const data = kb[0][0].callback_data;
  assert.match(data, /^cl:\d+:0$/);
  const press = () =>
    hook({ callback_query: { id: 'qq', from: { id: OWNER, is_bot: false }, data, message: { message_id: r.message_id, date: 0, chat: { id: OWNER, type: 'private' }, text: 'Đề xuất' } } });
  await press();
  assert.ok(tg.calls.some((x) => x.method === 'answerCallbackQuery' && /Claude sẽ xử lý ở lượt chạy kế tiếp/.test(x.body.text)));
  await press(); // bấm lần 2 không ghi thêm
  const list = await call(c, 'list_button_presses', { ref: 'scale-raven-0711' });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].button_id, 'yes');
  assert.equal(list.items[0].ref, 'scale-raven-0711');
  const mk = await call(c, 'mark_handled', { ids: [list.items[0].id] });
  assert.equal(mk.marked, 1);
  assert.equal((await call(c, 'list_button_presses', { ref: 'scale-raven-0711' })).items.length, 0);
  await c.close();
});

test('Câu tự do trên Telegram → xuất hiện trong list_inbox; trả lời tin Claude → inbox kèm reply_to', async () => {
  const c = await mcp();
  await hook(msg('gửi bảng camp Raven lên tele giúp mình'));
  const sent = await call(c, 'send_message', { text: 'Báo cáo ngày 07/11' });
  await hook(msg('camp B sao lỗ vậy?', { reply_to_message: { message_id: sent.message_id, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: 1, is_bot: true }, text: 'Báo cáo ngày 07/11' } }));
  const inbox = await call(c, 'list_inbox', {});
  const texts = inbox.items.map((i: { text: string }) => i.text);
  assert.ok(texts.includes('gửi bảng camp Raven lên tele giúp mình'));
  const reply = inbox.items.find((i: { text: string }) => i.text === 'camp B sao lỗ vậy?');
  assert.equal(reply.reply_to.text, 'Báo cáo ngày 07/11');
  assert.equal(agentHits.length, 0, 'không chuyển Agent');
  await call(c, 'mark_handled', { ids: inbox.items.map((i: { id: string }) => i.id) });
  assert.equal((await call(c, 'list_inbox', {})).items.length, 0);
  await c.close();
});

test('Trả lời tin của Agent → chuyển Agent; Agent không dùng (handled=false) → vào hộp thư', async () => {
  agentHandled = false;
  await hook(msg('ok cảm ơn', { reply_to_message: { message_id: 42, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: 1, is_bot: true }, text: '📥 Đã nhận brief #3' } }));
  assert.ok(await waitFor(() => agentHits.length === 1));
  const c = await mcp();
  assert.ok(await waitFor(() => store.countUnhandledInbox() === 1));
  const inbox = await call(c, 'list_inbox', {});
  assert.equal(inbox.items[0].text, 'ok cảm ơn');
  await call(c, 'mark_handled', { ids: [inbox.items[0].id] });
  await c.close();
});

test('/mcp sai token → 401; tin từ tài khoản Telegram khác → bỏ qua, có log; update trùng → bỏ qua', async () => {
  await assert.rejects(() => mcp('wrong-token-0123456789abcdefghijklmnopqrstu'));
  const raw = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 401);

  const res = await hook(msg('#NEW từ người lạ', {}, 123456));
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(agentHits.length, 0);
  const row = store.db.prepare(`SELECT * FROM updates WHERE chat_id=123456`).get() as { routed_to: string; note: string };
  assert.equal(row.routed_to, 'ignored');

  const dupId = seq++;
  const body = JSON.stringify({ update_id: dupId, ...msg('#NEW dup') });
  const post = () => fetch(`${base}/tg/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body });
  await post();
  await post();
  assert.ok(await waitFor(() => agentHits.length >= 1));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(agentHits.length, 1, 'Telegram gửi lại cùng update → chỉ chuyển một lần');
});

test('get_billing_status đọc qua Agent; mỗi lần gọi tool có dòng bridge_log', async () => {
  const c = await mcp();
  const b = await call(c, 'get_billing_status');
  assert.equal(b.payment_cycle.threshold_amount, 50000);
  await c.close();
  const n = (store.db.prepare(`SELECT count(*) n FROM bridge_log`).get() as { n: number }).n;
  assert.ok(n > 5);
  const last = store.db.prepare(`SELECT * FROM bridge_log ORDER BY id DESC LIMIT 1`).get() as { tool: string };
  assert.equal(last.tool, 'get_billing_status');
});
