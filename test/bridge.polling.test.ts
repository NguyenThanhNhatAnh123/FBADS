// BRIDGE_POLLING=1 (test local, không cần tunnel): bridge tự getUpdates, xử lý giống hệt webhook.

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
import { buildBridgeApp, type BridgeDeps } from '../src/bridge/server.ts';
import { newPollingState, startBridgePolling } from '../src/bridge/polling.ts';

const OWNER = 777001;
const MCP_TOKEN = 'mcp-token-0123456789abcdefghijklmnopqrstuv';
const KEY = 'bridge-key-0123456789abcdefghij';
const FAST = { timeoutS: 1, errorDelayMs: 20, conflictDelayMs: 20 };

let agentHits: Array<{ path: string; body: TgUpdate }> = [];
const agentApp = express();
agentApp.use(express.json());
agentApp.post(['/brief', '/callback'], (req, res) => {
  agentHits.push({ path: req.path, body: req.body });
  res.json({ ok: true, handled: true });
});
agentApp.get('/health', (_req, res) => res.json({ ok: true, halted: false, queue: 0 }));

let agentServer: Server;
let bridgeServer: Server;
let base: string;
let tg: FakeTelegram;
let store: BridgeStore;
let deps: BridgeDeps;
let stop: (() => Promise<void>) | null = null;

const listen0 = (app: express.Express): Promise<Server> => new Promise((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const close = (s: Server) => new Promise((r) => s.close(() => r(undefined)));
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return cond();
};
const update = (update_id: number, text: string) => ({
  update_id,
  message: { message_id: 9000 + update_id, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false }, text },
});
async function status() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  const r = (await client.callTool({ name: 'get_status', arguments: {} })) as { content: Array<{ text: string }> };
  await client.close();
  return JSON.parse(r.content[0].text);
}
async function inbox() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  const r = (await client.callTool({ name: 'list_inbox', arguments: {} })) as { content: Array<{ text: string }> };
  await client.close();
  return JSON.parse(r.content[0].text).items as Array<{ text: string }>;
}

before(async () => {
  agentServer = await listen0(agentApp);
  tg = await startFakeTelegram();
  const cfg: BridgeConfig = {
    port: 0,
    host: '127.0.0.1',
    publicUrl: '',
    dbFile: ':memory:',
    tgBotToken: 'TEST',
    tgWebhookSecret: 'webhook_secret_0123456789',
    tgAllowedChatIds: [OWNER],
    ownerChatId: OWNER,
    mcpToken: MCP_TOKEN,
    mcpAllowPathToken: false,
    polling: true,
    agentPort: (agentServer.address() as AddressInfo).port,
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
  const forwarder = new AgentForwarder(cfg, store, (t) => outbox.sendText(t, { markdown: false }));
  deps = { cfg, store, tg: api, outbox, forwarder, polling: newPollingState() };
  bridgeServer = await listen0(buildBridgeApp(deps));
  base = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
});

beforeEach(() => {
  agentHits = [];
});

after(async () => {
  await stop?.();
  await close(bridgeServer);
  await close(agentServer);
  await tg.close();
  store.close();
});

test('tự gỡ webhook; #NEW → Agent, câu tự do → list_inbox; khởi động lại nhận lại update cũ thì không xử lý hai lần', async () => {
  tg.state.webhookUrl = 'https://ads.example.com/tg/webhook';
  stop = startBridgePolling(deps, deps.polling!, FAST);
  assert.ok(await waitFor(() => tg.calls.some((c) => c.method === 'deleteWebhook')), 'phải gọi deleteWebhook');
  assert.equal(tg.state.webhookUrl, '');

  tg.pushUpdate(update(1, '#NEW\nTK: H3'));
  tg.pushUpdate(update(2, 'gửi bảng camp Raven lên tele giúp mình'));
  assert.ok(await waitFor(() => agentHits.length === 1), 'brief phải tới Agent');
  assert.equal(agentHits[0].path, '/brief');
  assert.match(agentHits[0].body.message!.text!, /^#NEW/);
  assert.ok(await waitFor(() => store.countUnhandledInbox() === 1));
  assert.deepEqual((await inbox()).map((i) => i.text), ['gửi bảng camp Raven lên tele giúp mình']);
  // Lần getUpdates sau xác nhận đã nhận đến update 2.
  assert.ok(await waitFor(() => tg.calls.some((c) => c.method === 'getUpdates' && c.body.offset === 3)));

  // Khởi động lại (offset về 0) trước khi Telegram kịp xoá → nhận lại update 1: phải bỏ qua.
  await stop();
  tg.pushUpdate(update(1, '#NEW\nTK: H3'));
  const before = deps.polling!.updates;
  stop = startBridgePolling(deps, deps.polling!, FAST);
  assert.ok(await waitFor(() => deps.polling!.updates > before));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agentHits.length, 1, 'update trùng không được chuyển Agent lần nữa');

  const s = await status();
  assert.equal(s.webhook.mode, 'polling');
  assert.equal(s.webhook.ok, true);
  assert.equal(s.webhook.url, null);
  await stop();
  stop = null;
});

test('409 vì tiến trình khác cũng getUpdates → không dừng, get_status báo lỗi; hết xung đột thì nhận tiếp', async () => {
  tg.state.conflict = true;
  deps.polling!.lastOkAt = null;
  stop = startBridgePolling(deps, deps.polling!, FAST);
  assert.ok(await waitFor(() => /409/.test(deps.polling!.lastError ?? '')));
  const bad = await status();
  assert.equal(bad.webhook.ok, false);
  assert.match(bad.webhook.last_error, /Conflict/);

  tg.state.conflict = false;
  tg.pushUpdate(update(10, '#ADD\nTK: H3'));
  assert.ok(await waitFor(() => agentHits.length === 1), 'hết 409 thì phải nhận tiếp');
  const good = await status();
  assert.equal(good.webhook.ok, true);
  assert.equal(good.webhook.last_error, null);
  await stop();
  stop = null;
});
