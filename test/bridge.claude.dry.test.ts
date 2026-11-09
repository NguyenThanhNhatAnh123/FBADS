// CLAUDE_DRY_RUN=1: chạy thử cả luồng mà không đụng Meta. Lượt claude chỉ có tool ĐỌC; Duyệt / Huỷ chỉ giả lập.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeTelegram, type FakeTelegram } from './helpers/fakeTelegram.ts';
import type { BridgeConfig } from '../src/bridge/config.ts';
import { BridgeStore } from '../src/bridge/db.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import { buildBridgeApp } from '../src/bridge/server.ts';
import { JobStore } from '../src/bridge/jobs/store.ts';
import { JobManager } from '../src/bridge/jobs/manager.ts';
import { ClaudeCliRunner } from '../src/bridge/jobs/runner.ts';
import { defaultAccount, defaultLimits, type ClaudeJobsConfig } from '../src/bridge/jobs/config.ts';
import { allowedToolsFor, disallowedToolsFor } from '../src/bridge/jobs/prompts.ts';

const OWNER = 777002;
const SECRET = 'webhook_secret_0123456789';
const KEY = 'bridge-key-0123456789abcdefghij';
const FAKE = fileURLToPath(new URL('./helpers/fakeClaude.ts', import.meta.url));
const META_WRITE = /ads_creative_upload_media|ads_create_|ads_update_entity|ads_creative_delete|ads_activate_entity/;

let tg: FakeTelegram;
let server: Server;
let base = '';
let store: BridgeStore;
let jobs: JobStore;
let manager: JobManager;
let fakeLog: string;
let seq = 1;

before(async () => {
  tg = await startFakeTelegram();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-claude-dry-'));
  fakeLog = path.join(runDir, 'fake-claude.jsonl');
  process.env.FAKE_CLAUDE_LOG = fakeLog;
  process.env.CLAUDE_CONFIG_DIR = path.join(runDir, 'claude-config');
  const jobsCfg: ClaudeJobsConfig = {
    bin: process.execPath,
    binArgs: [FAKE],
    model: '',
    effort: '',
    timeoutMin: 2,
    maxTurnsCreate: 250,
    maxTurnsOther: 100,
    runDir,
    callbackSecret: KEY,
    account: defaultAccount(),
    limits: defaultLimits(),
    dryRun: true,
  };
  const cfg: BridgeConfig = {
    briefHandler: 'claude',
    jobs: jobsCfg,
    port: 0,
    host: '127.0.0.1',
    publicUrl: '',
    dbFile: ':memory:',
    tgBotToken: 'TEST',
    tgWebhookSecret: SECRET,
    tgAllowedChatIds: [OWNER],
    ownerChatId: OWNER,
    mcpToken: 'mcp-token-0123456789abcdefghijklmnopqrstuv',
    mcpAllowPathToken: false,
    polling: false,
    agentPort: 1,
    agentHost: '127.0.0.1',
    bridgeKey: KEY,
    sendPerMinute: 1000,
    agentRetryEveryS: 0,
    agentNotifyAfterMin: 10,
    agentGiveUpAfterH: 24,
  };
  store = new BridgeStore(':memory:');
  jobs = new JobStore(store.db);
  const api = new TelegramApi('TEST', tg.base);
  const limiter = new RateLimiter(1000);
  manager = new JobManager({ cfg: jobsCfg, ownerChatId: OWNER, jobs, tg: api, limiter, runner: new ClaudeCliRunner(jobsCfg), mcpBase: () => base });
  const app = buildBridgeApp({ cfg, store, tg: api, outbox: new Outbox(api, OWNER, limiter), forwarder: new AgentForwarder(cfg, store, async () => {}), jobs: manager });
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  manager.start(3600_000);
});

after(async () => {
  await manager.idle();
  manager.stop();
  await tg.close();
  await new Promise((r) => server.close(() => r(undefined)));
  store.close();
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.CLAUDE_CONFIG_DIR;
});

const hook = (update: Record<string, unknown>) =>
  fetch(`${base}/tg/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify({ update_id: seq++, ...update }) });
const send = (text: string, extra: Record<string, unknown> = {}) =>
  hook({ message: { message_id: 70_000 + seq, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false }, text, ...extra } });
const press = (data: string, messageId: number) =>
  hook({ callback_query: { id: `cq${seq}`, from: { id: OWNER, is_bot: false }, data, message: { message_id: messageId, date: 0, chat: { id: OWNER, type: 'private' }, text: 'x' } } });
async function waitFor<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor hết giờ');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sentWith = (re: RegExp) => tg.calls.find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && re.test(String(c.body.text ?? '')));
const fakeRuns = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as Array<{ kind: string; job: number; argv: string[] }>;
const lastJobId = () => (jobs.db.prepare('SELECT max(id) id FROM jobs').get() as { id: number }).id;
const brief = (product: string) =>
  `#NEW\nTK: H3\nKiểu chạy: Auto\nSản phẩm: ${product}\nLink SP: https://firstnationslegacy.com/products/car-floor-mats-00\nCreative: https://drive.google.com/file/d/1nCFZsa3GlcIb2_S8NgdWPg7N_Q9v6ace/view\nQuốc gia: US\nBudget/ngày ($): 5`;

test('chạy thử: lượt create chỉ có tool đọc, tin duyệt ghi 🧪 CHẠY THỬ', async () => {
  await send(brief('Dry Mats'));
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const approval = jobs.getJob(id)!.approval_text!;
  assert.match(approval, /🧪 <b>CHẠY THỬ<\/b>/);
  assert.match(approval, /chưa tạo gì trên Meta — ID là giả/);
  const run = fakeRuns().find((r) => r.job === id && r.kind === 'create')!;
  const allowed = run.argv[run.argv.indexOf('--allowedTools') + 1];
  assert.doesNotMatch(allowed, META_WRITE, 'chạy thử không được có tool ghi Meta');
  assert.match(allowed, /mcp__claude_ai_Shopify__search_products/);
  assert.match(run.argv[run.argv.indexOf('--disallowedTools') + 1], /ads_create_campaign/);
});

test('chạy thử: Sửa copy chạy lượt edit thật (chỉ đọc), Duyệt chỉ giả lập — không mở lượt activate', async () => {
  const id = lastJobId();
  const ed = tg.findButton(/Sửa copy/)!;
  await press(ed.data, ed.messageId);
  const askId = await waitFor(() => jobs.getJob(id)!.edit_prompt_message_id);
  await send('nhấn mạnh chống trượt', { reply_to_message: { message_id: askId, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: 1, is_bot: true }, text: 'Sửa gì?' } });
  await waitFor(() => sentWith(/For the Man Who Loves Ravens/));
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const edit = fakeRuns().find((r) => r.job === id && r.kind === 'edit')!;
  assert.doesNotMatch(edit.argv[edit.argv.indexOf('--allowedTools') + 1], META_WRITE);

  const ok = tg.findButton(/Chỉ V1/)!;
  await press(ok.data, ok.messageId);
  const m = await waitFor(() => sentWith(/ĐÃ DUYỆT \(CHẠY THỬ\)/));
  assert.match(String(m.body.text), /không bật gì trên Meta/);
  assert.match(String(m.body.text), /bỏ nháp phương án không chọn/);
  assert.equal(jobs.getJob(id)!.status, 'active');
  await manager.idle();
  assert.ok(!fakeRuns().some((r) => r.job === id && r.kind === 'activate'), 'chạy thử không spawn lượt activate');
});

test('chạy thử: Huỷ chỉ giả lập; job chạy thử không bị tính là camp đang chạy', async () => {
  await send(brief('Dry Mats Two'));
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  assert.deepEqual(manager.managedActiveCampaignIds(id), [], 'camp giả không được đưa vào kiểm tra trần ngân sách');
  const cx = tg.findButton(/Huỷ/)!;
  await press(cx.data, cx.messageId);
  await waitFor(() => sentWith(/ĐÃ HUỶ \(CHẠY THỬ\)/));
  assert.equal(jobs.getJob(id)!.status, 'cancelled');
  await manager.idle();
  assert.ok(!fakeRuns().some((r) => r.job === id && r.kind === 'cancel'));
});

test('danh sách tool chạy thử: không có tool ghi Meta ở mọi loại lượt', () => {
  for (const k of ['create', 'edit', 'activate', 'cancel'] as const) {
    assert.ok(!allowedToolsFor(k, true).some((t) => META_WRITE.test(t)), k);
    assert.ok(disallowedToolsFor(k, true).some((t) => t.endsWith('ads_activate_entity')), k);
  }
});
