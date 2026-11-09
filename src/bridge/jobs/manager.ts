// Điều phối chế độ BRIEF_HANDLER=claude.
//
//   Telegram #NEW/#ADD ─► bridge đọc brief + giới hạn an toàn (code) ─► hàng đợi lượt chạy
//   ─► `claude -p` (connector claude.ai, chỉ tạo NHÁP) ─► submit_drafts (bridge soát lại) ─► tin duyệt có nút
//   ─► chủ shop bấm Duyệt ─► lượt activate (lượt DUY NHẤT có ads_activate_entity) ─► 🟢
//
// Mỗi lần chỉ chạy một lượt. Nút bấm ký HMAC, có số phiên bản; đổi trạng thái nguyên tử nên bấm hai lần không chạy hai lần.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { auditRun } from './audit.ts';
import { briefFingerprint, detectCommand, parseBrief, type Brief } from '../../agent/brief/parse.ts';
import { TelegramError, escapeHtml as esc, type InlineKeyboard, type ReplyMarkup, type TelegramApi, type TgCallbackQuery, type TgMessage } from '../../shared/telegram.ts';
import { formatDateTime } from '../../shared/time.ts';
import type { RateLimiter } from '../outbox.ts';
import type { ClaudeJobsConfig } from './config.ts';
import { buildPrompt, type RunArgs } from './prompts.ts';
import type { Runner, RunResult } from './runner.ts';
import { OPEN_STATUSES, type JobRow, type JobStatus, type JobStore, type RunKind, type RunRow } from './store.ts';
import {
  approvalKeyboard,
  briefTitle,
  choiceKeyboard,
  composeApproval,
  confirmKeyboard,
  helpText,
  parseButton,
  restamp,
  STATUS_LABEL,
} from './format.ts';
import {
  copyIssues,
  expectedFor,
  validateDrafts,
  type ActivationPayload,
  type CancelPayload,
  type DraftsPayload,
  type FailurePayload,
} from './validate.ts';
import type { CopyVariant } from '../../agent/copy/rules.ts';
import { logger } from '../../shared/log.ts';

const log = logger('jobs');

export interface ActiveRun {
  run: RunRow;
  jobId: number;
  kind: RunKind;
  token: string;
  outcome: string | null;
  startedAt: number;
  lastProgressAt: number;
}

export interface JobManagerDeps {
  cfg: ClaudeJobsConfig;
  ownerChatId: number;
  jobs: JobStore;
  tg: TelegramApi;
  limiter: RateLimiter;
  runner: Runner;
  /** http://127.0.0.1:<port> — gốc URL /job-mcp/<token> cho tiến trình claude. */
  mcpBase: () => string;
  now?: () => Date;
}

const LIVE_OK = /^(ACTIVE|IN_PROCESS|WITH_ISSUES|PENDING_REVIEW|PREAPPROVED)$/i;
const KIND_LABEL: Record<RunKind, string> = { create: 'dựng bản nháp', edit: 'sửa copy', activate: 'bật quảng cáo', cancel: 'huỷ bản nháp' };

export class JobManager {
  private readonly d: JobManagerDeps;
  private readonly now: () => Date;
  private active: ActiveRun | null = null;
  private loop: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(d: JobManagerDeps) {
    this.d = d;
    this.now = d.now ?? (() => new Date());
  }

  get cfg(): ClaudeJobsConfig {
    return this.d.cfg;
  }

  /** Kho job (trang quản lý đọc danh sách / chi tiết). */
  get store(): JobStore {
    return this.d.jobs;
  }

  // ======================================================================
  // Gửi / sửa tin
  // ======================================================================

  private async send(html: string, o: { markup?: ReplyMarkup; replyTo?: number | null; silent?: boolean } = {}): Promise<number> {
    await this.d.limiter.take();
    try {
      const m = await this.d.tg.sendMessage(this.d.ownerChatId, html, {
        parse_mode: 'HTML',
        reply_markup: o.markup,
        reply_to_message_id: o.replyTo ?? undefined,
        disable_notification: o.silent,
        disable_preview: true,
      });
      return m.message_id;
    } catch (err) {
      if (!(err instanceof TelegramError && err.isParseError)) throw err;
      const m = await this.d.tg.sendMessage(this.d.ownerChatId, html.replace(/<[^>]+>/g, ''), { reply_markup: o.markup, reply_to_message_id: o.replyTo ?? undefined, disable_preview: true });
      return m.message_id;
    }
  }

  /** Sửa tin; không sửa được (tin quá cũ, đã xoá) thì gửi tin mới. Trả về message_id đang hiển thị. */
  private async edit(messageId: number | null, html: string, markup?: InlineKeyboard): Promise<number> {
    if (messageId) {
      try {
        await this.d.limiter.take();
        await this.d.tg.editMessageText(this.d.ownerChatId, messageId, html, { parse_mode: 'HTML', reply_markup: markup, disable_preview: true });
        return messageId;
      } catch (err) {
        log.warn(`Không sửa được tin ${messageId}, gửi tin mới`, err);
      }
    }
    return this.send(html, { markup });
  }

  // ======================================================================
  // Đầu vào từ Telegram
  // ======================================================================

  isEditPrompt(messageId: number): boolean {
    return !!this.d.jobs.jobByEditPrompt(messageId);
  }

  async onBrief(m: TgMessage): Promise<void> {
    const { jobs, cfg } = this.d;
    const acc = cfg.account;
    const L = cfg.limits;
    const text = (m.text ?? m.caption ?? '').trim();
    const now = this.now();
    const pr = parseBrief(text, { accountNames: [acc.name], pageId: acc.pageId, shopDomain: acc.shopDomain, timezone: acc.timezone, now });
    const type = detectCommand(text) ?? 'NEW';
    const warnText = pr.warnings.length ? `\n\n⚠ ${pr.warnings.map(esc).join('\n⚠ ')}` : '';

    if (!pr.brief) {
      const id = jobs.createJob({ type, raw_text: text, brief_json: null, warnings: pr.warnings, budget_usd: null, status: 'rejected', error: pr.errors.join(' | ') });
      jobs.event(id, 'owner', 'brief', { message_id: m.message_id, valid: false });
      await this.send(`❌ <b>Brief #${id} chưa hợp lệ</b> — chưa tạo gì trên Meta:\n${pr.errors.map((e) => `• ${esc(e)}`).join('\n')}${warnText}\n\nSửa rồi gửi lại cả brief.`, { replyTo: m.message_id });
      return;
    }
    const brief = pr.brief;
    const budget = brief.type === 'NEW' ? brief.budgetUsd : null;

    // ---- Giới hạn an toàn (code) ----
    let reject: string | null = null;
    const confirm: string[] = [];
    if (brief.type === 'NEW') {
      const pending = this.pendingBudgetUsd(null);
      if (pending + brief.budgetUsd > L.totalBudgetUsd) {
        reject = `Các brief đang chờ / đang dựng đã chiếm $${fmt(pending)}/ngày; thêm $${fmt(brief.budgetUsd)} sẽ vượt giới hạn tổng $${fmt(L.totalBudgetUsd)}/ngày.`;
      }
      if (brief.budgetUsd > L.budgetConfirmUsd) confirm.push(`Budget $${fmt(brief.budgetUsd)}/ngày lớn hơn $${fmt(L.budgetConfirmUsd)}`);
      if (brief.capUsd !== null && (brief.capUsd < L.capMinUsd || brief.capUsd > L.capMaxUsd)) {
        confirm.push(`Mức cap $${fmt(brief.capUsd)} nằm ngoài khung $${fmt(L.capMinUsd)}–$${fmt(L.capMaxUsd)} — có gõ nhầm không?`);
      }
    }
    const since = new Date(now.getTime() - L.duplicateWindowMin * 60_000).toISOString();
    const fp = briefFingerprint(text);
    const dup = jobs.recentJobs(since).find((j) => !['rejected', 'failed', 'cancelled'].includes(j.status) && briefFingerprint(j.raw_text) === fp);
    if (dup) confirm.push(`Brief này giống brief #${dup.id} gửi lúc ${formatDateTime(new Date(dup.created_at))}`);

    const status: JobStatus = reject ? 'rejected' : confirm.length ? 'confirm' : 'queued';
    const id = jobs.createJob({ type: brief.type, raw_text: text, brief_json: JSON.stringify(brief), warnings: pr.warnings, budget_usd: budget, status, error: reject ?? undefined });
    if (this.d.cfg.dryRun) jobs.updateJob(id, { extra_json: JSON.stringify({ dry: true }) }); // chạy thử: không tạo / bật gì trên Meta
    jobs.event(id, 'owner', 'brief', { message_id: m.message_id, valid: true, status, dry: !!this.d.cfg.dryRun });
    const job = jobs.getJob(id)!;
    const title = esc(briefTitle(job, brief, acc));

    if (reject) {
      await this.send(`⛔ <b>Brief #${id} bị từ chối</b> (${title})\n${esc(reject)}\nKhông tạo gì trên Meta.`, { replyTo: m.message_id });
      return;
    }
    if (confirm.length) {
      jobs.updateJob(id, { button_version: 1 });
      const msgId = await this.send(`⚠ <b>Brief #${id} cần xác nhận lần 2</b> (${title})\n${confirm.map((c) => `• ${esc(c)}`).join('\n')}${warnText}\n\nVẫn tạo bản nháp?`, {
        replyTo: m.message_id,
        markup: confirmKeyboard(this.d.cfg.callbackSecret, id, 1),
      });
      jobs.updateJob(id, { status_message_id: msgId });
      return;
    }
    const msgId = await this.send(`📥 <b>Đã nhận brief #${id}</b> (${title})\nClaude đang dựng bản nháp trên Meta — thường mất vài phút.${warnText}`, { replyTo: m.message_id });
    jobs.updateJob(id, { status_message_id: msgId });
    this.queue(id, 'create', {});
  }

  async onCommand(m: TgMessage): Promise<void> {
    const text = (m.text ?? '').trim();
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.replace(/@\w+$/, '').toLowerCase();
    if (cmd === '/status') return void (await this.send(this.statusText(), { replyTo: m.message_id }));
    if (cmd === '/retry') return void (await this.retry(Number((rest[0] ?? '').replace(/^#/, '')), m.message_id));
    await this.send(helpText(this.d.cfg.account), { replyTo: m.message_id });
  }

  /** Trả lời vào tin "Sửa gì?" → lượt sửa copy. Trả false nếu không phải tin của job (để vào hộp thư Claude). */
  async onReply(m: TgMessage): Promise<boolean> {
    const replyTo = m.reply_to_message?.message_id;
    if (!replyTo) return false;
    const job = this.d.jobs.jobByEditPrompt(replyTo);
    if (!job) return false;
    const note = (m.text ?? m.caption ?? '').trim();
    if (!note) {
      await this.send('Cần trả lời bằng chữ: muốn sửa copy thế nào?', { replyTo: m.message_id });
      return true;
    }
    const version = job.button_version + 1;
    if (!this.d.jobs.transition(job.id, ['pending_approval'], 'queued', { button_version: version, edit_prompt_message_id: null })) {
      await this.send(`Brief #${job.id} không còn chờ duyệt (${STATUS_LABEL[job.status]}), không sửa được nữa.`, { replyTo: m.message_id });
      return true;
    }
    this.d.jobs.event(job.id, 'owner', 'edit_copy', note);
    if (job.approval_text) await this.edit(job.approval_message_id, `${job.approval_text}\n\n✏️ Đang sửa copy: «${esc(note.slice(0, 300))}»`);
    const msgId = await this.send(`✍️ Đã nhận — Claude đang viết lại copy cho brief #${job.id}…`, { replyTo: m.message_id });
    this.d.jobs.updateJob(job.id, { status_message_id: msgId });
    this.queue(job.id, 'edit', { note });
    return true;
  }

  async onButton(cq: TgCallbackQuery): Promise<void> {
    const { jobs, tg } = this.d;
    const b = parseButton(this.d.cfg.callbackSecret, cq.data ?? '');
    const job = b ? jobs.getJob(b.jobId) : undefined;
    if (!b || !job) return void (await tg.answerCallbackQuery(cq.id, 'Nút không hợp lệ'));
    if (b.version !== job.button_version) return void (await tg.answerCallbackQuery(cq.id, 'Nút này đã cũ — dùng tin mới nhất'));
    const brief = job.brief_json ? (JSON.parse(job.brief_json) as Brief) : null;
    const title = esc(briefTitle(job, brief, this.d.cfg.account));
    const msgId = cq.message?.message_id ?? null;
    const stamp = formatDateTime(this.now());
    const done = (t: string) => tg.answerCallbackQuery(cq.id, t);

    if (b.action === 'yes' || b.action === 'no') {
      const to: JobStatus = b.action === 'yes' ? 'queued' : 'cancelled';
      if (!jobs.transition(job.id, ['confirm'], to)) return void (await done('Đã xử lý rồi'));
      jobs.event(job.id, 'owner', b.action === 'yes' ? 'confirm' : 'confirm_cancel');
      const base = cq.message?.text ? esc(cq.message.text) : `Brief #${job.id} (${title})`;
      if (b.action === 'yes') {
        await this.edit(msgId, `${base}\n\n✅ Đã xác nhận lúc ${stamp} — Claude đang dựng bản nháp…`);
        this.queue(job.id, 'create', {});
      } else {
        await this.edit(msgId, `${base}\n\n⚪ Đã huỷ lúc ${stamp}, không tạo gì trên Meta.`);
      }
      return void (await done(b.action === 'yes' ? 'Đã xác nhận' : 'Đã huỷ'));
    }

    const c = /^c(\d)$/.exec(b.action);
    if (c) {
      const extra = this.extra(job);
      const opt = (extra.choices as Array<{ id: string; label: string }> | undefined)?.[Number(c[1])];
      if (!opt) return void (await done('Lựa chọn không hợp lệ'));
      if (!jobs.transition(job.id, ['choosing'], 'queued', { extra_json: JSON.stringify({ ...extra, campId: opt.id }) })) return void (await done('Đã chọn rồi'));
      jobs.event(job.id, 'owner', 'choose_campaign', opt);
      await this.edit(msgId, `🔎 Brief #${job.id} (${title})\n✅ Đã chọn: ${esc(opt.label)} — Claude đang dựng bản nháp…`);
      this.queue(job.id, 'create', { campId: opt.id });
      return void (await done('Đã chọn'));
    }

    if (job.status !== 'pending_approval') return void (await done(`Brief #${job.id} đang ${STATUS_LABEL[job.status]}`));
    const result = job.result_json ? (JSON.parse(job.result_json) as DraftsPayload) : null;
    if (!result) return void (await done('Chưa có bản nháp'));

    const v = /^v([1-3])$/.exec(b.action);
    if (b.action === 'ok' || v) {
      const variants: number[] | 'all' = v ? [Number(v[1])] : 'all';
      const label = v ? `Chỉ V${v[1]}` : 'Duyệt & chạy';
      if (v && !result.ads.some((a) => a.variant === Number(v[1]))) return void (await done(`Không có phương án V${v[1]}`));
      if (!jobs.transition(job.id, ['pending_approval'], 'activating', { button_version: job.button_version + 1 })) return void (await done('Đã xử lý rồi'));
      jobs.event(job.id, 'owner', 'approve', { variants });
      if (this.isDry(job)) {
        await this.simulateActivation(job.id, variants, label);
        return void (await done('Chạy thử: đã ghi nhận duyệt'));
      }
      await this.edit(job.approval_message_id ?? msgId, `${job.approval_text}\n\n⏳ ${label} — bấm lúc ${stamp}, Claude đang bật…`);
      this.queue(job.id, 'activate', { variants, label });
      return void (await done('Đang bật…'));
    }
    if (b.action === 'cx') {
      if (!jobs.transition(job.id, ['pending_approval'], 'cancelling', { button_version: job.button_version + 1 })) return void (await done('Đã xử lý rồi'));
      jobs.event(job.id, 'owner', 'cancel');
      if (this.isDry(job)) {
        await this.simulateCancel(job.id, false);
        return void (await done('Chạy thử: đã huỷ'));
      }
      await this.edit(job.approval_message_id ?? msgId, `${job.approval_text}\n\n⏳ Huỷ — bấm lúc ${stamp}, Claude đang xoá bản nháp…`);
      this.queue(job.id, 'cancel', {});
      return void (await done('Đang huỷ…'));
    }
    if (b.action === 'ed') {
      if (!result.variants.length) return void (await done('Brief dùng Post ID có sẵn, không có copy để sửa'));
      const ask = await this.send(`✏️ Brief #${job.id}: sửa gì? <b>Trả lời vào tin này</b> (ví dụ: nhấn mạnh in 2 mặt).`, {
        markup: { force_reply: true, input_field_placeholder: 'Muốn sửa copy thế nào?' },
        replyTo: job.approval_message_id,
      });
      jobs.updateJob(job.id, { edit_prompt_message_id: ask });
      return void (await done('Trả lời vào tin "Sửa gì?"'));
    }
    await done('Nút không hợp lệ');
  }

  // ======================================================================
  // Hàng đợi lượt chạy
  // ======================================================================

  private queue(jobId: number, kind: RunKind, args: RunArgs): number {
    const id = this.d.jobs.queueRun(jobId, kind, args as Record<string, unknown>);
    this.d.jobs.event(jobId, 'bridge', 'queue_run', { run: id, kind, args });
    void this.kick();
    return id;
  }

  start(tickMs = 60_000): void {
    this.recoverInterrupted();
    this.timer = setInterval(() => void this.tick().catch((err) => log.error('tick lỗi', err)), tickMs);
    void this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.d.runner.abort();
  }

  kick(): Promise<void> {
    if (this.loop) {
      this.again = true;
      return this.loop;
    }
    this.loop = (async () => {
      // Nhường một nhịp: nếu không, khi hàng đợi rỗng hàm chạy xong ngay (đồng bộ) và `finally` đặt loop = null
      // TRƯỚC khi lệnh gán `this.loop = …` chạy → loop kẹt ở promise đã xong, các lượt sau không bao giờ chạy.
      await Promise.resolve();
      try {
        do {
          this.again = false;
          for (;;) {
            if (this.stopped) return;
            const run = this.d.jobs.nextQueuedRun();
            if (!run) break;
            await this.execute(run).catch((err) => log.error(`Lượt ${run.id} lỗi ngoài dự kiến`, err));
          }
        } while (this.again);
      } finally {
        this.loop = null;
      }
    })();
    return this.loop;
  }

  /** Chờ hàng đợi chạy hết (dùng trong test). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private async execute(run: RunRow): Promise<void> {
    const { jobs, cfg } = this.d;
    const job = jobs.getJob(run.job_id)!;
    const brief = JSON.parse(job.brief_json!) as Brief;
    const args = JSON.parse(run.args_json) as RunArgs;
    if ((run.kind === 'create' || run.kind === 'edit') && !jobs.transition(job.id, ['queued'], 'running')) {
      jobs.updateRun(run.id, { status: 'failed', outcome: 'skipped', error: `job ở trạng thái ${job.status}`, finished_at: new Date().toISOString() });
      return;
    }
    const token = randomBytes(32).toString('hex');
    const active: ActiveRun = { run, jobId: job.id, kind: run.kind, token, outcome: null, startedAt: Date.now(), lastProgressAt: 0 };
    this.active = active;
    jobs.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });
    jobs.event(job.id, 'bridge', 'run_start', { run: run.id, kind: run.kind });

    const extra = this.extra(job);
    const prompt = buildPrompt({
      runId: run.id,
      kind: run.kind,
      job,
      brief,
      expected: expectedFor(brief, cfg.account, new Date(job.created_at)),
      acc: cfg.account,
      limits: cfg.limits,
      args: { ...args, campId: args.campId ?? (extra.campId as string | undefined) },
      previous: job.result_json ? (JSON.parse(job.result_json) as DraftsPayload) : null,
      leftovers: (extra.leftovers as string[] | undefined) ?? [],
      managedActiveCampaignIds: this.isDry(job) ? [] : this.managedActiveCampaignIds(job.id),
      dry: this.isDry(job),
    });
    if (run.kind === 'create' || run.kind === 'edit') await this.progressText(job, `Claude bắt đầu ${KIND_LABEL[run.kind]}…`);

    let res: RunResult;
    try {
      res = await this.d.runner.run({ runId: run.id, jobId: job.id, kind: run.kind, prompt, token, mcpUrl: `${this.d.mcpBase()}/job-mcp/${token}`, dry: this.isDry(job) });
    } catch (err) {
      res = { exitCode: null, timedOut: false, killed: false, json: null, stderrTail: (err as Error).message, logFile: '' };
    }
    this.active = null;
    const outcome = active.outcome ?? (res.timedOut ? 'timeout' : this.stopped ? 'interrupted' : 'no_report');
    const ok = ['drafts', 'activated', 'cancelled', 'choice'].includes(outcome);
    jobs.updateRun(run.id, {
      status: ok ? 'done' : 'failed',
      outcome,
      session_id: res.json?.session_id ?? null,
      cost_usd: res.json?.total_cost_usd ?? null,
      num_turns: res.json?.num_turns ?? null,
      denials_json: res.json?.permission_denials?.length ? JSON.stringify(res.json.permission_denials.map((p) => p.tool_name)) : null,
      error: ok ? null : active.outcome ? `${active.outcome} (Claude đã báo qua tool)` : this.describeExit(res),
      log_file: res.logFile || null,
      finished_at: new Date().toISOString(),
    });
    jobs.event(job.id, 'bridge', 'run_end', { run: run.id, kind: run.kind, outcome, turns: res.json?.num_turns, cost_usd: res.json?.total_cost_usd });
    await this.auditAfterRun(run, args, res).catch((err) => log.error(`Audit lượt ${run.id} lỗi`, err));
    if (!active.outcome && !this.stopped) await this.noReport(run, res);
  }

  /** Đọc nhật ký phiên của lượt vừa chạy, ghi lại mọi lần ghi dữ liệu; có bất thường thì báo 🔴 và khoá brief. */
  private async auditAfterRun(run: RunRow, args: RunArgs, res: RunResult): Promise<void> {
    const job = this.d.jobs.getJob(run.job_id)!;
    const p = job.result_json ? (JSON.parse(job.result_json) as DraftsPayload) : null;
    const ownIds = p
      ? [...(p.campaign.existing ? [] : [p.campaign.id]), ...(p.adset.existing ? [] : [p.adset.id]), ...p.ads.flatMap((a) => [a.id, a.creative_id])]
      : [];
    const approvedIds =
      run.kind === 'activate' && p
        ? [
            ...(p.campaign.existing ? [] : [p.campaign.id]),
            ...(p.adset.existing ? [] : [p.adset.id]),
            ...p.ads.filter((a) => args.variants === 'all' || !args.variants || (a.variant !== null && args.variants.includes(a.variant))).map((a) => a.id),
          ]
        : undefined;
    const workDir = path.join(this.d.cfg.runDir, `run-${run.id}`);
    const audit = auditRun(workDir, res.json?.session_id, { kind: run.kind, ownIds, approvedIds });
    this.d.jobs.updateRun(run.id, { audit_json: JSON.stringify(audit) });
    if (!audit.found) {
      log.warn(`Lượt ${run.id}: không đọc được nhật ký phiên để soát lại (session ${res.json?.session_id ?? '?'})`);
      return;
    }
    if (!audit.anomalies.length) return;
    this.d.jobs.event(job.id, 'bridge', 'audit_anomaly', audit);
    let locked = '';
    if (job.status === 'pending_approval' && this.d.jobs.transition(job.id, ['pending_approval'], 'failed', { button_version: job.button_version + 1, error: `audit: ${audit.anomalies.join(' | ')}` })) {
      locked = '\nĐã khoá brief này (gỡ nút duyệt) — không bật được cho tới khi kiểm tra xong.';
      if (job.approval_text) await this.edit(job.approval_message_id, restamp(job.approval_text, `⛔ <b>BỊ KHOÁ</b> · brief #${job.id}`, '⛔ Soát lại lượt chạy thấy thao tác ngoài phạm vi — xem tin cảnh báo.')).catch(() => {});
    }
    await this.send(
      `🔴 <b>Brief #${job.id}</b>: soát lại lượt ${KIND_LABEL[run.kind]} thấy thao tác NGOÀI PHẠM VI:\n${audit.anomalies.map((a) => `• ${esc(a)}`).join('\n')}${locked}\nKiểm tra Shopify / Ads Manager. Nhật ký: ${esc(res.logFile || `run-${run.id}`)}`,
      { replyTo: job.approval_message_id ?? job.status_message_id },
    );
  }

  private describeExit(res: RunResult): string {
    const parts: string[] = [];
    if (res.timedOut) parts.push(`quá ${this.d.cfg.timeoutMin} phút`);
    else if (res.exitCode !== 0) parts.push(`claude thoát mã ${res.exitCode}`);
    if (res.json?.is_error || res.json?.subtype?.startsWith('error')) parts.push(`Claude báo: ${(res.json.result ?? res.json.subtype ?? '').slice(0, 300)}`);
    else if (res.json?.result) parts.push(`Claude dừng mà không gọi submit / report_failure: "${res.json.result.slice(0, 300)}"`);
    if (!res.json && res.stderrTail.trim()) parts.push(res.stderrTail.trim().slice(-300));
    const denied = res.json?.permission_denials?.map((p) => p.tool_name) ?? [];
    if (denied.length) parts.push(`tool bị chặn: ${[...new Set(denied)].join(', ')}`);
    return parts.join(' · ') || 'không rõ lý do';
  }

  private async noReport(run: RunRow, res: RunResult): Promise<void> {
    const job = this.d.jobs.getJob(run.job_id)!;
    const from: JobStatus[] = run.kind === 'activate' ? ['activating'] : run.kind === 'cancel' ? ['cancelling'] : ['running'];
    const why = this.describeExit(res);
    this.d.jobs.transition(job.id, from, 'failed', { error: why });
    const hint =
      run.kind === 'activate'
        ? 'Không rõ đã bật xong chưa — kiểm tra Ads Manager trước khi chạy lại.'
        : run.kind === 'cancel'
          ? 'Bản nháp có thể còn trong Ads Manager.'
          : 'Có thể còn bản nháp dở trong Ads Manager (lượt chạy lại sẽ tự dọn).';
    await this.send(`🔴 <b>Brief #${job.id}</b>: lượt ${KIND_LABEL[run.kind]} dừng giữa chừng.\n${esc(why)}\n${hint}\nGõ /retry ${job.id} để chạy lại.`, {
      replyTo: job.approval_message_id ?? job.status_message_id,
    });
  }

  private recoverInterrupted(): void {
    for (const run of this.d.jobs.runningRuns()) {
      this.d.jobs.updateRun(run.id, { status: 'failed', outcome: 'interrupted', error: 'bridge khởi động lại khi lượt đang chạy', finished_at: new Date().toISOString() });
      const from: JobStatus[] = run.kind === 'activate' ? ['activating'] : run.kind === 'cancel' ? ['cancelling'] : ['running'];
      this.d.jobs.transition(run.job_id, from, 'failed', { error: 'bridge khởi động lại khi lượt đang chạy' });
      void this.send(`⚠ Bridge vừa khởi động lại khi brief #${run.job_id} đang ${KIND_LABEL[run.kind]}. Gõ /retry ${run.job_id} để chạy lại.`).catch(() => {});
    }
  }

  private async retry(jobId: number, replyTo: number): Promise<void> {
    const r = await this.retryCore(jobId, replyTo, 'Telegram');
    if (!r.ok) await this.send(esc(r.message), { replyTo });
  }

  /** Chạy lại brief lỗi từ trang quản lý (/ui). Tin "🔁 Chạy lại" vẫn gửi lên Telegram để chủ shop theo dõi. */
  retryFromUi(jobId: number): Promise<{ ok: boolean; message: string }> {
    return this.retryCore(jobId, null, 'trang quản lý');
  }

  private async retryCore(jobId: number, replyTo: number | null, via: string): Promise<{ ok: boolean; message: string }> {
    const job = Number.isFinite(jobId) ? this.d.jobs.getJob(jobId) : undefined;
    if (!job) return { ok: false, message: 'Cú pháp: /retry {số brief}, ví dụ /retry 12' };
    if (job.status !== 'failed') return { ok: false, message: `Brief #${job.id} đang ${STATUS_LABEL[job.status]} — không cần chạy lại.` };
    const last = this.d.jobs.runsForJob(job.id).at(-1);
    const kind: RunKind = last?.kind ?? 'create';
    const args = { ...(last ? (JSON.parse(last.args_json) as RunArgs) : {}), retry: true };
    const to: JobStatus = kind === 'activate' ? 'activating' : kind === 'cancel' ? 'cancelling' : 'queued';
    if (!this.d.jobs.transition(job.id, ['failed'], to, { error: null })) return { ok: false, message: `Brief #${job.id} vừa đổi trạng thái, thử lại.` };
    this.d.jobs.event(job.id, 'owner', 'retry', { kind, via });
    const msgId = await this.send(`🔁 Chạy lại brief #${job.id} (lượt ${KIND_LABEL[kind]}, từ ${esc(via)})…`, { replyTo });
    if (kind === 'create' || kind === 'edit') this.d.jobs.updateJob(job.id, { status_message_id: msgId });
    this.queue(job.id, kind, args);
    return { ok: true, message: `Đã xếp lượt ${KIND_LABEL[kind]} cho brief #${job.id}.` };
  }

  /** Gửi một tin chữ thường lên Telegram (trang quản lý dùng để báo đổi chế độ). */
  notify(text: string): Promise<number> {
    return this.send(esc(text));
  }

  // ======================================================================
  // Nhắc / tự huỷ
  // ======================================================================

  async tick(): Promise<void> {
    const { jobs, cfg } = this.d;
    const nowMs = this.now().getTime();
    for (const job of jobs.jobsByStatus(['pending_approval'])) {
      const age = nowMs - Date.parse(job.approval_sent_at ?? job.updated_at);
      if (age >= cfg.limits.autoCancelAfterH * 3600_000) {
        if (!jobs.transition(job.id, ['pending_approval'], 'cancelling', { button_version: job.button_version + 1 })) continue;
        jobs.event(job.id, 'bridge', 'auto_cancel');
        if (this.isDry(job)) {
          await this.simulateCancel(job.id, true);
          continue;
        }
        await this.edit(job.approval_message_id, `${job.approval_text}\n\n⏳ Quá ${cfg.limits.autoCancelAfterH} giờ chưa duyệt — đang tự huỷ bản nháp…`);
        this.queue(job.id, 'cancel', { auto: true });
      } else if (age >= cfg.limits.remindAfterH * 3600_000 && !job.reminded_at) {
        jobs.updateJob(job.id, { reminded_at: new Date(nowMs).toISOString() });
        await this.send(`⏰ Brief #${job.id} chờ duyệt đã ${cfg.limits.remindAfterH} giờ. Quá ${cfg.limits.autoCancelAfterH} giờ chưa duyệt sẽ tự huỷ bản nháp.`, { replyTo: job.approval_message_id });
      }
    }
    for (const job of jobs.jobsByStatus(['confirm', 'choosing'])) {
      if (nowMs - Date.parse(job.updated_at) < cfg.limits.autoCancelAfterH * 3600_000) continue;
      if (!jobs.transition(job.id, ['confirm', 'choosing'], 'cancelled', { button_version: job.button_version + 1 })) continue;
      await this.send(`⚪ Brief #${job.id} chờ trả lời quá ${cfg.limits.autoCancelAfterH} giờ — đã huỷ (chưa tạo gì trên Meta).`, { replyTo: job.status_message_id });
    }
  }

  // ======================================================================
  // Xử lý tool của lượt chạy (gọi từ tools.ts)
  // ======================================================================

  runForToken(token: string): ActiveRun | null {
    const a = this.active;
    if (!a) return null;
    const x = Buffer.from(token);
    const y = Buffer.from(a.token);
    return x.length === y.length && timingSafeEqual(x, y) ? a : null;
  }

  jobContext(a: ActiveRun): Record<string, unknown> {
    const job = this.d.jobs.getJob(a.jobId)!;
    const brief = JSON.parse(job.brief_json!) as Brief;
    return {
      brief_id: job.id,
      run_kind: a.kind,
      raw_text: job.raw_text,
      brief,
      expected: expectedFor(brief, this.d.cfg.account, new Date(job.created_at)),
      account: this.d.cfg.account,
      limits: this.d.cfg.limits,
      current_drafts: job.result_json ? JSON.parse(job.result_json) : null,
      args: JSON.parse(a.run.args_json),
    };
  }

  async onProgress(a: ActiveRun, text: string): Promise<void> {
    if (Date.now() - a.lastProgressAt < 3000) return;
    a.lastProgressAt = Date.now();
    const job = this.d.jobs.getJob(a.jobId)!;
    this.d.jobs.event(job.id, 'claude', 'progress', text);
    if (a.kind === 'create' || a.kind === 'edit') await this.progressText(job, text);
  }

  private async progressText(job: JobRow, text: string): Promise<void> {
    const brief = job.brief_json ? (JSON.parse(job.brief_json) as Brief) : null;
    const html = `⏳ <b>Brief #${job.id}</b> (${esc(briefTitle(job, brief, this.d.cfg.account))})\n${esc(text.slice(0, 500))}`;
    const id = await this.edit(job.status_message_id, html).catch(() => null);
    if (id && id !== job.status_message_id) this.d.jobs.updateJob(job.id, { status_message_id: id });
  }

  checkCopy(variants: CopyVariant[], pageText: string): { ok: boolean; issues: Record<string, string[]> } {
    const issues = copyIssues(variants, pageText);
    return { ok: !Object.keys(issues).length, issues };
  }

  async onCheckBudget(a: ActiveRun, campaigns: Array<{ id: string; daily_budget_cents: number | null; effective_status: string }>): Promise<Record<string, unknown>> {
    const job = this.d.jobs.getJob(a.jobId)!;
    const brief = JSON.parse(job.brief_json!) as Brief;
    if (brief.type !== 'NEW') return { ok: true, note: '#ADD không thêm budget campaign' };
    const ids = this.managedActiveCampaignIds(job.id);
    const missing = ids.filter((id) => !campaigns.some((c) => c.id === id));
    if (missing.length) return { ok: false, error: `Thiếu campaign: ${missing.join(', ')} — đọc đủ rồi gọi lại` };
    const liveUsd = campaigns.filter((c) => ids.includes(c.id) && LIVE_OK.test(c.effective_status)).reduce((s, c) => s + (c.daily_budget_cents ?? 0), 0) / 100;
    const pendingUsd = this.pendingBudgetUsd(job.id);
    const total = liveUsd + pendingUsd;
    const limit = this.d.cfg.limits.totalBudgetUsd;
    if (total + brief.budgetUsd > limit) {
      a.outcome = 'rejected';
      const why = `Tổng budget/ngày các camp bridge đang quản lý là $${fmt(total)} (đang chạy $${fmt(liveUsd)} + chờ duyệt $${fmt(pendingUsd)}); thêm $${fmt(brief.budgetUsd)} sẽ vượt giới hạn $${fmt(limit)}.`;
      this.d.jobs.transition(job.id, ['running'], 'rejected', { error: why });
      this.d.jobs.event(job.id, 'bridge', 'reject_budget', why);
      await this.send(`⛔ <b>Brief #${job.id} bị từ chối</b>\n${esc(why)}\nKhông tạo gì trên Meta.`, { replyTo: job.status_message_id });
      return { ok: false, stop: true, message: 'Vượt trần ngân sách — DỪNG NGAY, không tạo gì, không gọi thêm tool.' };
    }
    return { ok: true, total_managed_usd: total, new_budget_usd: brief.budgetUsd, limit_usd: limit };
  }

  async onSubmitDrafts(a: ActiveRun, p: DraftsPayload): Promise<{ ok: boolean; errors?: string[]; message?: string }> {
    if (a.outcome) return { ok: false, errors: [`Lượt này đã báo kết quả (${a.outcome}) — dừng lại.`] };
    const { jobs, cfg } = this.d;
    const job = jobs.getJob(a.jobId)!;
    const brief = JSON.parse(job.brief_json!) as Brief;
    const errors = validateDrafts(brief, expectedFor(brief, cfg.account, new Date(job.created_at)), p, cfg.limits);
    if (errors.length) {
      jobs.event(job.id, 'bridge', 'drafts_rejected', errors);
      return { ok: false, errors };
    }
    a.outcome = 'drafts';
    const version = job.button_version + 1;
    const text = composeApproval(job, brief, p, cfg.account, { dry: this.isDry(job) });
    const msgId = await this.send(text, { markup: approvalKeyboard(cfg.callbackSecret, job.id, version, p.variants.length) });
    if (a.kind === 'edit' && job.approval_message_id && job.approval_text) {
      await this.edit(job.approval_message_id, restamp(job.approval_text, `✏️ <b>ĐÃ SỬA</b> · brief #${job.id}`, '↓ Xem tin duyệt mới bên dưới.')).catch(() => {});
    }
    jobs.transition(job.id, ['running'], 'pending_approval', {
      result_json: JSON.stringify(p),
      approval_message_id: msgId,
      approval_text: text,
      button_version: version,
      approval_sent_at: new Date().toISOString(),
      reminded_at: null,
      edit_prompt_message_id: null,
      error: null,
      extra_json: JSON.stringify({ ...this.extra(job), leftovers: [] }),
    });
    jobs.event(job.id, 'claude', 'drafts', { campaign: p.campaign.id, adset: p.adset.id, ads: p.ads.map((x) => x.id) });
    await this.edit(job.status_message_id, `✅ <b>Brief #${job.id}</b>: bản nháp xong — tin duyệt ở dưới.`).catch(() => {});
    return { ok: true, message: 'Đã gửi tin duyệt cho chủ shop. Kết thúc lượt chạy ngay, không gọi thêm tool.' };
  }

  async onSubmitActivation(a: ActiveRun, p: ActivationPayload): Promise<{ ok: boolean; message: string }> {
    if (a.outcome) return { ok: false, message: `Lượt này đã báo kết quả (${a.outcome}).` };
    a.outcome = 'activated';
    const job = this.d.jobs.getJob(a.jobId)!;
    const allOk = p.results.every((r) => r.ok) && !p.errors.length;
    this.d.jobs.transition(job.id, ['activating'], allOk ? 'active' : 'failed', { activation_json: JSON.stringify(p), error: allOk ? null : (p.errors.join(' | ') || 'có object chưa bật được') });
    this.d.jobs.event(job.id, 'claude', 'activation', p);
    const lines = p.results.map((r) => `• ${r.level} <code>${esc(r.id)}</code> · ${esc(r.effective_status)}${r.ok ? '' : ' ❌'}${r.note ? ` — ${esc(r.note)}` : ''}`);
    const label = (JSON.parse(a.run.args_json) as RunArgs).label ?? 'Duyệt & chạy';
    const tail = [
      `${allOk ? '✅' : '⚠'} ${esc(label)} — xong lúc ${formatDateTime(this.now())}:`,
      ...lines,
      ...(p.discarded.length ? [`Đã bỏ bản nháp phương án không chọn: ${p.discarded.map((x) => `<code>${esc(x)}</code>`).join(', ')}`] : []),
      ...p.errors.map((e) => `❌ ${esc(e)}`),
      ...(allOk ? [] : [`Gõ /retry ${job.id} để chạy lại lượt bật (kiểm tra Ads Manager trước).`]),
    ].join('\n');
    await this.edit(job.approval_message_id, restamp(job.approval_text ?? '', allOk ? `🟢 <b>ĐANG CHẠY</b> · brief #${job.id}` : `🟠 <b>BẬT CHƯA XONG</b> · brief #${job.id}`, tail));
    return { ok: true, message: 'Đã ghi kết quả và báo chủ shop. Kết thúc lượt chạy, không gọi thêm tool.' };
  }

  async onSubmitCancel(a: ActiveRun, p: CancelPayload): Promise<{ ok: boolean; message: string }> {
    if (a.outcome) return { ok: false, message: `Lượt này đã báo kết quả (${a.outcome}).` };
    a.outcome = 'cancelled';
    const job = this.d.jobs.getJob(a.jobId)!;
    this.d.jobs.transition(job.id, ['cancelling'], 'cancelled', { extra_json: JSON.stringify({ ...this.extra(job), leftovers: p.leftovers }) });
    this.d.jobs.event(job.id, 'claude', 'cancelled', p);
    const auto = (JSON.parse(a.run.args_json) as RunArgs).auto;
    const tail = [
      `${auto ? `Tự huỷ sau ${this.d.cfg.limits.autoCancelAfterH} giờ chưa duyệt` : 'Đã huỷ'} lúc ${formatDateTime(this.now())} — đã xoá ${p.removed.length} object.`,
      ...(p.leftovers.length ? [`⚠ Còn sót: ${p.leftovers.map((x) => `<code>${esc(x)}</code>`).join(', ')}${p.note ? ` — ${esc(p.note)}` : ''}`] : p.note ? [esc(p.note)] : []),
    ].join('\n');
    await this.edit(job.approval_message_id, restamp(job.approval_text ?? '', `⚪ <b>ĐÃ HUỶ</b> · brief #${job.id}`, tail));
    return { ok: true, message: 'Đã ghi kết quả. Kết thúc lượt chạy, không gọi thêm tool.' };
  }

  async onNeedChoice(a: ActiveRun, question: string, options: Array<{ id: string; label: string }>): Promise<{ ok: boolean; message: string }> {
    if (a.outcome) return { ok: false, message: `Lượt này đã báo kết quả (${a.outcome}).` };
    const job = this.d.jobs.getJob(a.jobId)!;
    if (job.type !== 'ADD') return { ok: false, message: 'need_choice chỉ dùng cho #ADD khi Camp khớp nhiều campaign' };
    a.outcome = 'choice';
    const version = job.button_version + 1;
    this.d.jobs.transition(job.id, ['running'], 'choosing', { button_version: version, extra_json: JSON.stringify({ ...this.extra(job), choices: options }) });
    this.d.jobs.event(job.id, 'claude', 'need_choice', options);
    const msgId = await this.send(`🔎 <b>Brief #${job.id}</b>: ${esc(question)}\n\n${options.map((o, i) => `${i + 1}. ${esc(o.label)} · <code>${esc(o.id)}</code>`).join('\n')}`, {
      markup: choiceKeyboard(this.d.cfg.callbackSecret, job.id, version, options),
      replyTo: job.status_message_id,
    });
    this.d.jobs.updateJob(job.id, { status_message_id: msgId });
    return { ok: true, message: 'Đã gửi danh sách cho chủ shop chọn. Kết thúc lượt chạy ngay, không tạo gì.' };
  }

  async onFailure(a: ActiveRun, p: FailurePayload): Promise<{ ok: boolean; message: string }> {
    if (a.outcome) return { ok: false, message: `Lượt này đã báo kết quả (${a.outcome}).` };
    a.outcome = 'failure';
    const { jobs } = this.d;
    const job = jobs.getJob(a.jobId)!;
    const extra = { ...this.extra(job), leftovers: p.leftover_ids };
    jobs.event(job.id, 'claude', 'failure', p);
    const metaLine = p.meta_error ? `\nMeta: <code>${esc(p.meta_error.slice(0, 800))}</code>` : '';
    const leftLine = p.leftover_ids.length ? `\n⚠ Còn sót trong Ads Manager: ${p.leftover_ids.map((x) => `<code>${esc(x)}</code>`).join(', ')}` : '';

    if (a.kind === 'edit' && job.result_json) {
      // Sửa copy lỗi: bản nháp cũ vẫn còn → gửi lại tin duyệt bản cũ để chủ shop duyệt hoặc thử sửa lần nữa.
      const prev = JSON.parse(job.result_json) as DraftsPayload;
      const brief = JSON.parse(job.brief_json!) as Brief;
      const version = job.button_version + 1;
      const text = composeApproval(job, brief, prev, this.d.cfg.account, { dry: this.isDry(job) });
      await this.send(`🔴 <b>Brief #${job.id}</b>: sửa copy không xong — ${esc(p.reason)}${metaLine}${leftLine}\nBản nháp cũ vẫn giữ nguyên, tin duyệt gửi lại bên dưới.`, { replyTo: job.status_message_id });
      const msgId = await this.send(text, { markup: approvalKeyboard(this.d.cfg.callbackSecret, job.id, version, prev.variants.length) });
      jobs.transition(job.id, ['running'], 'pending_approval', { approval_message_id: msgId, approval_text: text, button_version: version, approval_sent_at: new Date().toISOString(), extra_json: JSON.stringify(extra) });
      return { ok: true, message: 'Đã báo chủ shop. Kết thúc lượt chạy.' };
    }

    const from: JobStatus[] = a.kind === 'activate' ? ['activating'] : a.kind === 'cancel' ? ['cancelling'] : ['running'];
    const to: JobStatus = a.kind === 'create' && !p.retryable ? 'rejected' : 'failed';
    jobs.transition(job.id, from, to, { error: p.reason, extra_json: JSON.stringify(extra) });
    const retryLine = to === 'failed' ? `\n\nSửa xong thì gõ /retry ${job.id}.` : '';
    const html = `🔴 <b>Brief #${job.id}</b> — lượt ${KIND_LABEL[a.kind]} lỗi:\n${esc(p.reason)}${metaLine}${leftLine}${retryLine}`;
    if ((a.kind === 'activate' || a.kind === 'cancel') && job.approval_text) {
      await this.edit(job.approval_message_id, restamp(job.approval_text, `🔴 <b>LỖI KHI ${a.kind === 'activate' ? 'BẬT' : 'HUỶ'}</b> · brief #${job.id}`, html));
    } else {
      await this.send(html, { replyTo: job.status_message_id });
    }
    return { ok: true, message: 'Đã báo chủ shop. Kết thúc lượt chạy.' };
  }

  // ======================================================================
  // Số liệu
  // ======================================================================

  /** Bridge bật CLAUDE_DRY_RUN thì MỌI job (kể cả job cũ /retry) đều chạy thử; job tạo lúc chạy thử thì luôn là chạy thử. */
  isDry(job: JobRow): boolean {
    return this.d.cfg.dryRun === true || this.extra(job).dry === true;
  }

  /** Chạy thử: ghi nhận duyệt, KHÔNG gọi Meta; tin duyệt ghi rõ khi chạy thật sẽ publish những gì. */
  private async simulateActivation(jobId: number, variants: number[] | 'all', label: string): Promise<void> {
    const job = this.d.jobs.getJob(jobId)!;
    const p = JSON.parse(job.result_json!) as DraftsPayload;
    const ads = p.ads.filter((a) => variants === 'all' || (a.variant !== null && variants.includes(a.variant)));
    const results: ActivationPayload['results'] = [
      ...(p.campaign.existing ? [] : [{ id: p.campaign.id, level: 'campaign' as const, effective_status: 'DRY_RUN', ok: true }]),
      ...(p.adset.existing ? [] : [{ id: p.adset.id, level: 'ad_set' as const, effective_status: 'DRY_RUN', ok: true }]),
      ...ads.map((a) => ({ id: a.id, level: 'ad' as const, effective_status: 'DRY_RUN', ok: true })),
    ];
    const discarded = p.ads.filter((a) => !ads.includes(a)).map((a) => a.id);
    this.d.jobs.transition(jobId, ['activating'], 'active', { activation_json: JSON.stringify({ results, discarded, errors: [], dry: true }) });
    this.d.jobs.event(jobId, 'bridge', 'dry_activation', { variants, results, discarded });
    const tail = [
      `🧪 ${esc(label)} lúc ${formatDateTime(this.now())} — CHẠY THỬ, không bật gì trên Meta.`,
      `Khi chạy thật, lượt bật sẽ publish: ${results.map((r) => `${r.level} <code>${esc(r.id)}</code>`).join(', ')}${discarded.length ? `; bỏ nháp phương án không chọn: ${discarded.map((x) => `<code>${esc(x)}</code>`).join(', ')}` : ''}.`,
    ].join('\n');
    await this.edit(job.approval_message_id, restamp(job.approval_text ?? '', `🟢 <b>ĐÃ DUYỆT (CHẠY THỬ)</b> · brief #${jobId}`, tail));
  }

  private async simulateCancel(jobId: number, auto: boolean): Promise<void> {
    const job = this.d.jobs.getJob(jobId)!;
    this.d.jobs.transition(jobId, ['cancelling'], 'cancelled');
    this.d.jobs.event(jobId, 'bridge', 'dry_cancel', { auto });
    // Bản nháp tạo lúc còn chạy thật (ID không phải DRY-…) mà giờ bridge chạy thử → không xoá trên Meta, nói rõ để chủ shop tự xoá.
    const p = job.result_json ? (JSON.parse(job.result_json) as DraftsPayload) : null;
    const real = p && !String(p.campaign.id).startsWith('DRY-') && !p.campaign.existing;
    const tail = `🧪 ${auto ? `Tự huỷ sau ${this.d.cfg.limits.autoCancelAfterH} giờ chưa duyệt` : 'Huỷ'} lúc ${formatDateTime(this.now())} — CHẠY THỬ, không xoá gì trên Meta.${real ? `\n⚠ Bản nháp thật (camp <code>${esc(p!.campaign.id)}</code>) được tạo lúc còn chạy thật vẫn nằm trong Ads Manager — xoá tay nếu không dùng.` : ''}`;
    await this.edit(job.approval_message_id, restamp(job.approval_text ?? '', `⚪ <b>ĐÃ HUỶ (CHẠY THỬ)</b> · brief #${jobId}`, tail));
  }

  private extra(job: JobRow): Record<string, unknown> {
    try {
      return JSON.parse(job.extra_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Budget/ngày của các brief #NEW chưa lên chạy (đang chờ, đang dựng, chờ duyệt, đang bật). */
  pendingBudgetUsd(excludeJobId: number | null): number {
    return this.d.jobs
      .jobsByStatus(['confirm', 'queued', 'running', 'pending_approval', 'activating'])
      .filter((j) => j.type === 'NEW' && j.id !== excludeJobId)
      .reduce((s, j) => s + (j.budget_usd ?? 0), 0);
  }

  /** ID live của các campaign #NEW bridge đã bật (để Claude đọc budget thật trước khi tạo camp mới). */
  managedActiveCampaignIds(excludeJobId: number): string[] {
    const out: string[] = [];
    for (const j of this.d.jobs.jobsByStatus(['active'])) {
      if (j.type !== 'NEW' || j.id === excludeJobId || this.isDry(j)) continue;
      const act = j.activation_json ? (JSON.parse(j.activation_json) as ActivationPayload) : null;
      const live = act?.results.find((r) => r.level === 'campaign')?.id;
      const draft = j.result_json ? (JSON.parse(j.result_json) as DraftsPayload).campaign.id : null;
      const id = live ?? draft;
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  statusText(): string {
    const { jobs } = this.d;
    const open = jobs.jobsByStatus(OPEN_STATUSES);
    const lines = ['<b>Brief đang xử lý</b>'];
    if (!open.length) lines.push('(không có)');
    for (const j of open) {
      const brief = j.brief_json ? (JSON.parse(j.brief_json) as Brief) : null;
      lines.push(`#${j.id} · ${esc(briefTitle(j, brief, this.d.cfg.account))} · ${STATUS_LABEL[j.status]}`);
    }
    const a = this.active;
    lines.push('');
    lines.push(a ? `Claude đang chạy: brief #${a.jobId}, lượt ${KIND_LABEL[a.kind]}, ${Math.round((Date.now() - a.startedAt) / 60000)} phút` : 'Claude: rảnh');
    const q = jobs.queuedCount();
    if (q) lines.push(`Hàng đợi: ${q} lượt`);
    const recent = jobs.lastJobs(8).filter((j) => !OPEN_STATUSES.includes(j.status)).slice(0, 5);
    if (recent.length) {
      lines.push('');
      lines.push('<b>Gần đây</b>');
      for (const j of recent) {
        const brief = j.brief_json ? (JSON.parse(j.brief_json) as Brief) : null;
        lines.push(`#${j.id} · ${esc(briefTitle(j, brief, this.d.cfg.account))} · ${STATUS_LABEL[j.status]}`);
      }
    }
    return lines.join('\n');
  }

  summary(): Record<string, unknown> {
    const open = this.d.jobs.jobsByStatus(OPEN_STATUSES);
    const a = this.active;
    return {
      ok: true,
      mode: 'claude',
      running: a ? { brief: a.jobId, kind: a.kind, minutes: Math.round((Date.now() - a.startedAt) / 60000) } : null,
      queued_runs: this.d.jobs.queuedCount(),
      open_briefs: open.map((j) => ({ id: j.id, type: j.type, status: j.status })),
    };
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
