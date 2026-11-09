// Điều phối tin từ bridge: brief #NEW/#ADD, lệnh /retry /status, trả lời "Sửa gì?", và các nút bấm.

import type { Deps, RequestContext } from './pipeline/types.ts';
import type { Runner } from './pipeline/runner.ts';
import type { TgCallbackQuery, TgMessage, TgUpdate } from '../shared/telegram.ts';
import { escapeHtml } from '../shared/telegram.ts';
import { detectCommand, parseBrief } from './brief/parse.ts';
import { checkNewBrief, findDuplicate, managedDailyBudgetUsd } from './safety.ts';
import { verifyCallback, signCallback } from './callbacks.ts';
import { approve, cancel, startEdit, errText } from './approval.ts';
import { MetaTokenError } from './meta/graph.ts';
import { formatDate, TZ_VN } from '../shared/time.ts';
import { TERMINAL } from './db.ts';
import { logger } from '../shared/log.ts';

const log = logger('app');

export interface HandleResult {
  handled: boolean;
}

export class AgentApp {
  private readonly deps: Deps;
  readonly runner: Runner;
  private locks = new Map<number, Promise<unknown>>();

  constructor(deps: Deps, runner: Runner) {
    this.deps = deps;
    this.runner = runner;
  }

  private allowed(chatId: number | undefined): boolean {
    return chatId !== undefined && this.deps.cfg.tgAllowedChatIds.includes(chatId);
  }

  /** Chạy tuần tự các thao tác trên cùng một brief (tránh bấm hai nút cùng lúc). */
  private withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => {}));
    return next;
  }

  async handleUpdate(update: TgUpdate): Promise<HandleResult> {
    const id = update.update_id;
    if (typeof id === 'number' && !this.deps.store.claimUpdate(id)) return { handled: true };
    try {
      return await this.route(update);
    } catch (err) {
      if (typeof id === 'number') this.deps.store.releaseUpdate(id); // để bridge gửi lại được
      throw err;
    }
  }

  private async route(update: TgUpdate): Promise<HandleResult> {
    if (update.callback_query) return this.onCallback(update.callback_query);
    const msg = update.message;
    if (!msg) return { handled: false };
    if (!this.allowed(msg.chat.id)) {
      this.deps.store.audit('unknown', 'ignored_chat', { detail: { chat_id: msg.chat.id, from: msg.from?.id } });
      return { handled: true };
    }
    const text = (msg.text ?? msg.caption ?? '').trim();
    if (detectCommand(text)) return this.onBrief(msg, text);
    if (text.startsWith('/')) return this.onCommand(msg, text);
    if (msg.reply_to_message) return this.onReply(msg, text);
    return { handled: false };
  }

  private send(chatId: number, html: string, extra: Parameters<Deps['tg']['sendMessage']>[2] = {}) {
    return this.deps.tg.sendMessage(chatId, html, { parse_mode: 'HTML', disable_preview: true, ...extra });
  }

  // ---------------- Brief ----------------
  private async onBrief(msg: TgMessage, text: string): Promise<HandleResult> {
    const { store, cfg, meta } = this.deps;
    const type = detectCommand(text)!;
    const req = store.createRequest({ type, raw_text: text, chat_id: msg.chat.id, brief_message_id: msg.message_id });
    store.audit('owner', 'brief_received', { requestId: req.id, detail: { type, message_id: msg.message_id } });

    const acct = store.getAccount(cfg.account.name)!;
    const now = this.deps.now?.() ?? new Date();
    const res = parseBrief(text, {
      accountNames: store.listAccountNames(),
      pageId: acct.page_id,
      shopDomain: cfg.shopify.publicDomain,
      timezone: acct.timezone,
      now,
    });
    if (!res.brief) {
      store.updateRequest(req.id, { status: 'failed', error: res.errors.join('\n') });
      await this.send(
        msg.chat.id,
        `❌ Brief #${req.id} chưa hợp lệ — chưa tạo gì trên Meta:\n${res.errors.map((e) => `• ${escapeHtml(e)}`).join('\n')}\n\nSửa và gửi lại brief.`,
        { reply_to_message_id: msg.message_id },
      );
      return { handled: true };
    }
    const brief = res.brief;
    const dateLabel =
      brief.type === 'NEW' && brief.startDate
        ? `${String(brief.startDate.d).padStart(2, '0')}/${String(brief.startDate.m).padStart(2, '0')}/${brief.startDate.y}`
        : formatDate(now, TZ_VN);
    store.updateRequest(req.id, {
      parsed_json: JSON.stringify(brief),
      account: brief.account,
      status: 'validated',
      product_key: brief.productHandle ?? null,
    });
    store.patchContext(req.id, {
      brief,
      warnings: res.warnings,
      dateLabel,
      productName: brief.type === 'NEW' ? brief.product : undefined,
    });

    if (this.runner.halted) {
      store.updateRequest(req.id, { status: 'waiting' });
      store.patchContext(req.id, { waitingReason: 'token' });
      await this.send(msg.chat.id, `🔴 Brief #${req.id} đã lưu nhưng Agent đang dừng vì token Meta lỗi. Cập nhật token rồi gõ <code>/retry ${req.id}</code>.`);
      return { handled: true };
    }

    // Giới hạn an toàn
    let confirm: string[] = [];
    try {
      if (brief.type === 'NEW') {
        const v = await checkNewBrief(cfg, store, meta, brief, store.getRequest(req.id)!);
        if (v.reject) {
          store.updateRequest(req.id, { status: 'failed', error: v.reject });
          await this.send(msg.chat.id, `⛔ Brief #${req.id}: ${escapeHtml(v.reject)}`, { reply_to_message_id: msg.message_id });
          return { handled: true };
        }
        confirm = v.confirm;
      } else {
        const dup = findDuplicate(cfg, store, store.getRequest(req.id)!);
        if (dup) confirm.push(`Brief này giống brief #${dup.id} gửi lúc ${dup.created_at.slice(11, 16)} UTC`);
      }
    } catch (err) {
      if (err instanceof MetaTokenError) this.runner.halted = err.ownerText;
      store.updateRequest(req.id, { status: 'failed', error: errText(err) });
      await this.send(msg.chat.id, `🔴 Brief #${req.id}: không kiểm tra được giới hạn budget trên Meta:\n<pre>${escapeHtml(errText(err))}</pre>\nGõ <code>/retry ${req.id}</code> sau khi xử lý.`);
      return { handled: true };
    }

    const warnText = res.warnings.length ? `\n⚠ ${res.warnings.map(escapeHtml).join('\n⚠ ')}` : '';
    if (confirm.length) {
      store.updateRequest(req.id, { status: 'waiting' });
      const fresh = store.getRequest(req.id)!;
      const kb = {
        inline_keyboard: [
          [
            { text: '✅ Đúng, vẫn tạo', callback_data: signCallback(cfg.callbackSecret, req.id, 'cf', fresh.approval_version) },
            { text: '❌ Không tạo', callback_data: signCallback(cfg.callbackSecret, req.id, 'cn', fresh.approval_version) },
          ],
        ],
      };
      const m = await this.send(
        msg.chat.id,
        `⚠ Brief #${req.id} cần xác nhận lần 2 trước khi tạo:\n${confirm.map((c) => `• ${escapeHtml(c)}`).join('\n')}${warnText}`,
        { reply_markup: kb, reply_to_message_id: msg.message_id },
      );
      store.patchContext(req.id, { waitingReason: 'confirm', pendingConfirm: confirm, confirmMessageId: m.message_id });
      return { handled: true };
    }

    await this.send(msg.chat.id, `📥 Đã nhận brief #${req.id} (${describeBrief(brief)}). Đang dựng ở trạng thái PAUSED, xong sẽ gửi tin duyệt.${warnText}`, {
      reply_to_message_id: msg.message_id,
    });
    void this.runner.enqueue(req.id);
    return { handled: true };
  }

  // ---------------- Lệnh ----------------
  private async onCommand(msg: TgMessage, text: string): Promise<HandleResult> {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
    if (cmd === '/retry') return this.cmdRetry(msg, args[0]);
    if (cmd === '/status') return this.cmdStatus(msg);
    if (cmd === '/help' || cmd === '/start') {
      await this.send(
        msg.chat.id,
        [
          '<b>Meta Ads Agent · Giai đoạn 1</b>',
          'Gửi brief bắt đầu bằng <code>#NEW</code> (camp mới) hoặc <code>#ADD</code> (thêm creative vào camp đang chạy).',
          'Agent dựng camp → adset → ad ở trạng thái PAUSED và chỉ bật khi bạn bấm <b>Duyệt & chạy</b>.',
          '',
          '<code>/status</code> — tình trạng Agent và các brief đang chờ',
          '<code>/retry {id}</code> — chạy lại brief từ bước hỏng',
        ].join('\n'),
      );
      return { handled: true };
    }
    return { handled: false };
  }

  private async cmdRetry(msg: TgMessage, arg: string | undefined): Promise<HandleResult> {
    const { store } = this.deps;
    const id = Number(arg?.replace('#', ''));
    const req = Number.isInteger(id) ? store.getRequest(id) : undefined;
    if (!req) {
      await this.send(msg.chat.id, 'Cú pháp: <code>/retry {id}</code> — id là số brief trong tin báo lỗi.');
      return { handled: true };
    }
    const ctx = store.getContext<RequestContext>(req.id);
    if (!['failed', 'waiting'].includes(req.status) || !ctx.brief) {
      await this.send(msg.chat.id, `Brief #${req.id} đang ở trạng thái <b>${req.status}</b>, không cần /retry.`);
      return { handled: true };
    }
    if (req.status === 'waiting' && (ctx.waitingReason === 'confirm' || ctx.waitingReason === 'campaign_choice')) {
      await this.send(msg.chat.id, `Brief #${req.id} đang chờ bạn bấm nút trong tin trước.`);
      return { handled: true };
    }
    this.runner.halted = null; // thử lại cả khi trước đó token lỗi; còn lỗi thì sẽ dừng lại ngay
    store.updateRequest(req.id, { status: 'validated', error: null });
    store.patchContext(req.id, { waitingReason: null });
    store.audit('owner', 'retry', { requestId: req.id, detail: { step: req.step } });
    await this.send(msg.chat.id, `🔁 Chạy lại brief #${req.id} từ bước <b>${req.step ?? 'đầu'}</b>…`);
    void this.runner.enqueue(req.id);
    return { handled: true };
  }

  private async cmdStatus(msg: TgMessage): Promise<HandleResult> {
    const { store, meta, cfg } = this.deps;
    const open = store.listRequestsByStatus(['validated', 'waiting', 'media_ready', 'copy_ready', 'created', 'pending_approval', 'editing', 'activating', 'received']);
    let budgetLine: string;
    try {
      budgetLine = `Tổng budget/ngày camp Agent quản lý: $${await managedDailyBudgetUsd(store, meta, cfg.account.name)} / giới hạn $${cfg.limits.totalBudgetUsd}`;
    } catch (err) {
      budgetLine = `Không đọc được budget từ Meta: ${escapeHtml(errText(err))}`;
    }
    const lines = [
      `<b>Agent</b> · ${this.runner.halted ? '🔴 đang dừng (token Meta lỗi)' : '🟢 đang chạy'} · hàng đợi ${this.runner.queueSize}`,
      budgetLine,
      '',
      open.length ? '<b>Brief chưa xong</b>' : 'Không có brief nào đang dở.',
      ...open.slice(0, 15).map((r) => {
        const c = store.getContext<RequestContext>(r.id);
        return `#${r.id} · ${r.type} · ${r.status}${r.step && r.step !== 'done' ? ` · bước ${r.step}` : ''}${c.campaign ? ` · ${escapeHtml(c.campaign.name)}` : ''}`;
      }),
    ];
    await this.send(msg.chat.id, lines.join('\n'));
    return { handled: true };
  }

  // ---------------- Trả lời tin ----------------
  private async onReply(msg: TgMessage, text: string): Promise<HandleResult> {
    const { store } = this.deps;
    const replyTo = msg.reply_to_message!.message_id;
    let req = store.findRequestByContextMessage('editPromptMessageId', replyTo);
    if (!req || req.status !== 'editing') {
      const byApproval = store.findRequestByApprovalMessage(replyTo);
      req = byApproval && byApproval.status === 'pending_approval' ? byApproval : undefined;
    }
    if (!req) return { handled: false };
    if (!text) {
      await this.send(msg.chat.id, 'Trả lời bằng chữ: muốn sửa copy thế nào?');
      return { handled: true };
    }
    const id = req.id;
    await this.withLock(id, async () => {
      const fresh = store.getRequest(id)!;
      if (fresh.status === 'pending_approval' && fresh.approval_message_id) {
        await this.deps.tg.editMessageReplyMarkup(fresh.chat_id!, fresh.approval_message_id).catch(() => {});
      }
      const ctx = store.getContext<RequestContext>(id);
      if (!ctx.brief || (ctx.brief.type === 'ADD' && ctx.brief.postIds.length)) {
        await this.send(msg.chat.id, `Brief #${id} dùng lại bài có sẵn nên không sửa copy được.`);
        return;
      }
      store.updateRequest(id, { status: 'editing', step: 'copy' });
      store.patchContext(id, { editFeedback: text });
      store.audit('owner', 'edit_copy_feedback', { requestId: id, detail: text });
      await this.send(msg.chat.id, `✏️ Đang viết lại copy brief #${id} theo góp ý: “${escapeHtml(text.slice(0, 200))}”…`);
      void this.runner.enqueue(id);
    });
    return { handled: true };
  }

  // ---------------- Nút bấm ----------------
  private async onCallback(cq: TgCallbackQuery): Promise<HandleResult> {
    const { store, tg, cfg } = this.deps;
    const chatId = cq.message?.chat.id;
    if (!this.allowed(chatId)) {
      store.audit('unknown', 'ignored_callback', { detail: { chat_id: chatId, from: cq.from.id } });
      return { handled: true };
    }
    const data = cq.data ?? '';
    const parsed = verifyCallback(cfg.callbackSecret, data);
    if (!parsed) {
      await tg.answerCallbackQuery(cq.id, 'Nút không hợp lệ', true);
      store.audit('unknown', 'bad_callback_signature', { detail: data });
      return { handled: true };
    }
    const req = store.getRequest(parsed.requestId);
    if (!req) {
      await tg.answerCallbackQuery(cq.id, 'Không tìm thấy brief');
      return { handled: true };
    }
    if (parsed.version !== req.approval_version || TERMINAL.includes(req.status)) {
      await tg.answerCallbackQuery(cq.id, `Nút đã hết hiệu lực (brief #${req.id} đang ${req.status})`, true);
      return { handled: true };
    }
    if (!store.claimCallback(data)) {
      await tg.answerCallbackQuery(cq.id, 'Nút này đã được bấm rồi');
      return { handled: true };
    }
    store.audit('owner', `button_${parsed.action}`, { requestId: req.id });

    const a = parsed.action;
    const busyText = a === 'ok' || a.startsWith('v') ? 'Đang bật…' : a === 'cx' || a === 'cn' ? 'Đang huỷ…' : 'Đã nhận';
    await tg.answerCallbackQuery(cq.id, busyText);

    try {
      await this.withLock(req.id, async () => {
        if (a === 'ok') await this.report(req.id, await approve(this.deps, req.id));
        else if (a === 'v1' || a === 'v2' || a === 'v3') await this.report(req.id, await approve(this.deps, req.id, Number(a.slice(1))));
        else if (a === 'ed') await this.report(req.id, await startEdit(this.deps, req.id));
        else if (a === 'cx' || a === 'cn') await cancel(this.deps, req.id, 'owner');
        else if (a === 'cf') await this.onConfirm(req.id);
        else if (/^c\d+$/.test(a)) await this.onPickCampaign(req.id, Number(a.slice(1)));
      });
    } catch (err) {
      store.releaseCallback(data); // cho bấm lại
      log.error(`Xử lý nút ${a} của brief #${req.id} lỗi`, err);
      if (err instanceof MetaTokenError) this.runner.halted = err.ownerText;
      await this.send(req.chat_id!, `🔴 Brief #${req.id}: thao tác "${a}" lỗi:\n<pre>${escapeHtml(errText(err))}</pre>\nBấm lại nút sau khi xử lý.`);
    }
    return { handled: true };
  }

  private async report(id: number, r: { ok: boolean; text: string }): Promise<void> {
    if (!r.ok) {
      const req = this.deps.store.getRequest(id)!;
      await this.send(req.chat_id!, `ℹ Brief #${id}: ${escapeHtml(r.text)}`);
    }
  }

  private async onConfirm(id: number): Promise<void> {
    const { store, tg } = this.deps;
    const req = store.getRequest(id)!;
    const ctx = store.getContext<RequestContext>(id);
    if (req.status !== 'waiting' || ctx.waitingReason !== 'confirm') return;
    store.updateRequest(id, { status: 'validated' });
    store.patchContext(id, { waitingReason: null, pendingConfirm: [] });
    if (ctx.confirmMessageId) {
      await tg
        .editMessageText(req.chat_id!, ctx.confirmMessageId, `✅ Brief #${id} đã xác nhận — đang dựng ở trạng thái PAUSED, xong sẽ gửi tin duyệt.`, {})
        .catch(() => {});
    }
    void this.runner.enqueue(id);
  }

  private async onPickCampaign(id: number, idx: number): Promise<void> {
    const { store, tg } = this.deps;
    const req = store.getRequest(id)!;
    const ctx = store.getContext<RequestContext>(id);
    const c = ctx.campaignCandidates?.[idx];
    if (req.status !== 'waiting' || !c) return;
    store.patchContext(id, {
      campaign: { id: c.id, name: c.name, owned: false },
      productName: (await import('./pipeline/steps.ts')).productFromCampaignName(c.name) ?? undefined,
      campaignCandidates: undefined,
      waitingReason: null,
    });
    store.updateRequest(id, { status: 'validated' });
    await tg.sendMessage(req.chat_id!, `✅ Brief #${id}: dùng campaign “${escapeHtml(c.name)}”. Đang dựng…`, { parse_mode: 'HTML' }).catch(() => {});
    void this.runner.enqueue(id);
  }
}

function describeBrief(b: NonNullable<RequestContext['brief']>): string {
  if (b.type === 'NEW') return `#NEW · ${b.account} · ${escapeHtml(b.product)} · $${b.budgetUsd}/ngày · ${b.runType} · ${b.countries.join(', ')}`;
  return `#ADD · ${b.account} · camp ${escapeHtml(b.camp)}${b.postIds.length ? ` · ${b.postIds.length} Post ID` : ''}`;
}
