// Trang quản lý /ui: chỉ localhost, cần token, đổi chế độ chạy thử / chạy thật có xác nhận và báo Telegram.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeTelegram, type FakeTelegram } from './helpers/fakeTelegram.ts';
import type { BridgeConfig } from '../src/bridge/config.ts';
import { BridgeStore } from '../src/bridge/db.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import { buildBridgeApp } from '../src/bridge/server.ts';
import { JobStore } from '../src/bridge/jobs/store.ts';
import { JobManager } from '../src/bridge/jobs/manager.ts';
import { defaultAccount, defaultLimits, type ClaudeJobsConfig } from '../src/bridge/jobs/config.ts';
import { parseConnectors, setEnvValue } from '../src/bridge/ui/routes.ts';
import { parseBrief } from '../src/agent/brief/parse.ts';
import http from 'node:http';

const OWNER = 777003;
let tg: FakeTelegram;
let server: Server;
let base = '';
let store: BridgeStore;
let jobs: JobStore;
let envFile: string;
let jobsCfg: ClaudeJobsConfig;
let token = '';
let doctorCalls: boolean[] = [];

before(async () => {
  tg = await startFakeTelegram();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-ui-'));
  envFile = path.join(dir, '.env.bridge');
  fs.writeFileSync(envFile, 'TG_BOT_TOKEN=x\r\nCLAUDE_DRY_RUN=1\r\nBRIDGE_POLLING=1\r\n');
  jobsCfg = { bin: 'claude', binArgs: [], model: '', effort: '', timeoutMin: 1, maxTurnsCreate: 10, maxTurnsOther: 10, runDir: dir, callbackSecret: 'k'.repeat(30), account: defaultAccount(), limits: defaultLimits(), dryRun: true };
  const cfg = { briefHandler: 'claude', jobs: jobsCfg, port: 0, host: '127.0.0.1', publicUrl: '', dbFile: ':memory:', tgBotToken: 'TEST', tgWebhookSecret: 'w'.repeat(20), tgAllowedChatIds: [OWNER], ownerChatId: OWNER, mcpToken: 'm'.repeat(40), mcpAllowPathToken: false, polling: false, agentPort: 1, agentHost: '127.0.0.1', bridgeKey: 'k'.repeat(30), sendPerMinute: 1000, agentRetryEveryS: 0, agentNotifyAfterMin: 10, agentGiveUpAfterH: 24 } as BridgeConfig;
  store = new BridgeStore(':memory:');
  jobs = new JobStore(store.db);
  const api = new TelegramApi('TEST', tg.base);
  const limiter = new RateLimiter(1000);
  const manager = new JobManager({ cfg: jobsCfg, ownerChatId: OWNER, jobs, tg: api, limiter, runner: { run: () => new Promise(() => {}), abort() {} } /* lượt chạy treo: brief đứng ở trạng thái đang chạy */, mcpBase: () => base });
  const raw = '#NEW\nTK: H3\nKiểu chạy: Auto\nSản phẩm: UI Test\nLink SP: https://firstnationslegacy.com/products/ui-test\nCreative: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view\nQuốc gia: US\nBudget/ngày ($): 5';
  const brief = parseBrief(raw, { accountNames: ['H3'], pageId: '101065259399535', shopDomain: 'firstnationslegacy.com', timezone: 'America/Dawson' }).brief!;
  const id = jobs.createJob({ type: 'NEW', raw_text: raw, brief_json: JSON.stringify(brief), warnings: [], budget_usd: 5, status: 'failed', error: 'lỗi thử' });
  jobs.queueRun(id, 'create', {});
  jobs.updateRun(1, { status: 'failed', outcome: 'failure', audit_json: JSON.stringify({ found: true, writes: ['shopify productUpdate'], anomalies: ['Shopify mutation ngoài phạm vi: productUpdate'] }) });
  const app = buildBridgeApp({
    cfg,
    store,
    tg: api,
    outbox: new Outbox(api, OWNER, limiter),
    forwarder: new AgentForwarder(cfg, store, async () => {}),
    jobs: manager,
    ui: {
      envFile,
      claudeMcpList: async () => 'claude.ai Facebook Ads: https://mcp.facebook.com/ads - ✔ Connected\nclaude.ai Shopify: https://setup.shopify.com/mcp - ✔ Connected\nclaude.ai Google Drive: x - ! Needs authentication',
      runDoctor: async (live) => {
        doctorCalls.push(live);
        return { code: 0, output: '✅ Máy sẵn sàng.' };
      },
    },
  });
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const html = await (await fetch(`${base}/ui`)).text();
  token = /const TOKEN = '([^']+)'/.exec(html)![1];
});

after(async () => {
  await tg.close();
  await new Promise((r) => server.close(() => r(undefined)));
  store.close();
});

const api = (p: string, init: RequestInit = {}, tok = token) =>
  fetch(`${base}/ui/api${p}`, { ...init, headers: { 'content-type': 'application/json', ...(tok ? { 'x-ui-token': tok } : {}), ...((init.headers as Record<string, string>) ?? {}) } });

test('/ui trả trang có token; API thiếu token → 401; qua proxy / Host lạ → 403', async () => {
  assert.ok(token.length >= 20);
  assert.equal((await api('/status', {}, '')).status, 401);
  assert.equal((await api('/status', { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
  assert.equal((await fetch(`${base}/ui`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403);
  // fetch không cho đặt Host → dùng http.get (giả DNS rebinding: tên miền lạ trỏ về 127.0.0.1)
  const evil = await new Promise<number>((resolve) => {
    const u = new URL(`${base}/ui/api/status`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example.com', 'x-ui-token': token } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
  });
  assert.equal(evil, 403);
  assert.equal((await api('/dry-run', { method: 'POST', body: '{"on":true}', headers: { origin: 'https://evil.example.com' } })).status, 403);
});

test('status: chế độ, connector (từ claude mcp list), bot, số brief', async () => {
  await api('/claude/refresh', { method: 'POST', body: '{}' });
  const s = (await (await api('/status')).json()) as any;
  assert.equal(s.dry_run, true);
  assert.equal(s.bot.ok, true);
  assert.deepEqual(s.claude.connectors.items.map((x: any) => [x.name, x.ok]), [['Facebook Ads', true], ['Shopify', true], ['Google Drive', false]]);
  assert.equal(s.counts.failed, 1);
});

test('danh sách và chi tiết brief, kèm số bất thường từ audit', async () => {
  const b = (await (await api('/briefs')).json()) as any;
  assert.equal(b.items[0].status, 'failed');
  assert.equal(b.items[0].anomalies, 1);
  const d = (await (await api(`/briefs/${b.items[0].id}`)).json()) as any;
  assert.equal(d.runs[0].audit.anomalies.length, 1);
  assert.match(d.job.raw_text, /UI Test/);
  assert.equal((await api('/briefs/999')).status, 404);
});

test('chuyển sang CHẠY THẬT phải gõ xác nhận; đổi chế độ ghi .env.bridge và báo Telegram', async () => {
  assert.equal((await api('/dry-run', { method: 'POST', body: JSON.stringify({ on: false, confirm: 'ok' }) })).status, 400);
  assert.equal(jobsCfg.dryRun, true);
  const r = (await (await api('/dry-run', { method: 'POST', body: JSON.stringify({ on: false, confirm: 'CHẠY THẬT' }) })).json()) as any;
  assert.equal(r.changed, true);
  assert.equal(jobsCfg.dryRun, false);
  assert.match(fs.readFileSync(envFile, 'utf8'), /^CLAUDE_DRY_RUN=0\r$/m);
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /đã chuyển sang CHẠY THẬT/.test(String(c.body.text))));
  await api('/dry-run', { method: 'POST', body: JSON.stringify({ on: true }) });
  assert.equal(jobsCfg.dryRun, true);
  assert.match(fs.readFileSync(envFile, 'utf8'), /CLAUDE_DRY_RUN=1/);
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /đã chuyển sang CHẠY THỬ/.test(String(c.body.text))));
});

test('doctor và chạy lại brief lỗi từ trang', async () => {
  const d = (await (await api('/doctor', { method: 'POST', body: '{"live":true}' })).json()) as any;
  assert.equal(d.ok, true);
  assert.deepEqual(doctorCalls, [true]);
  const r = await api('/briefs/1/retry', { method: 'POST', body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(jobs.runsForJob(1).length, 2, 'đã xếp thêm một lượt');
  assert.ok(['queued', 'running'].includes(jobs.getJob(1)!.status));
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /Chạy lại brief #1 .*từ trang quản lý/.test(String(c.body.text))));
  assert.equal((await api('/briefs/1/retry', { method: 'POST', body: '{}' })).status, 409, 'không còn lỗi thì không chạy lại');
});

test('setEnvValue / parseConnectors', () => {
  const f = path.join(os.tmpdir(), `ads-env-${Date.now()}`);
  fs.writeFileSync(f, 'A=1\nB=2\n');
  setEnvValue(f, 'B', '3');
  setEnvValue(f, 'C', 'x');
  assert.equal(fs.readFileSync(f, 'utf8'), 'A=1\nB=3\nC=x\n');
  assert.deepEqual(parseConnectors('claude.ai Shopify: u - ✔ Connected').map((x) => x.ok), [false, true, false]);
});
