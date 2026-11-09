// BRIEF_HANDLER=claude: bridge tự xử lý brief bằng `claude -p` (ở đây là claude giả chạy bằng node),
// Telegram giả, MCP "adsjob" thật trên /job-mcp/<token>.

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
import { allowedToolsFor, disallowedToolsFor, buildPrompt } from '../src/bridge/jobs/prompts.ts';
import { expectedFor, validateDrafts, type DraftsPayload } from '../src/bridge/jobs/validate.ts';
import { parseBrief, type NewBrief } from '../src/agent/brief/parse.ts';

const OWNER = 777001;
const SECRET = 'webhook_secret_0123456789';
const KEY = 'bridge-key-0123456789abcdefghij';
const FAKE = fileURLToPath(new URL('./helpers/fakeClaude.ts', import.meta.url));

let tg: FakeTelegram;
let server: Server;
let base = '';
let store: BridgeStore;
let jobs: JobStore;
let manager: JobManager;
let jobsCfg: ClaudeJobsConfig;
let runDir: string;
let fakeLog: string;
let clockOffset = 0;
let seq = 1;

before(async () => {
  tg = await startFakeTelegram();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-claude-test-'));
  fakeLog = path.join(runDir, 'fake-claude.jsonl');
  process.env.FAKE_CLAUDE_LOG = fakeLog;
  process.env.CLAUDE_CONFIG_DIR = path.join(runDir, 'claude-config'); // claude giả ghi nhật ký phiên ở đây để audit.ts đọc
  process.env.TG_BOT_TOKEN = 'bot-token-must-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
  process.env.META_READ_TOKEN = 'readonly-must-not-leak';
  process.env.DRIVE_SERVICE_ACCOUNT_JSON = 'credentials-must-not-leak';
  jobsCfg = {
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
  };
  const cfg: BridgeConfig = {
    briefHandler: 'claude',
    jobs: jobsCfg,
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'https://bridge.example.com',
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
  const outbox = new Outbox(api, OWNER, limiter);
  const forwarder = new AgentForwarder(cfg, store, async () => {});
  manager = new JobManager({
    cfg: jobsCfg,
    ownerChatId: OWNER,
    jobs,
    tg: api,
    limiter,
    runner: new ClaudeCliRunner(jobsCfg),
    mcpBase: () => base,
    now: () => new Date(Date.now() + clockOffset),
  });
  const app = buildBridgeApp({ cfg, store, tg: api, outbox, forwarder, jobs: manager });
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  manager.start(3600_000);
});

after(async () => {
  await manager.idle(); // chờ các lượt còn trong hàng đợi (ví dụ lượt tự huỷ) chạy xong rồi mới đóng DB
  manager.stop();
  await tg.close();
  await new Promise((r) => server.close(() => r(undefined)));
  store.close();
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.META_READ_TOKEN;
  delete process.env.DRIVE_SERVICE_ACCOUNT_JSON;
  delete process.env.CLAUDE_CONFIG_DIR;
});

// ---------- tiện ích ----------
function hook(update: Record<string, unknown>) {
  return fetch(`${base}/tg/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ update_id: seq++, ...update }),
  });
}
const send = (text: string, extra: Record<string, unknown> = {}) =>
  hook({ message: { message_id: 50_000 + seq, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false }, text, ...extra } });
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
const texts = () => tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.body.text ?? ''));
const sentWith = (re: RegExp) => tg.calls.find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && re.test(String(c.body.text ?? '')));
const fakeRuns = () =>
  fs.existsSync(fakeLog)
    ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; job: number; argv: string[]; cwd: string; hasBotToken: boolean; hasApiKey: boolean; hasMetaReadToken: boolean; hasDriveCredentials: boolean })
    : [];
const lastJobId = () => (jobs.db.prepare('SELECT max(id) id FROM jobs').get() as { id: number }).id;
/** Nút trong tin gửi gần nhất có chữ khớp label, kèm message_id của tin đó. */
const button = (label: RegExp) => tg.findButton(label);

function newBrief(product: string, budget = 50, extra = '') {
  return `#NEW\nTK: H3\nKiểu chạy: Auto\nSản phẩm: ${product}\nLink SP: https://firstnationslegacy.com/products/${product.toLowerCase().replace(/\s+/g, '-')}\nCreative: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp\nQuốc gia: US, CA\nBudget/ngày ($): ${budget}\nNgày chạy: hôm nay\nGhi chú copy: ${extra}`;
}

// ---------- test ----------

test('brief sai → đúng một tin liệt kê lỗi, không chạy claude', async () => {
  const before = fakeRuns().length;
  await send('#NEW\nTK: H3\nKiểu chạy: Tự động\nSản phẩm: Ao\nQuốc gia: US\nBudget/ngày ($): 20');
  const msg = await waitFor(() => sentWith(/chưa hợp lệ/));
  assert.match(String(msg.body.text), /Thiếu trường bắt buộc: .*Link SP/);
  assert.match(String(msg.body.text), /Kiểu chạy "Tự động" không hợp lệ/);
  await manager.idle();
  assert.equal(fakeRuns().length, before);
});

test('#NEW hợp lệ → claude -p dựng nháp (không có quyền bật) → tin duyệt có nút', async () => {
  await send(newBrief('Raven Hoodie'));
  const id = lastJobId();
  const ok = await waitFor(() => button(/Duyệt & chạy/));
  const approval = await waitFor(() => sentWith(/CHỜ DUYỆT/));
  const t = String(approval.body.text);
  assert.match(t, /brief #\d+/);
  assert.match(t, /Camp: Dân - Auto - Raven Hoodie - \d\d\/\d\d\/\d{4}/);
  assert.match(t, /Budget: \$50\/ngày · CBO · Auto · US, CA/);
  assert.match(t, /V1 · first_person_story/);
  assert.match(t, /Post ID: <code>101065259399535_901<\/code>/);
  assert.match(t, /chưa chạy, chưa tiêu tiền/);
  assert.ok(button(/Chỉ V2/) && button(/Sửa copy/) && button(/Huỷ/));
  assert.ok(ok.data.startsWith(`bj:${id}:ok:`));
  assert.equal(jobs.getJob(id)!.status, 'pending_approval');

  const run = fakeRuns().find((r) => r.job === id && r.kind === 'create')!;
  const allowed = run.argv[run.argv.indexOf('--allowedTools') + 1];
  assert.ok(run.argv.includes('--restricted'));
  assert.equal(run.argv[run.argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!allowed.includes('ads_activate_entity'), 'lượt create không được có ads_activate_entity');
  assert.ok(allowed.includes('mcp__claude_ai_Facebook_Ads__ads_create_campaign'));
  assert.ok(run.argv[run.argv.indexOf('--disallowedTools') + 1].includes('ads_activate_entity'));
  assert.equal(run.hasBotToken, false, 'không truyền TG_BOT_TOKEN sang claude');
  assert.equal(run.hasApiKey, false, 'không truyền ANTHROPIC_API_KEY sang claude');
    assert.equal(run.hasMetaReadToken, false, 'không truyền META_READ_TOKEN sang claude');
    assert.equal(run.hasDriveCredentials, false, 'không truyền service account sang claude');
  assert.ok(fs.readdirSync(run.cwd).length === 0, 'thư mục làm việc của claude phải rỗng');
});

test('Duyệt & chạy → lượt activate (có ads_activate_entity) → 🟢; bấm lại bị chặn', async () => {
  const id = lastJobId();
  const ok = button(/Duyệt & chạy/)!;
  await press(ok.data, ok.messageId);
  const live = await waitFor(() => sentWith(/ĐANG CHẠY/));
  assert.match(String(live.body.text), /campaign <code>c-live-1<\/code> · ACTIVE/);
  assert.match(String(live.body.text), /ad <code>ad-live-1<\/code> · PENDING_REVIEW/);
  assert.equal(jobs.getJob(id)!.status, 'active');
  const run = fakeRuns().find((r) => r.job === id && r.kind === 'activate')!;
  assert.ok(run.argv[run.argv.indexOf('--allowedTools') + 1].includes('mcp__claude_ai_Facebook_Ads__ads_activate_entity'));

  const n = fakeRuns().length;
  await press(ok.data, ok.messageId);
  await waitFor(() => tg.calls.some((c) => c.method === 'answerCallbackQuery' && /cũ|đang chạy/.test(String(c.body.text))));
  await manager.idle();
  assert.equal(fakeRuns().length, n, 'bấm lần hai không chạy thêm lượt nào');
});

test('audit: lượt create bình thường (fileCreate → fileDelete đúng file) đọc được nhật ký, không bất thường', async () => {
  await manager.idle();
  const run = jobs.db.prepare("SELECT audit_json FROM job_runs WHERE kind='create' AND outcome='drafts' ORDER BY id LIMIT 1").get() as { audit_json: string };
  const a = JSON.parse(run.audit_json) as { found: boolean; writes: string[]; anomalies: string[] };
  assert.equal(a.found, true);
  assert.deepEqual(a.anomalies, []);
  assert.ok(a.writes.includes('shopify fileCreate') && a.writes.includes('shopify fileDelete'));
});

test('audit: lượt create gọi mutation Shopify ngoài phạm vi → 🔴 + khoá brief, không duyệt được', async () => {
  await send(newBrief('Audit Moose', 7, 'BADMUTATION'));
  const id = lastJobId();
  const alert = await waitFor(() => sentWith(new RegExp(`Brief #${id}</b>: soát lại lượt dựng bản nháp thấy thao tác NGOÀI PHẠM VI`)));
  assert.match(String(alert.body.text), /productUpdate/);
  assert.match(String(alert.body.text), /Đã khoá brief này/);
  await waitFor(() => jobs.getJob(id)?.status === 'failed');
  assert.ok(await waitFor(() => sentWith(new RegExp(`BỊ KHOÁ</b> · brief #${id}`))));
  const ok = tg.findButton(/Duyệt & chạy/)!; // nút của tin duyệt đã bị khoá
  const n = fakeRuns().length;
  await press(ok.data, ok.messageId);
  await manager.idle();
  assert.equal(fakeRuns().length, n, 'brief bị khoá thì bấm Duyệt không chạy gì');
  assert.equal(jobs.getJob(id)!.status, 'failed');
});

test('Sửa copy → "Sửa gì?" → trả lời → tin duyệt mới, tin cũ ghi ĐÃ SỬA', async () => {
  await send(newBrief('Eagle Tee', 20));
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const ed = button(/Sửa copy/)!;
  await press(ed.data, ed.messageId);
  const ask = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage' && c.body.reply_markup?.force_reply && /Brief #\d+: sửa gì/.test(String(c.body.text))));
  const askId = await waitFor(() => jobs.getJob(id)!.edit_prompt_message_id);
  assert.ok(ask);
  await send('nhấn mạnh in 2 mặt', { reply_to_message: { message_id: askId, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: 1, is_bot: true }, text: 'Sửa gì?' } });
  await waitFor(() => sentWith(/For the Man Who Loves Ravens/));
  await waitFor(() => sentWith(/ĐÃ SỬA/));
  assert.equal(jobs.getJob(id)!.status, 'pending_approval');
  const r = JSON.parse(jobs.getJob(id)!.result_json!) as DraftsPayload;
  assert.equal(r.ads[0].creative_id, 'cr-1e');
});

test('Huỷ → lượt cancel → ⚪ ĐÃ HUỶ', async () => {
  const id = lastJobId();
  const cx = button(/Huỷ/)!;
  await press(cx.data, cx.messageId);
  const m = await waitFor(() => sentWith(/ĐÃ HUỶ/));
  assert.match(String(m.body.text), /đã xoá \d+ object/);
  assert.equal(jobs.getJob(id)!.status, 'cancelled');
});

test('Budget $400 → xác nhận lần 2; bấm Vẫn tạo mới dựng nháp', async () => {
  const n = fakeRuns().length;
  await send(newBrief('Wolf Jersey', 400));
  const id = lastJobId();
  await waitFor(() => sentWith(/cần xác nhận lần 2/));
  assert.match(texts().at(-1)!, /Budget \$400\/ngày lớn hơn \$300/);
  await manager.idle();
  assert.equal(fakeRuns().length, n, 'chưa xác nhận thì không chạy claude');
  const yes = button(/Vẫn tạo/)!;
  await press(yes.data, yes.messageId);
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  // dọn để không tính vào tổng budget của các test sau
  const cx = button(/Huỷ/)!;
  await press(cx.data, cx.messageId);
  await waitFor(() => jobs.getJob(id)?.status === 'cancelled');
});

test('copy vi phạm → submit_drafts bị trả lỗi, Claude sửa rồi nộp lại', async () => {
  await send(newBrief('Bear Bag', 15, 'BADCOPY'));
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const ev = jobs.events(id).find((e) => e.action === 'drafts_rejected');
  assert.ok(ev, 'phải có lần bị trả');
  assert.match(ev!.detail!, /authentic|Native-made/i);
  const approval = jobs.getJob(id)!.approval_text!;
  assert.doesNotMatch(approval, /Authentic/);
  const cx = button(/Huỷ/)!;
  await press(cx.data, cx.messageId);
  await waitFor(() => jobs.getJob(id)?.status === 'cancelled');
});

test('Claude dừng không báo kết quả → 🔴 + /retry chạy lại được', async () => {
  await send(newBrief('Silent Owl', 12, 'SILENT'));
  const id = lastJobId();
  const msg = await waitFor(() => sentWith(new RegExp(`Brief #${id}</b>: lượt dựng bản nháp dừng giữa chừng`)));
  assert.match(String(msg.body.text), /Tôi quên gọi submit/);
  assert.equal(jobs.getJob(id)!.status, 'failed');
  await send(`/retry ${id}`);
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const cx = button(/Huỷ/)!;
  await press(cx.data, cx.messageId);
  await waitFor(() => jobs.getJob(id)?.status === 'cancelled');
});

test('report_failure → 🔴 kèm lỗi Meta và hướng dẫn /retry', async () => {
  await send(newBrief('Fail Fox', 10, 'FAILME'));
  const id = lastJobId();
  const m = await waitFor(() => sentWith(/lượt dựng bản nháp lỗi/));
  assert.match(String(m.body.text), /Unable to download media/);
  assert.match(String(m.body.text), new RegExp(`/retry ${id}`));
  assert.equal(jobs.getJob(id)!.status, 'failed');
});

test('#ADD Camp khớp nhiều campaign → bấm chọn → dựng nháp vào đúng camp', async () => {
  await send('#ADD\nTK: H3\nCamp: hoodie\nAdset: mới\nLink SP: https://firstnationslegacy.com/products/raven-hoodie\nCreative: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view');
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'choosing');
  const pick = await waitFor(() => button(/2\. Dân - CC - Hoodie B/));
  await press(pick.data, pick.messageId);
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  const r = JSON.parse(jobs.getJob(id)!.result_json!) as DraftsPayload;
  assert.equal(r.campaign.id, '222222');
  assert.match(jobs.getJob(id)!.approval_text!, /có sẵn, giữ nguyên/);
});

test('trần tổng budget: camp đang chạy + brief mới vượt $1.500 → từ chối, không tạo gì', async () => {
  await send(newBrief('Big Total', 200, 'BIGTOTAL'));
  const id = lastJobId();
  const m = await waitFor(() => sentWith(new RegExp(`Brief #${id} bị từ chối`)));
  assert.match(String(m.body.text), /vượt giới hạn \$1,500/);
  assert.equal(jobs.getJob(id)!.status, 'rejected');
});

test('nhắc sau 24 giờ, tự huỷ sau 72 giờ chưa duyệt', async () => {
  await send(newBrief('Turtle Mug', 9));
  const id = lastJobId();
  await waitFor(() => jobs.getJob(id)?.status === 'pending_approval');
  clockOffset = 25 * 3600_000;
  await manager.tick();
  await waitFor(() => sentWith(new RegExp(`Brief #${id} chờ duyệt đã 24 giờ`)));
  clockOffset = 73 * 3600_000;
  await manager.tick();
  await waitFor(() => jobs.getJob(id)?.status === 'cancelled');
  assert.match(jobs.getJob(id)!.approval_text!, /CHỜ DUYỆT/); // tin gốc giữ nguyên trong DB
  assert.ok(sentWith(/Tự huỷ sau 72 giờ/));
  clockOffset = 0;
});

test('/job-mcp: token sai hoặc đi qua tunnel → 401', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(`${base}/job-mcp/${'0'.repeat(64)}`, { method: 'POST', headers: h, body })).status, 401);
  assert.equal((await fetch(`${base}/job-mcp/abc`, { method: 'POST', headers: { ...h, 'cf-connecting-ip': '1.2.3.4' }, body })).status, 401);
});

test('/status liệt kê brief đang xử lý', async () => {
  await send('/status');
  const m = await waitFor(() => sentWith(/Brief đang xử lý/));
  assert.match(String(m.body.text), /Claude: rảnh|Claude đang chạy/);
});

// ---------- đơn vị ----------

test('danh sách tool: chỉ lượt activate có ads_activate_entity', () => {
  for (const k of ['create', 'edit', 'cancel'] as const) {
    assert.ok(!allowedToolsFor(k).some((t) => t.endsWith('ads_activate_entity')), k);
    assert.ok(disallowedToolsFor(k).some((t) => t.endsWith('ads_activate_entity')), k);
  }
  assert.ok(allowedToolsFor('activate').some((t) => t.endsWith('ads_activate_entity')));
  for (const k of ['create', 'edit', 'activate', 'cancel'] as const) {
    assert.ok(!allowedToolsFor(k).some((t) => /share_file|trash_file|update-product|Bash|WebFetch/.test(t)), k);
    // graphql_mutation chỉ cho lượt create (đưa media qua Shopify Files) — xem test/audit.test.ts
    assert.equal(allowedToolsFor(k).some((t) => t.endsWith('graphql_mutation')), false, k);
  }
});

test('validateDrafts: lệch tên / budget / bid / ACTIVE bị trả về', () => {
  const pr = parseBrief(newBrief('Raven Hoodie', 50), { accountNames: ['H3'], pageId: '101065259399535', shopDomain: 'firstnationslegacy.com', timezone: 'America/Dawson' });
  const brief = pr.brief as NewBrief;
  const exp = expectedFor(brief, defaultAccount(), new Date('2026-11-09T03:00:00Z'));
  assert.equal(exp.campaignName, 'Dân - Auto - Raven Hoodie - 09/11/2026');
  assert.equal(exp.adsetName, 'Dân - Auto - Raven Hoodie - 09/11/2026 - US, CA');
  assert.equal(exp.dailyBudgetCents, 5000);
  const p = {
    product: { title: 'Raven Hoodie', handle: 'raven-hoodie', status: 'ACTIVE', page_text: '' },
    campaign: { id: 'c', name: 'Sai tên', existing: false, daily_budget_cents: 50, bid_strategy: 'COST_CAP', status: 'ACTIVE' },
    adset: { id: 'a', name: exp.adsetName!, existing: false, status: 'DRAFT' },
    media: [{ name: 'x.mp4', kind: 'video', meta_id: 'v' }],
    variants: [],
    ads: [{ id: 'ad', name: 'x', variant: 1, creative_id: 'cr' }],
    warnings: [],
  } as unknown as DraftsPayload;
  const errs = validateDrafts(brief, exp, p, defaultLimits()).join('\n');
  assert.match(errs, /Tên campaign phải đúng/);
  assert.match(errs, /daily_budget của campaign phải là 5000 cent/);
  assert.match(errs, /bid_strategy phải là LOWEST_COST_WITHOUT_CAP/);
  assert.match(errs, /Campaign mới đang ACTIVE/);
  assert.match(errs, /Cần 2–3 phương án copy/);
});

test('prompt create: có giá trị bắt buộc, link tải Drive, cấm bật', () => {
  const pr = parseBrief(newBrief('Raven Hoodie', 50), { accountNames: ['H3'], pageId: '101065259399535', shopDomain: 'firstnationslegacy.com', timezone: 'America/Dawson' });
  const brief = pr.brief!;
  const job = { id: 7, raw_text: 'x', warnings_json: '[]' } as never;
  const p = buildPrompt({
    runId: 1,
    kind: 'create',
    job,
    brief,
    expected: expectedFor(brief, defaultAccount(), new Date('2026-11-09T03:00:00Z')),
    acc: defaultAccount(),
    limits: defaultLimits(),
    args: {},
    previous: null,
    leftovers: [],
    managedActiveCampaignIds: [],
  });
  assert.match(p, /campaign_daily_budget 5000/);
  assert.match(p, /"pixel_id":"625569536048355","custom_event_type":"PURCHASE"/);
  assert.match(p, /stage_drive_media/);
  assert.match(p, /Không bật gì \(ads_activate_entity bị khoá/);
  assert.doesNotMatch(p, /check_budget với/); // không có camp đang chạy thì bỏ bước trần ngân sách
});
