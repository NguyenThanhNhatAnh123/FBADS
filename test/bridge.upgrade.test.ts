import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeStore } from '../src/bridge/db.ts';
import { loadBridgeConfig } from '../src/bridge/config.ts';
import { buildBridgeApp } from '../src/bridge/server.ts';
import { StagedMedia } from '../src/bridge/media.ts';
import { ReadonlyBilling } from '../src/bridge/billing.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import { JobStore } from '../src/bridge/jobs/store.ts';
import { JobManager } from '../src/bridge/jobs/manager.ts';
import { startFakeTelegram } from './helpers/fakeTelegram.ts';

test('MCP upgrade works in claude mode: stage media, read billing, existing brief routing and approval schemas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-upgrade-'));
  const image = path.join(dir, 'creative.png');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x160', '-frames:v', '1', image], { windowsHide: true });
  const bytes = fs.readFileSync(image);
  const store = new BridgeStore(':memory:');
  const tg = await startFakeTelegram();
  const cfg = loadBridgeConfig({ TG_BOT_TOKEN: 'TEST', TG_WEBHOOK_SECRET: 's'.repeat(32), MCP_TOKEN: 'm'.repeat(40), BRIDGE_KEY: 'b'.repeat(32), TG_ALLOWED_CHAT_IDS: '12345', BRIEF_HANDLER: 'claude', BRIDGE_PUBLIC_URL: 'https://ads.example.com', CLAUDE_DRY_RUN: '1', MEDIA_CACHE_DIR: path.join(dir, 'cache'), FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe' });
  tg.state.webhookUrl = cfg.publicUrl + '/tg/webhook';
  const api = new TelegramApi('TEST', tg.base), limiter = new RateLimiter(1000);
  const media = new StagedMedia(cfg.media!, store.db, { public: { async open() { return { fileName: 'creative.png', mimeType: 'image/png', size: bytes.length, stream: Readable.from([bytes]) }; } } });
  let graphCalls = 0;
  const billing = new ReadonlyBilling({ token: 'read-only-token', apiVersion: 'v26.0' }, (async (url: URL, init: RequestInit) => {
    graphCalls++; assert.equal(init.method, 'GET');
    return Response.json(new URL(url).pathname.endsWith('adspaymentcycle') ? { data: [{ threshold_amount: '50000' }] } : { currency: 'USD', account_status: 1, balance: '4210', amount_spent: '1234500', spend_cap: '0', is_prepay_account: false });
  }) as typeof fetch);
  const jobs = new JobStore(store.db);
  const manager = new JobManager({ cfg: cfg.jobs!, ownerChatId: 12345, jobs, tg: api, limiter, runner: { run: () => new Promise(() => {}), abort() {} }, mcpBase: () => 'http://127.0.0.1', stageMedia: (id, ttl) => media.stage(id, ttl) });
  const app = buildBridgeApp({ cfg, store, tg: api, outbox: new Outbox(api, 12345, limiter), forwarder: new AgentForwarder(cfg, store, async () => {}), jobs: manager, media, billing });
  const http = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const client = new Client({ name: 'upgrade-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + cfg.mcpToken } } }));
  const call = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text }; }
    return { body, error: result.isError };
  };
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'stage_drive_media'));
    assert.ok(!tools.tools.some(t => ['list_briefs', 'record_campaigns', 'list_managed_campaigns'].includes(t.name)));
    const staged = await call('stage_drive_media', { file_id: 'FILE_0123456789', ttl_hours: 6 });
    assert.equal(staged.error, undefined); assert.equal(staged.body.width, 160);
    const publicResponse = await fetch(base + new URL(staged.body.url).pathname, { method: 'HEAD' });
    assert.equal(publicResponse.status, 200);
    const invalid = await call('stage_drive_media', { file_id: 'FILE_0123456789', ttl_hours: 25 });
    assert.equal(invalid.error, true);
    const billed = await call('get_billing_status');
    assert.equal(billed.body.balance_cents, 4210); assert.equal(graphCalls, 2);
    const raw = '#NEW\nTK: H3\nKiểu chạy: Auto\nSản phẩm: Upgrade Check\nLink SP: https://firstnationslegacy.com/products/upgrade-check\nCreative: https://drive.google.com/file/d/FILE_0123456789/view\nQuốc gia: US\nBudget/ngày ($): 5\nNgày chạy: hôm nay';
    const hook = await fetch(base + '/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': cfg.tgWebhookSecret }, body: JSON.stringify({ update_id: 99001, message: { message_id: 101, date: 1, chat: { id: 12345, type: 'private' }, text: raw } }) });
    assert.equal(hook.status, 200);
    assert.equal(jobs.lastJobs(1)[0].raw_text, raw);
    assert.ok(['queued', 'running'].includes(jobs.lastJobs(1)[0].status));
    const status = (await call('get_status')).body;
    assert.equal(status.bot.ok, true); assert.equal(status.webhook.ok, true); assert.equal(status.agent.ok, true);
    assert.equal(status.agent.open_briefs.length, 1); assert.equal(status.agent_queue_pending, 0);
    assert.deepEqual((await call('list_inbox')).body.items, []);
    const handled = await call('mark_handled', { ids: [jobs.lastJobs(1)[0].id] });
    assert.ok(handled.body.invalid_ids.length, 'job ids must not mark inbox/button rows');
    assert.ok(['queued', 'running'].includes(jobs.lastJobs(1)[0].status));
    const approval = await call('send_approval', { ref: 'upgrade-approval', text: 'Chọn phương án', buttons: [{ id: 'approve', label: 'Duyệt' }, { id: 'v1', label: 'Chỉ V1' }, { id: 'v2', label: 'Chỉ V2' }, { id: 'cancel', label: 'Huỷ' }] });
    assert.equal(approval.error, undefined);
    assert.ok(approval.body.message_id);
  } finally {
    manager.stop(); media.close(); await client.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await tg.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing META_READ_TOKEN is an explicit not_configured tool error', async () => {
  const service = new ReadonlyBilling({ token: '', apiVersion: 'v26.0' });
  assert.equal(service.configured, false);
  await assert.rejects(service.read(), /META_READ_TOKEN/);
});
