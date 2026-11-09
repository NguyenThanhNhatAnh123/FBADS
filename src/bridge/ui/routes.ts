// Trang quản lý cục bộ: http://127.0.0.1:<BRIDGE_PORT>/ui (chỉ khi BRIEF_HANDLER=claude).
//
// Bảo vệ:
//  - chỉ nhận kết nối loopback, từ chối request đi qua Cloudflare Tunnel / proxy (cf-connecting-ip, x-forwarded-for)
//  - Host phải là 127.0.0.1 / localhost (chặn DNS rebinding)
//  - mọi /ui/api/* cần header x-ui-token (token ngẫu nhiên mỗi lần bridge chạy, chỉ nhúng trong trang /ui)
//  - POST còn kiểm Origin (nếu có) — trang web khác không gọi ngầm được
//  - chuyển sang CHẠY THẬT phải gõ xác nhận, và bridge báo lên Telegram mỗi lần đổi chế độ

import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief } from '../../agent/brief/parse.ts';
import type { BridgeDeps } from '../server.ts';
import { briefTitle, STATUS_LABEL } from '../jobs/format.ts';
import { OPEN_STATUSES } from '../jobs/store.ts';
import { logger } from '../../shared/log.ts';

const log = logger('ui');
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_MODE_CONFIRM = 'CHẠY THẬT';

export interface UiOptions {
  envFile?: string; // mặc định <cwd>/.env.bridge
  rootDir?: string; // thư mục dự án (chạy scripts/doctor.ts)
  /** Thay cho `claude mcp list` (test). */
  claudeMcpList?: () => Promise<string>;
  /** Thay cho chạy doctor thật (test). */
  runDoctor?: (live: boolean) => Promise<{ code: number; output: string }>;
}

type Connector = { name: string; ok: boolean; detail: string };

const SECRET_ENV = ['TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET', 'MCP_TOKEN', 'BRIDGE_KEY', 'ANTHROPIC_API_KEY', 'META_READ_TOKEN', 'DRIVE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SA_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
const cleanEnv = () => {
  const e = { ...process.env };
  for (const k of SECRET_ENV) delete e[k];
  return e;
};

/** Đổi (hoặc thêm) một dòng KEY=value trong file env, giữ nguyên các dòng khác. */
export function setEnvValue(file: string, key: string, value: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
    }
  }
  if (!found) {
    if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${value}`);
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, lines.join(nl));
}

export function parseConnectors(out: string): Connector[] {
  return ['Facebook Ads', 'Shopify', 'Google Drive'].map((name) => {
    const line = out.split(/\r?\n/).find((l) => l.includes(`claude.ai ${name}`));
    return { name, ok: !!line && /Connected/i.test(line), detail: line ? line.replace(/^.*?claude\.ai [^:]+:\s*/, '').trim() : 'không thấy (chưa đăng nhập Claude?)' };
  });
}

export function mountUi(app: express.Express, d: BridgeDeps, opts: UiOptions = {}): { token: string } {
  const jm = d.jobs!;
  const store = jm.store;
  const token = randomBytes(24).toString('base64url');
  const envFile = opts.envFile ?? path.resolve('.env.bridge');
  const rootDir = opts.rootDir ?? path.resolve(HERE, '..', '..', '..');
  const startedAt = new Date().toISOString();
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');

  // ---- bảo vệ ----
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const localOnly: express.RequestHandler = (req, res, next) => {
    const viaProxy = !!(req.header('cf-connecting-ip') || req.header('x-forwarded-for'));
    const host = (req.header('host') ?? '').toLowerCase();
    const okHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    if (viaProxy || !LOOPBACK.has(req.socket.remoteAddress ?? '') || !okHost) {
      log.warn(`Từ chối /ui từ ${req.socket.remoteAddress} host=${host}${viaProxy ? ' (qua proxy)' : ''}`);
      res.status(403).json({ ok: false, error: 'Trang quản lý chỉ mở được trên chính máy chạy bridge (http://127.0.0.1)' });
      return;
    }
    next();
  };
  const authed: express.RequestHandler = (req, res, next) => {
    const t = Buffer.from(req.header('x-ui-token') ?? '');
    const want = Buffer.from(token);
    if (t.length !== want.length || !timingSafeEqual(t, want)) {
      res.status(401).json({ ok: false, error: 'Thiếu / sai token trang quản lý — tải lại trang' });
      return;
    }
    const origin = req.header('origin');
    if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
      res.status(403).json({ ok: false, error: 'Origin không hợp lệ' });
      return;
    }
    next();
  };

  // ---- trạng thái Claude CLI / connector (chậm ~10s nên lưu đệm) ----
  let claudeVersion: string | null = null;
  let connectors: { at: string; items: Connector[]; error?: string } | null = null;
  let checking: Promise<void> | null = null;
  const bin = jm.cfg.bin;
  const runMcpList =
    opts.claudeMcpList ??
    (() =>
      new Promise<string>((resolve, reject) =>
        execFile(bin, ['mcp', 'list'], { timeout: 180_000, windowsHide: true, env: cleanEnv() }, (err, stdout, stderr) =>
          err && !stdout ? reject(err) : resolve(`${stdout}\n${stderr}`),
        ),
      ));
  const checkClaude = (): Promise<void> => {
    if (checking) return checking;
    checking = (async () => {
      try {
        if (!opts.claudeMcpList && !claudeVersion) {
          claudeVersion = await new Promise<string>((resolve) =>
            execFile(bin, ['--version'], { timeout: 60_000, windowsHide: true, env: cleanEnv() }, (err, out) => resolve(err ? `lỗi: ${err.message}` : out.trim())),
          );
        }
        connectors = { at: new Date().toISOString(), items: parseConnectors(await runMcpList()) };
      } catch (err) {
        connectors = { at: new Date().toISOString(), items: [], error: (err as Error).message };
      } finally {
        checking = null;
      }
    })();
    return checking;
  };
  void checkClaude();

  let bot: { at: number; ok: boolean; username?: string; error?: string } | null = null;
  const botInfo = async () => {
    if (bot && Date.now() - bot.at < 60_000) return bot;
    try {
      const me = await d.tg.getMe();
      bot = { at: Date.now(), ok: true, username: me.username };
    } catch (err) {
      bot = { at: Date.now(), ok: false, error: (err as Error).message };
    }
    return bot;
  };

  // ---- trang ----
  app.get('/ui', localOnly, (_req, res) => {
    res.set({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.type('html').send(page.replace('__UI_TOKEN__', token));
  });
  app.use('/ui/api', localOnly, express.json({ limit: '64kb' }), authed);

  app.get('/ui/api/status', async (_req, res) => {
    const p = d.polling;
    const all = store.lastJobs(500);
    res.json({
      ok: true,
      now: new Date().toISOString(),
      started_at: startedAt,
      dry_run: !!jm.cfg.dryRun,
      account: jm.cfg.account,
      limits: jm.cfg.limits,
      bot: await botInfo(),
      telegram: p
        ? { mode: 'polling', ok: p.running && !!p.lastOkAt && Date.now() - Date.parse(p.lastOkAt) < 90_000, last_ok_at: p.lastOkAt, last_error: p.lastError, updates: p.updates }
        : { mode: 'webhook', ok: true, url: d.cfg.publicUrl ? `${d.cfg.publicUrl}/tg/webhook` : null },
      runner: jm.summary(),
      claude: { bin, version: claudeVersion, connectors, checking: !!checking },
      counts: {
        open: all.filter((j) => OPEN_STATUSES.includes(j.status)).length,
        pending_approval: all.filter((j) => j.status === 'pending_approval').length,
        failed: all.filter((j) => j.status === 'failed').length,
        active: all.filter((j) => j.status === 'active').length,
      },
    });
  });

  app.post('/ui/api/claude/refresh', async (_req, res) => {
    await checkClaude();
    res.json({ ok: true, claude: { version: claudeVersion, connectors } });
  });

  app.get('/ui/api/briefs', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60) || 60));
    const items = store.lastJobs(limit).map((j) => {
      const brief = j.brief_json ? (JSON.parse(j.brief_json) as Brief) : null;
      const runs = store.runsForJob(j.id);
      const last = runs.at(-1);
      let anomalies = 0;
      for (const r of runs) if (r.audit_json) anomalies += (JSON.parse(r.audit_json) as { anomalies?: string[] }).anomalies?.length ?? 0;
      const extra = JSON.parse(j.extra_json || '{}') as { dry?: boolean };
      return {
        id: j.id,
        type: j.type,
        title: briefTitle(j, brief, jm.cfg.account),
        status: j.status,
        status_label: STATUS_LABEL[j.status],
        dry: extra.dry === true,
        budget_usd: j.budget_usd,
        error: j.error,
        created_at: j.created_at,
        updated_at: j.updated_at,
        runs: runs.length,
        cost_usd: runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
        anomalies,
        last_run: last ? { kind: last.kind, status: last.status, outcome: last.outcome, finished_at: last.finished_at } : null,
      };
    });
    res.json({ ok: true, items });
  });

  app.get('/ui/api/briefs/:id', (req, res) => {
    const job = store.getJob(Number(req.params.id));
    if (!job) return void res.status(404).json({ ok: false, error: 'Không có brief này' });
    const parse = (s: string | null) => (s ? JSON.parse(s) : null);
    res.json({
      ok: true,
      job: { ...job, brief_json: undefined, result_json: undefined, activation_json: undefined, extra_json: undefined, approval_text: undefined, status_label: STATUS_LABEL[job.status] },
      brief: parse(job.brief_json),
      warnings: parse(job.warnings_json),
      extra: parse(job.extra_json),
      result: parse(job.result_json),
      activation: parse(job.activation_json),
      approval_text: job.approval_text ? job.approval_text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null,
      runs: store.runsForJob(job.id).map((r) => ({ ...r, args: parse(r.args_json), audit: parse(r.audit_json), denials: parse(r.denials_json), args_json: undefined, audit_json: undefined, denials_json: undefined })),
      events: store.events(job.id),
    });
  });

  app.get('/ui/api/runs/:id/log', (req, res) => {
    const run = store.getRun(Number(req.params.id));
    if (!run?.log_file) return void res.status(404).json({ ok: false, error: 'Lượt này không có log' });
    const file = path.resolve(run.log_file);
    if (!file.startsWith(path.resolve(jm.cfg.runDir) + path.sep) || !fs.existsSync(file)) return void res.status(404).json({ ok: false, error: 'Không thấy file log' });
    const size = fs.statSync(file).size;
    const max = 300_000;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, max));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - max));
    fs.closeSync(fd);
    res.json({ ok: true, file, truncated: size > max, text: buf.toString('utf8') });
  });

  app.post('/ui/api/briefs/:id/retry', async (req, res) => {
    const r = await jm.retryFromUi(Number(req.params.id));
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.post('/ui/api/dry-run', async (req, res) => {
    const on = req.body?.on === true;
    if (!on && req.body?.confirm !== REAL_MODE_CONFIRM) {
      return void res.status(400).json({ ok: false, error: `Muốn chuyển sang chạy thật phải gõ đúng "${REAL_MODE_CONFIRM}"` });
    }
    if (!!jm.cfg.dryRun === on) return void res.json({ ok: true, dry_run: on, changed: false });
    try {
      setEnvValue(envFile, 'CLAUDE_DRY_RUN', on ? '1' : '0');
    } catch (err) {
      return void res.status(500).json({ ok: false, error: `Không ghi được ${envFile}: ${(err as Error).message}` });
    }
    jm.cfg.dryRun = on;
    store.event(null, 'owner', 'dry_run_toggle', { on, via: 'ui' });
    log.warn(`Trang quản lý: chuyển sang ${on ? 'CHẠY THỬ' : 'CHẠY THẬT'}`);
    await jm
      .notify(
        on
          ? '⚙️ Trang quản lý: đã chuyển sang CHẠY THỬ — brief mới không tạo / bật gì trên Meta.'
          : '⚙️ Trang quản lý: đã chuyển sang CHẠY THẬT — brief mới sẽ tạo bản nháp thật trên Meta (chưa chạy, chưa tiêu tiền); chỉ bật khi bạn bấm Duyệt.',
      )
      .catch(() => {});
    res.json({ ok: true, dry_run: on, changed: true });
  });

  let doctorBusy = false;
  const runDoctor =
    opts.runDoctor ??
    ((live: boolean) =>
      new Promise<{ code: number; output: string }>((resolve) => {
        const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'doctor.ts'), ...(live ? ['--live'] : [])], { cwd: rootDir, env: process.env, windowsHide: true });
        let out = '';
        const timer = setTimeout(() => child.kill(), 6 * 60_000);
        child.stdout.on('data', (b: Buffer) => (out += b.toString()));
        child.stderr.on('data', (b: Buffer) => (out += b.toString()));
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, output: out });
        });
      }));
  app.post('/ui/api/doctor', async (req, res) => {
    if (doctorBusy) return void res.status(409).json({ ok: false, error: 'Doctor đang chạy, đợi chút' });
    doctorBusy = true;
    try {
      const r = await runDoctor(req.body?.live === true);
      res.json({ ok: r.code === 0, ...r });
    } finally {
      doctorBusy = false;
    }
  });

  return { token };
}
