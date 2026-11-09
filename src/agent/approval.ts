// Tin duyệt và các nút: Duyệt & chạy / Chỉ V1 / Chỉ V2 / Sửa copy / Huỷ.
// Bật theo thứ tự ad → adset → campaign, rồi đọc lại effective_status và báo kết quả.

import fs from 'node:fs';
import path from 'node:path';
import type { Deps, RequestContext } from './pipeline/types.ts';
import type { MetaObjectRow, RequestRow } from './db.ts';
import { signCallback, type Action } from './callbacks.ts';
import { escapeHtml, type InlineKeyboard, TelegramError } from '../shared/telegram.ts';
import { MetaApiError } from './meta/graph.ts';
import { formatDate } from '../shared/time.ts';
import { logger } from '../shared/log.ts';

const log = logger('approval');

const TG_LIMIT = 4096;

function ctxOf(deps: Deps, id: number): RequestContext {
  return deps.store.getContext<RequestContext>(id);
}

function btn(deps: Deps, req: RequestRow, text: string, action: Action, version: number) {
  return { text, callback_data: signCallback(deps.cfg.callbackSecret, req.id, action, version) };
}

export function approvalKeyboard(deps: Deps, req: RequestRow, version: number, variantCount: number): InlineKeyboard {
  const rows = [[btn(deps, req, '✅ Duyệt & chạy', 'ok', version)]];
  if (variantCount >= 2) rows.push(Array.from({ length: Math.min(variantCount, 3) }, (_, i) => btn(deps, req, `Chỉ V${i + 1}`, `v${i + 1}` as Action, version)));
  const last = [];
  if (variantCount >= 1) last.push(btn(deps, req, '✏️ Sửa copy', 'ed', version));
  last.push(btn(deps, req, '❌ Huỷ', 'cx', version));
  rows.push(last);
  return { inline_keyboard: rows };
}

function postLink(postId: string): string {
  return `https://facebook.com/${postId}`;
}

/** Soạn nội dung tin duyệt (HTML). */
export function composeApproval(deps: Deps, req: RequestRow, maxPrimary = 600): string {
  const { store, cfg } = deps;
  const ctx = ctxOf(deps, req.id);
  const b = ctx.brief!;
  const media = store.listMedia(req.id);
  const variants = store.activeVariants(req.id);
  const ads = store.listMetaObjects(req.id, 'ad');
  const lines: string[] = [];

  lines.push(`🟡 <b>CHỜ DUYỆT</b> · #${b.type} · ${escapeHtml(b.account)} · brief #${req.id}`);
  lines.push(`Camp: ${escapeHtml(ctx.campaign?.name ?? '?')}${b.type === 'ADD' ? ' (có sẵn, giữ nguyên)' : ''}`);
  if (b.type === 'NEW') {
    const run = b.runType === 'Auto' ? 'Auto' : `${b.runType} $${b.capUsd}`;
    lines.push(`Budget: $${b.budgetUsd}/ngày · CBO · ${run} · ${b.countries.join(', ')}`);
    if (b.startDate) lines.push(`Bắt đầu: ${String(b.startDate.d).padStart(2, '0')}/${String(b.startDate.m).padStart(2, '0')}/${b.startDate.y} (giờ tài khoản)`);
  } else if (ctx.adset) {
    lines.push(ctx.adset.owned ? `Adset: mới — sao chép target, pixel, bid từ adset ${ctx.adset.copiedFrom}` : `Adset: ${escapeHtml(ctx.adset.name)} (đang chạy)`);
  }
  lines.push(`Pixel: ${escapeHtml(cfg.account.pixelName)} · Page: ${escapeHtml(cfg.account.pageName)}`);

  if (media.length) {
    const vids = media.filter((m) => m.kind === 'video');
    const imgs = media.filter((m) => m.kind === 'image');
    const desc = (list: typeof media, label: string) => {
      const ratios = [...new Set(list.map((m) => m.ratio ?? '?'))];
      const ok = list.every((m) => !m.warning);
      return `${list.length} ${label} (${ratios.join(', ')} ${ok ? '✓' : '⚠'})`;
    };
    const parts = [];
    if (vids.length) parts.push(desc(vids, 'video'));
    if (imgs.length) parts.push(desc(imgs, 'ảnh'));
    lines.push(`Creative: ${parts.join(', ')}`);
  } else if (b.type === 'ADD' && b.postIds.length) {
    lines.push(`Creative: dùng lại ${b.postIds.length} bài có sẵn (không tạo bài mới)`);
  }

  const previewLinks: string[] = [];
  const multiMedia = media.length > 1;
  for (const v of variants) {
    lines.push('');
    lines.push(`<b>V${v.variant} · ${escapeHtml(v.style)}</b>`);
    lines.push(`Headline: ${escapeHtml(v.headline)}`);
    const text = v.primary_text.length > maxPrimary ? v.primary_text.slice(0, maxPrimary) + '…' : v.primary_text;
    lines.push(`Text: ${escapeHtml(text)}`);
    lines.push(`Description: ${escapeHtml(v.description)}`);
    if (v.reason) lines.push(`Lý do chọn: ${escapeHtml(v.reason)}`);
    for (const ad of ads.filter((a) => a.variant === v.variant)) {
      const m = media.find((x) => x.id === ad.media_row_id);
      const label = multiMedia && m ? `${escapeHtml(m.name)} → ` : '';
      if (ad.post_id) lines.push(`Post ID: ${label}<code>${ad.post_id}</code> (<a href="${postLink(ad.post_id)}">mở bài</a>)`);
      pushPreviews(previewLinks, ad, multiMedia && m ? `${media.indexOf(m) + 1}.V${v.variant}` : `V${v.variant}`);
    }
  }
  if (!variants.length) {
    lines.push('');
    for (const [i, ad] of ads.entries()) {
      lines.push(`Ad ${i + 1}: ${escapeHtml(ad.name ?? '')} · Post ID <code>${ad.post_id}</code> (<a href="${postLink(ad.post_id!)}">mở bài</a>)`);
      pushPreviews(previewLinks, ad, `P${i + 1}`);
    }
  }
  if (previewLinks.length) {
    lines.push('');
    lines.push(`Preview: ${previewLinks.join(' ')}`);
  }
  const warnings = ctx.warnings ?? [];
  if (warnings.length) {
    lines.push('');
    lines.push(`⚠ Cảnh báo:\n${warnings.map((w) => `• ${escapeHtml(w)}`).join('\n')}`);
  }
  const text = lines.join('\n');
  if (text.length > TG_LIMIT && maxPrimary > 120) return composeApproval(deps, req, Math.floor(maxPrimary / 2));
  return text.length > TG_LIMIT ? text.slice(0, TG_LIMIT - 20) + '\n…(đã rút gọn)' : text;
}

function pushPreviews(out: string[], ad: MetaObjectRow, label: string): void {
  const p = ad.preview_json ? (JSON.parse(ad.preview_json) as Record<string, string>) : {};
  if (p.MOBILE_FEED_STANDARD) out.push(`<a href="${escapeHtml(p.MOBILE_FEED_STANDARD)}">[${label} Feed]</a>`);
  if (p.INSTAGRAM_REELS) out.push(`<a href="${escapeHtml(p.INSTAGRAM_REELS)}">[${label} Reels]</a>`);
}

/** Gửi creative + tin duyệt; tin duyệt cũ (nếu có, sau "Sửa copy") được đánh dấu đã thay. */
export async function sendApproval(deps: Deps, requestId: number): Promise<void> {
  const { store, tg } = deps;
  let req = store.getRequest(requestId)!;
  const chatId = req.chat_id!;
  const oldMsg = req.approval_message_id;
  const version = req.approval_version + 1;
  store.updateRequest(req.id, { approval_version: version });
  req = store.getRequest(requestId)!;

  // Kèm creative: video nhỏ gửi thẳng, còn lại gửi ảnh / thumbnail.
  const media = store.listMedia(req.id);
  const first = media[0];
  if (first) {
    try {
      if (first.kind === 'video' && first.local_path && fs.existsSync(first.local_path) && (first.bytes ?? Infinity) < 49 * 1024 * 1024) {
        await tg.sendFile('sendVideo', chatId, { kind: 'path', filePath: first.local_path, filename: first.name }, { caption: `Brief #${req.id} · ${first.name}`, disable_notification: true });
      } else if (first.kind === 'image' && first.local_path && fs.existsSync(first.local_path)) {
        await tg.sendFile('sendPhoto', chatId, { kind: 'path', filePath: first.local_path, filename: first.name }, { caption: `Brief #${req.id} · ${first.name}`, disable_notification: true });
      } else if (first.thumbnail_url) {
        await tg.sendFile('sendPhoto', chatId, { kind: 'url', url: first.thumbnail_url }, { caption: `Brief #${req.id} · ${first.name}`, disable_notification: true });
      }
    } catch (err) {
      log.warn('Không gửi được creative kèm tin duyệt', err);
    }
  }

  const text = composeApproval(deps, req);
  const kb = approvalKeyboard(deps, req, version, store.activeVariants(req.id).length);
  const msg = await tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, disable_preview: true });
  store.updateRequest(req.id, {
    approval_message_id: msg.message_id,
    approval_sent_at: new Date().toISOString(),
    reminded_at: null,
    status: 'pending_approval',
  });
  store.patchContext(req.id, { approvalText: text, editFeedback: null, editPromptMessageId: null });
  store.audit('agent', 'approval_sent', { requestId: req.id, detail: { message_id: msg.message_id, version } });

  if (oldMsg && oldMsg !== msg.message_id) {
    await safeEdit(deps, chatId, oldMsg, `↪ Brief #${req.id}: đã thay bằng tin duyệt mới bên dưới.`);
  }
}

async function safeEdit(deps: Deps, chatId: number, messageId: number, html: string): Promise<void> {
  try {
    await deps.tg.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', disable_preview: true });
  } catch (err) {
    if (err instanceof TelegramError && err.isParseError) {
      await deps.tg.editMessageText(chatId, messageId, html.replace(/<[^>]+>/g, ''), { disable_preview: true }).catch(() => {});
    } else log.warn('Không sửa được tin', err);
  }
}

function replaceHeader(approvalText: string | undefined, header: string, tail: string): string {
  const body = (approvalText ?? '').split('\n').slice(1).join('\n');
  const out = `${header}\n${body}\n\n${tail}`.trim();
  return out.length > TG_LIMIT ? `${header}\n\n${tail}`.slice(0, TG_LIMIT) : out;
}

// ---------------- Hành động ----------------

export interface ActionResult {
  ok: boolean;
  text: string;
}

/** Duyệt & chạy (onlyVariant = chỉ giữ một phương án, xoá ad của phương án còn lại). */
export async function approve(deps: Deps, requestId: number, onlyVariant?: number): Promise<ActionResult> {
  const { store, meta } = deps;
  const req = store.getRequest(requestId)!;
  if (req.status !== 'pending_approval') return { ok: false, text: `Brief #${req.id} đang ở trạng thái ${req.status}, không duyệt được.` };
  store.updateRequest(req.id, { status: 'activating' });
  store.audit('owner', onlyVariant ? `approve_only_v${onlyVariant}` : 'approve', { requestId: req.id });
  const ctx = ctxOf(deps, req.id);
  const errors: string[] = [];

  try {
    let ads = store.listMetaObjects(req.id, 'ad').filter((a) => a.owned);
    if (onlyVariant) {
      for (const ad of ads.filter((a) => a.variant !== null && a.variant !== onlyVariant)) {
        try {
          await meta.deleteObject(ad.meta_id);
          store.updateMetaObject(ad.id, { status: 'deleted' });
          store.audit('agent', 'delete_ad', { requestId: req.id, target: ad.meta_id, detail: `chỉ giữ V${onlyVariant}` });
        } catch (err) {
          errors.push(`Không xoá được ad ${ad.meta_id}: ${errText(err)}`);
        }
      }
      ads = store.listMetaObjects(req.id, 'ad').filter((a) => a.owned);
      store.markChosen(req.id, [onlyVariant]);
    } else {
      store.markChosen(req.id, store.activeVariants(req.id).map((v) => v.variant));
    }
    const adsets = store.listMetaObjects(req.id, 'adset').filter((a) => a.owned);
    const camps = store.listMetaObjects(req.id, 'campaign').filter((a) => a.owned);
    // Thứ tự: ad → adset → campaign. Campaign có sẵn của #ADD giữ nguyên.
    for (const o of [...ads, ...adsets, ...camps]) {
      if (o.status === 'active') continue;
      try {
        await meta.setStatus(o.meta_id, 'ACTIVE');
        store.updateMetaObject(o.id, { status: 'active' });
        store.audit('agent', `activate_${o.level}`, { requestId: req.id, target: o.meta_id });
      } catch (err) {
        errors.push(`Không bật được ${o.level} ${o.meta_id}: ${errText(err)}`);
      }
    }

    const all = [...ads, ...adsets, ...camps];
    const statuses = await meta.readStatuses(all.map((o) => o.meta_id), true).catch(() => ({}) as Record<string, { effective_status?: string }>);
    const lines = all.map((o) => `${labelLevel(o.level)} <code>${o.meta_id}</code> · ${(statuses as Record<string, { effective_status?: string }>)[o.meta_id]?.effective_status ?? '?'}${o.name && o.level !== 'campaign' ? ` · ${escapeHtml(o.name)}` : ''}`);
    if (ctx.campaign && !ctx.campaign.owned) lines.unshift(`Campaign <code>${ctx.campaign.id}</code> · có sẵn, không đổi`);
    if (ctx.adset && !ctx.adset.owned) lines.splice(1, 0, `Adset <code>${ctx.adset.id}</code> · có sẵn, không đổi`);
    const rejected = Object.entries(statuses as Record<string, { effective_status?: string; ad_review_feedback?: unknown }>)
      .filter(([, s]) => s.effective_status === 'DISAPPROVED')
      .map(([id, s]) => `Ad ${id} bị từ chối: ${JSON.stringify(s.ad_review_feedback ?? {})}`);

    if (errors.length) {
      // Bật dở: giữ trạng thái chờ duyệt, gửi lại nút để bấm lại hoặc huỷ.
      store.updateRequest(req.id, { status: 'pending_approval', error: errors.join('\n') });
      const fresh = store.getRequest(req.id)!;
      const version = fresh.approval_version + 1;
      store.updateRequest(req.id, { approval_version: version });
      const kb: InlineKeyboard = {
        inline_keyboard: [[btn(deps, fresh, '🔁 Bật lại phần còn lại', 'ok', version), btn(deps, fresh, '❌ Huỷ', 'cx', version)]],
      };
      const text = replaceHeader(ctx.approvalText, `🟠 <b>BẬT CHƯA XONG</b> · brief #${req.id}`, [...lines, '', ...errors.map((e) => `⚠ ${escapeHtml(e)}`)].join('\n'));
      await deps.tg.editMessageText(req.chat_id!, req.approval_message_id!, text, { parse_mode: 'HTML', reply_markup: kb, disable_preview: true }).catch((e) => log.warn('edit', e));
      return { ok: false, text: 'Bật chưa xong, xem chi tiết trong tin duyệt' };
    }

    store.updateRequest(req.id, { status: 'active', error: null });
    const tail = [`Bật lúc ${formatDate(new Date(), 'Asia/Ho_Chi_Minh')}:`, ...lines, ...(rejected.length ? ['', ...rejected.map((r) => `⚠ ${escapeHtml(r)}`)] : [])].join('\n');
    const header = `🟢 <b>ĐANG CHẠY</b> · #${ctx.brief!.type} · brief #${req.id}${onlyVariant ? ` · chỉ V${onlyVariant}` : ''}`;
    await safeEdit(deps, req.chat_id!, req.approval_message_id!, replaceHeader(ctx.approvalText, header, tail));
    cleanupTmp(deps, req.id);
    return { ok: true, text: 'Đã bật' };
  } catch (err) {
    store.updateRequest(req.id, { status: 'pending_approval' });
    throw err;
  }
}

/** Huỷ: xoá mọi object PAUSED do brief tạo (ad → adset → campaign). */
export async function cancel(deps: Deps, requestId: number, by: 'owner' | 'timeout' | 'system', reason?: string): Promise<ActionResult> {
  const { store } = deps;
  const req = store.getRequest(requestId)!;
  if (['active', 'cancelled'].includes(req.status)) return { ok: false, text: `Brief #${req.id} đang ${req.status}, không huỷ được.` };
  const errors = await deleteOwnedObjects(deps, req.id, true);
  store.updateRequest(req.id, { status: 'cancelled', error: errors.length ? errors.join('\n') : null });
  store.audit(by === 'owner' ? 'owner' : 'agent', 'cancel', { requestId: req.id, detail: { by, reason, errors } });
  const ctx = ctxOf(deps, req.id);
  const why = by === 'timeout' ? `tự huỷ sau ${deps.cfg.limits.autoCancelAfterH} giờ chưa duyệt` : by === 'owner' ? 'chủ shop bấm Huỷ' : (reason ?? 'hệ thống huỷ');
  const tail = errors.length ? `Không xoá được:\n${errors.map((e) => `• ${escapeHtml(e)}`).join('\n')}` : 'Đã xoá toàn bộ object PAUSED của brief khỏi tài khoản.';
  const header = `⚪ <b>ĐÃ HUỶ</b> · brief #${req.id} · ${escapeHtml(why)}`;
  if (req.approval_message_id) await safeEdit(deps, req.chat_id!, req.approval_message_id, replaceHeader(ctx.approvalText, header, tail));
  else if (ctx.confirmMessageId) await safeEdit(deps, req.chat_id!, ctx.confirmMessageId, `${header}\n${tail}`);
  else await deps.tg.sendMessage(req.chat_id!, `${header}\n${tail}`, { parse_mode: 'HTML' }).catch(() => {});
  cleanupTmp(deps, req.id);
  return { ok: !errors.length, text: 'Đã huỷ' };
}

/**
 * Xoá các object do brief tạo (owned=1), theo thứ tự ad → adset → campaign.
 * Creative giữ lại vì bài trên Page được dùng lại cho lần sau (bảng posts).
 * Chỉ xoá object PAUSED trừ khi đang huỷ brief chưa bật.
 */
export async function deleteOwnedObjects(deps: Deps, requestId: number, onlyPaused: boolean): Promise<string[]> {
  const { store, meta } = deps;
  const errors: string[] = [];
  for (const level of ['ad', 'adset', 'campaign'] as const) {
    for (const o of store.listMetaObjects(requestId, level).filter((x) => x.owned)) {
      if (onlyPaused && o.status === 'active') {
        errors.push(`${level} ${o.meta_id} đang ACTIVE — không tự xoá`);
        continue;
      }
      try {
        await meta.deleteObject(o.meta_id);
        store.updateMetaObject(o.id, { status: 'deleted' });
        store.audit('agent', `delete_${level}`, { requestId, target: o.meta_id });
      } catch (err) {
        if (err instanceof MetaApiError && (err.code === 100 || /does not exist|deleted/i.test(err.body.message ?? ''))) {
          store.updateMetaObject(o.id, { status: 'deleted' });
          continue;
        }
        errors.push(`${level} ${o.meta_id}: ${errText(err)}`);
      }
    }
  }
  return errors;
}

/** Sửa copy: hỏi "Sửa gì?" (force reply); câu trả lời đi vào prompt viết lại. */
export async function startEdit(deps: Deps, requestId: number): Promise<ActionResult> {
  const { store, tg } = deps;
  const req = store.getRequest(requestId)!;
  if (req.status !== 'pending_approval') return { ok: false, text: `Brief #${req.id} đang ${req.status}` };
  store.updateRequest(req.id, { status: 'editing' });
  const msg = await tg.sendMessage(req.chat_id!, `✏️ Brief #${req.id} — Sửa gì? Trả lời (reply) tin này, ví dụ: "nhấn mạnh in 2 mặt".`, {
    reply_markup: { force_reply: true, input_field_placeholder: 'Sửa gì?' },
    reply_to_message_id: req.approval_message_id ?? undefined,
  });
  store.patchContext(req.id, { editPromptMessageId: msg.message_id });
  if (req.approval_message_id) await tg.editMessageReplyMarkup(req.chat_id!, req.approval_message_id).catch(() => {});
  store.audit('owner', 'edit_copy_requested', { requestId: req.id });
  return { ok: true, text: 'Trả lời tin "Sửa gì?" để Agent viết lại' };
}

export function cleanupTmp(deps: Deps, requestId: number): void {
  try {
    fs.rmSync(path.resolve(deps.cfg.tmpDir, `req-${requestId}`), { recursive: true, force: true });
  } catch {
    /* không quan trọng */
  }
}

function labelLevel(l: string): string {
  return l === 'campaign' ? 'Campaign' : l === 'adset' ? 'Adset' : l === 'ad' ? 'Ad' : l;
}

export function errText(err: unknown): string {
  if (err instanceof MetaApiError) return err.ownerText.replace(/\n/g, ' · ');
  return (err as Error)?.message ?? String(err);
}
