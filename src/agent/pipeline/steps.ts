// Các bước của một brief. Mỗi bước idempotent: đọc DB xem việc đã làm chưa rồi mới gọi API,
// để chạy lại từ bước hỏng (hoặc sau khi server khởi động lại) không tạo trùng.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddBrief, NewBrief } from '../brief/parse.ts';
import type { CopyVariantRow, MediaRow, RequestStatus } from '../db.ts';
import { MetaApiError } from '../meta/graph.ts';
import { VideoProcessingError, bidStrategyFor, usdToCents, type CampaignInfo } from '../meta/ads.ts';
import { managedDailyBudgetUsd } from '../safety.ts';
import { startOfDayUtc } from '../../shared/time.ts';
import { escapeHtml } from '../../shared/telegram.ts';
import { signCallback } from '../callbacks.ts';
import type { CopyVariant } from '../copy/rules.ts';
import { StopError, WaitError, type StepEnv } from './types.ts';
import { sendApproval } from '../approval.ts';

export type StepName =
  | 'resolve_campaign'
  | 'product'
  | 'media'
  | 'copy'
  | 'upload'
  | 'creatives'
  | 'reuse_posts'
  | 'campaign'
  | 'adset'
  | 'ads'
  | 'previews'
  | 'approval';

export function stepsFor(brief: NewBrief | AddBrief): StepName[] {
  if (brief.type === 'NEW') return ['product', 'media', 'copy', 'upload', 'creatives', 'campaign', 'adset', 'ads', 'previews', 'approval'];
  if (brief.postIds.length) return ['resolve_campaign', 'reuse_posts', 'adset', 'ads', 'previews', 'approval'];
  return ['resolve_campaign', 'product', 'media', 'copy', 'upload', 'creatives', 'adset', 'ads', 'previews', 'approval'];
}

/** Trạng thái request sau khi xong bước. */
export const STATUS_AFTER: Partial<Record<StepName, RequestStatus>> = {
  media: 'media_ready',
  reuse_posts: 'media_ready',
  copy: 'copy_ready',
  ads: 'created',
  approval: 'pending_approval',
};

// ---------- Tên theo quy ước của chủ shop ----------
export function campaignName(prefix: string, runType: string, product: string, dateLabel: string): string {
  return `${prefix} - ${runType} - ${product} - ${dateLabel}`;
}
export function adsetName(campName: string, countries: string[]): string {
  return `${campName} - ${countries.join(', ')}`;
}
export function adName(product: string, fileName: string, variant: number | string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return `${product} - ${base} - V${variant}`;
}
/** "Dân - Auto - 3D Hoodie Raven - 07/11/2026" → "3D Hoodie Raven". */
export function productFromCampaignName(name: string): string | null {
  const parts = name.split(' - ');
  return parts.length >= 4 ? parts.slice(2, -1).join(' - ').trim() || null : null;
}

export function variantKey(v: Pick<CopyVariant, 'primary_text' | 'headline' | 'description'>, link: string): string {
  return createHash('sha256').update([v.primary_text, v.headline, v.description, link, 'SHOP_NOW'].join('\u241e')).digest('hex').slice(0, 32);
}

export function tmpDirFor(tmpRoot: string, requestId: number): string {
  return path.resolve(tmpRoot, `req-${requestId}`);
}

function accountRefs(env: StepEnv) {
  return env.deps.meta.refs;
}

function brief(env: StepEnv) {
  return env.ctx.brief!;
}

// ---------- Bước #ADD: tìm campaign ----------
async function stepResolveCampaign(env: StepEnv): Promise<void> {
  if (env.ctx.campaign) return;
  const b = brief(env) as AddBrief;
  const { meta, tg } = env.deps;
  let camp: CampaignInfo;
  if (/^\d{6,}$/.test(b.camp)) {
    try {
      camp = await meta.getCampaign(b.camp);
    } catch (err) {
      if (err instanceof MetaApiError && (err.code === 100 || err.httpStatus === 400)) {
        throw new StopError(`Không đọc được campaign ${b.camp} trên ${b.account}:\n${err.ownerText}`);
      }
      throw err;
    }
    if (camp.account_id && `act_${camp.account_id}` !== accountRefs(env).adAccount) {
      throw new StopError(`Campaign ${b.camp} không thuộc tài khoản ${b.account}`);
    }
  } else {
    const list = await meta.searchCampaigns(b.camp);
    if (!list.length) throw new StopError(`Không tìm thấy campaign nào có tên chứa "${b.camp}" trên ${b.account}`);
    if (list.length > 1) {
      const candidates = list.slice(0, 8).map((c) => ({ id: c.id, name: c.name, status: c.effective_status }));
      env.patch({ campaignCandidates: candidates });
      const version = env.req.approval_version;
      const kb = candidates.map((c, i) => [
        { text: `${i + 1}. ${c.name.slice(0, 50)}`, callback_data: signCallback(env.deps.cfg.callbackSecret, env.req.id, `c${i}`, version) },
      ]);
      kb.push([{ text: '❌ Huỷ brief', callback_data: signCallback(env.deps.cfg.callbackSecret, env.req.id, 'cn', version) }]);
      const lines = candidates.map((c, i) => `${i + 1}. ${escapeHtml(c.name)} · <code>${c.id}</code> · ${c.status ?? ''}`);
      await tg.sendMessage(
        env.req.chat_id!,
        `🔎 Brief #${env.req.id}: có ${list.length} campaign khớp "${escapeHtml(b.camp)}"${list.length > 8 ? ' (hiện 8 cái đầu)' : ''}. Chọn camp cần thêm creative:\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } },
      );
      throw new WaitError('campaign_choice', 'Chờ chọn campaign');
    }
    camp = list[0];
  }
  env.patch({
    campaign: { id: camp.id, name: camp.name, owned: false, bidStrategy: camp.bid_strategy, dailyBudget: camp.daily_budget },
    productName: productFromCampaignName(camp.name) ?? env.ctx.productName ?? undefined,
  });
}

// ---------- Bước 2: sản phẩm ----------
async function stepProduct(env: StepEnv): Promise<void> {
  const b = brief(env);
  const handle = b.productHandle;
  const url = b.productUrl;
  if (!handle || !url) return;
  const p = await env.deps.shopify.getProduct(handle, url);
  if (p.status !== 'ACTIVE') throw new StopError(`Sản phẩm "${p.title}" đang ở trạng thái ${p.status}, không phải ACTIVE — dừng brief.`);
  env.patch({ product: p, productName: b.type === 'NEW' ? b.product : (env.ctx.productName ?? p.title) });
  env.deps.store.updateRequest(env.req.id, { product_key: handle });
}

// ---------- Bước 3: tải creative từ Drive ----------
async function stepMedia(env: StepEnv): Promise<void> {
  const b = brief(env);
  const ref = b.creative;
  if (!ref) return;
  const { store, drive, media, cfg } = env.deps;
  store.deleteMediaOfRequest(env.req.id);
  let files = await drive.listCreatives(ref);
  if (!files.length) throw new StopError('Link Drive không có file video (MP4/MOV) hoặc ảnh (JPG/PNG) nào.');
  const max = cfg.limits.maxFilesPerBrief;
  if (files.length > max) {
    env.warn(`Thư mục có ${files.length} file, chỉ lấy ${max} file đầu theo tên`);
    files = files.slice(0, max);
  }
  const dir = tmpDirFor(cfg.tmpDir, env.req.id);
  const errors: string[] = [];
  for (const f of files) {
    if (f.kind === 'other') {
      errors.push(`${f.name}: không phải video hoặc ảnh`);
      continue;
    }
    const local = await drive.download(f, dir);
    let pr;
    try {
      pr = await media.probe(local);
    } catch (err) {
      errors.push(`${f.name}: không đọc được file (${(err as Error).message})`);
      continue;
    }
    const chk = media.checkMedia(f.kind, f.name, f.mimeType, pr);
    errors.push(...chk.errors);
    for (const w of chk.warnings) env.warn(w);
    store.insertMedia({
      request_id: env.req.id,
      drive_file_id: f.id,
      name: f.name,
      kind: f.kind,
      mime: f.mimeType,
      width: pr.width,
      height: pr.height,
      ratio: chk.ratio,
      duration_s: pr.durationS,
      bytes: fs.statSync(local).size,
      sha256: await media.sha256File(local),
      local_path: local,
      warning: chk.warnings.join('; ') || null,
    });
  }
  if (errors.length) throw new StopError(`Creative không đạt yêu cầu:\n${errors.map((e) => `• ${e}`).join('\n')}`);
}

/** Bảo đảm file creative còn trên đĩa (thư mục tạm có thể đã bị dọn). */
async function ensureLocal(env: StepEnv, m: MediaRow): Promise<string> {
  if (m.local_path && fs.existsSync(m.local_path)) return m.local_path;
  const local = await env.deps.drive.download(
    { id: m.drive_file_id, name: m.name, mimeType: m.mime ?? '', size: m.bytes, kind: m.kind },
    tmpDirFor(env.deps.cfg.tmpDir, env.req.id),
  );
  env.deps.store.updateMedia(m.id, { local_path: local });
  return local;
}

export function summarizeMedia(media: MediaRow[]): string {
  const vids = media.filter((m) => m.kind === 'video');
  const imgs = media.filter((m) => m.kind === 'image');
  const parts: string[] = [];
  if (vids.length) parts.push(`${vids.length} video (${[...new Set(vids.map((v) => v.ratio))].join(', ')}; ${vids.map((v) => `${Math.round(v.duration_s ?? 0)}s`).join(', ')})`);
  if (imgs.length) parts.push(`${imgs.length} banner image (${[...new Set(imgs.map((v) => v.ratio))].join(', ')})`);
  return parts.join(' + ');
}

async function collectImages(env: StepEnv, media: MediaRow[]): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(tmpDirFor(env.deps.cfg.tmpDir, env.req.id), 'claude');
  let firstVideo = true;
  for (const m of media) {
    if (out.length >= 8) break;
    const local = await ensureLocal(env, m);
    if (m.kind === 'video') {
      const frames = await env.deps.media.extractFrames(local, m.duration_s ?? 10, dir);
      out.push(...(firstVideo ? frames : frames.slice(1, 2)));
      firstVideo = false;
    } else {
      out.push(await env.deps.media.shrinkImage(local, dir));
    }
  }
  return out.slice(0, 8);
}

// ---------- Bước 4: viết copy ----------
async function stepCopy(env: StepEnv): Promise<void> {
  const { store, copy } = env.deps;
  const media = store.listMedia(env.req.id);
  if (!media.length) return;
  const product = env.ctx.product;
  if (!product) throw new StopError('Thiếu dữ liệu sản phẩm để viết copy');
  // Creative tạo dở (chưa có Post ID) của lần chạy trước không còn dùng.
  for (const o of store.listMetaObjects(env.req.id, 'creative')) if (!o.post_id) store.updateMetaObject(o.id, { status: 'deleted' });

  const previous = env.ctx.editFeedback ? store.activeVariants(env.req.id).map(rowToVariant) : undefined;
  const res = await copy.write({
    product,
    images: await collectImages(env, media),
    creativeSummary: summarizeMedia(media),
    copyNote: brief(env).copyNote,
    editFeedback: env.ctx.editFeedback ?? undefined,
    previous,
  });
  for (const w of res.warnings) env.warn(w);
  const version = store.maxVariantVersion(env.req.id) + 1;
  store.insertVariants(
    env.req.id,
    version,
    res.variants.map((v, i) => ({
      variant: i + 1,
      style: v.style,
      headline: v.headline,
      primary_text: v.primary_text,
      description: v.description,
      reason: v.reason,
      variant_key: variantKey(v, product.url),
    })),
  );
  store.audit('agent', 'copy_written', { requestId: env.req.id, detail: { version, styles: res.variants.map((v) => v.style), edit: !!env.ctx.editFeedback } });
}

export function rowToVariant(r: CopyVariantRow): CopyVariant {
  return { style: r.style as CopyVariant['style'], headline: r.headline, primary_text: r.primary_text, description: r.description, reason: r.reason ?? '' };
}

// ---------- Bước 5: tải media lên Meta ----------
async function stepUpload(env: StepEnv): Promise<void> {
  const { store, meta } = env.deps;
  const adAccount = accountRefs(env).adAccount;
  for (const m0 of store.listMedia(env.req.id)) {
    const m = { ...m0 };
    if (m.kind === 'image' && m.image_hash) continue;
    if (m.kind === 'video' && m.meta_video_id && m.thumbnail_url) continue;

    const reuse = m.sha256 ? store.findUploadedMedia(m.sha256, adAccount) : undefined;
    if (reuse && reuse.id !== m.id) {
      if (m.kind === 'image' && reuse.image_hash) {
        store.updateMedia(m.id, { image_hash: reuse.image_hash });
        continue;
      }
      if (m.kind === 'video' && reuse.meta_video_id) {
        store.updateMedia(m.id, { meta_video_id: reuse.meta_video_id, thumbnail_url: await meta.videoThumbnail(reuse.meta_video_id) });
        continue;
      }
    }
    const local = await ensureLocal(env, m);
    if (m.kind === 'image') {
      const hash = await meta.uploadImage(local);
      store.updateMedia(m.id, { image_hash: hash });
      store.audit('agent', 'upload_image', { requestId: env.req.id, target: hash, detail: m.name });
      continue;
    }
    try {
      if (!m.meta_video_id) {
        m.meta_video_id = await meta.uploadVideo(local, m.name);
        store.updateMedia(m.id, { meta_video_id: m.meta_video_id });
        store.audit('agent', 'upload_video', { requestId: env.req.id, target: m.meta_video_id, detail: m.name });
      }
      await meta.waitVideoReady(m.meta_video_id);
      store.updateMedia(m.id, { thumbnail_url: await meta.videoThumbnail(m.meta_video_id) });
    } catch (err) {
      if (err instanceof VideoProcessingError) {
        store.updateMedia(m.id, { meta_video_id: null });
        throw new StopError(`Video "${m.name}": ${err.message} (video_id ${err.videoId})`);
      }
      throw err;
    }
  }
}

// ---------- Bước 6: tạo creative, lấy Post ID ----------
async function stepCreatives(env: StepEnv): Promise<void> {
  const { store, meta } = env.deps;
  const refs = accountRefs(env);
  const product = env.ctx.product!;
  const productName = env.ctx.productName ?? product.title;
  const variants = store.activeVariants(env.req.id);
  const creatives = () => store.listMetaObjects(env.req.id, 'creative');
  for (const m of store.listMedia(env.req.id)) {
    for (const v of variants) {
      const name = adName(productName, m.name, v.variant);
      let post = store.findPost(m.sha256!, v.variant_key);
      let creativeId: string;
      if (post && post.ad_account_id === refs.adAccount) {
        creativeId = post.creative_id; // cùng video + cùng copy → luôn dùng lại bài cũ
      } else if (post) {
        creativeId = await meta.createCreativeFromPost(post.post_id, name);
      } else {
        // Creative tạo dở ở lần trước (chưa có Post ID) → chỉ hỏi lại Post ID, không tạo bài mới.
        const pending = creatives().find((o) => !o.post_id && o.media_row_id === m.id && o.variant === v.variant && o.name === `${name}#${v.variant_key.slice(0, 8)}`);
        let pendingRowId = pending?.id;
        if (pending) creativeId = pending.meta_id;
        else {
          creativeId = await meta.createCreative({
            name,
            link: product.url,
            copy: v,
            video: m.kind === 'video' ? { videoId: m.meta_video_id!, thumbnailUrl: m.thumbnail_url! } : undefined,
            imageHash: m.kind === 'image' ? m.image_hash! : undefined,
          });
          pendingRowId = store.insertMetaObject({
            request_id: env.req.id,
            level: 'creative',
            meta_id: creativeId,
            name: `${name}#${v.variant_key.slice(0, 8)}`,
            variant: v.variant,
            media_row_id: m.id,
            creative_id: creativeId,
          }).id;
          store.audit('agent', 'create_creative', { requestId: env.req.id, target: creativeId, detail: name });
        }
        const postId = await meta.waitPostId(creativeId);
        store.insertPost({
          post_id: postId,
          media_id: m.sha256!,
          variant_id: v.variant_key,
          creative_id: creativeId,
          ad_account_id: refs.adAccount,
          product_handle: product.handle,
          first_request_id: env.req.id,
        });
        store.updateMetaObject(pendingRowId!, { post_id: postId, name });
        post = store.findPost(m.sha256!, v.variant_key)!;
        continue;
      }
      if (!creatives().some((o) => o.meta_id === creativeId && o.post_id === post!.post_id)) {
        store.insertMetaObject({
          request_id: env.req.id,
          level: 'creative',
          meta_id: creativeId,
          name,
          post_id: post.post_id,
          variant: v.variant,
          media_row_id: m.id,
          creative_id: creativeId,
        });
      }
    }
  }
}

// ---------- #ADD có Post ID: dùng lại bài có sẵn ----------
async function stepReusePosts(env: StepEnv): Promise<void> {
  const { store, meta } = env.deps;
  const refs = accountRefs(env);
  const b = brief(env) as AddBrief;
  const productName = env.ctx.productName ?? 'Post';
  const existing = store.listMetaObjects(env.req.id, 'creative');
  for (const postId of b.postIds) {
    if (existing.some((o) => o.post_id === postId)) continue;
    const known = store.findPostById(postId);
    let creativeId: string;
    if (known && known.ad_account_id === refs.adAccount) creativeId = known.creative_id;
    else {
      try {
        await meta.getPost(postId);
      } catch (err) {
        if (err instanceof MetaApiError) throw new StopError(`Không đọc được bài ${postId} trên Page:\n${err.ownerText}`);
        throw err;
      }
      creativeId = await meta.createCreativeFromPost(postId, `${productName} - ${postId}`);
      store.audit('agent', 'create_creative_from_post', { requestId: env.req.id, target: creativeId, detail: postId });
    }
    store.insertMetaObject({ request_id: env.req.id, level: 'creative', meta_id: creativeId, name: postId, post_id: postId, creative_id: creativeId });
  }
}

// ---------- Bước 7: campaign (#NEW) ----------
async function stepCampaign(env: StepEnv): Promise<void> {
  if (env.ctx.campaign) return;
  const b = brief(env) as NewBrief;
  const { store, meta, cfg } = env.deps;
  const name = campaignName(cfg.naming.ownerPrefix, b.runType, b.product, env.ctx.dateLabel!);
  const current = await managedDailyBudgetUsd(store, meta, b.account, env.req.id);
  if (current + b.budgetUsd > cfg.limits.totalBudgetUsd) {
    throw new StopError(`Tổng budget/ngày các camp Agent quản lý là $${current}; thêm $${b.budgetUsd} vượt giới hạn $${cfg.limits.totalBudgetUsd}.`);
  }
  let id = env.ctx.resumed ? await meta.findByExactName('campaigns', name, env.req.created_at) : null;
  if (!id) id = await meta.createCampaign({ name, dailyBudgetCents: usdToCents(b.budgetUsd), bidStrategy: bidStrategyFor(b.runType) });
  store.insertMetaObject({ request_id: env.req.id, level: 'campaign', meta_id: id, name });
  store.audit('agent', 'create_campaign', { requestId: env.req.id, target: id, detail: { name, budget_usd: b.budgetUsd, run: b.runType } });
  env.patch({ campaign: { id, name, owned: true, bidStrategy: bidStrategyFor(b.runType) } });
}

// ---------- Bước 8: adset ----------
async function stepAdset(env: StepEnv): Promise<void> {
  if (env.ctx.adset) return;
  const { store, meta, cfg } = env.deps;
  const camp = env.ctx.campaign!;
  const b = brief(env);

  if (b.type === 'NEW') {
    const name = adsetName(camp.name, b.countries);
    const startIso = b.startDate ? startOfDayUtc(cfg.account.timezone, b.startDate.y, b.startDate.m, b.startDate.d).toISOString() : null;
    let id = env.ctx.resumed ? await meta.findByExactName('adsets', name, env.req.created_at) : null;
    if (!id) {
      id = await meta.createAdset({
        name,
        campaignId: camp.id,
        countries: b.countries,
        advantageAudience: cfg.meta.advantageAudience,
        bidAmountCents: b.runType !== 'Auto' && b.capUsd ? usdToCents(b.capUsd) : null,
        startTimeIso: startIso,
      });
    }
    store.insertMetaObject({ request_id: env.req.id, level: 'adset', meta_id: id, name });
    store.audit('agent', 'create_adset', { requestId: env.req.id, target: id, detail: { name, countries: b.countries, start: startIso } });
    env.patch({ adset: { id, name, owned: true } });
    return;
  }

  // #ADD
  if (b.adset.mode === 'id') {
    const a = await meta.getAdset(b.adset.id);
    if (a.campaign_id && a.campaign_id !== camp.id) throw new StopError(`Adset ${b.adset.id} không thuộc campaign ${camp.name}`);
    env.patch({ adset: { id: a.id, name: a.name, owned: false } });
    return;
  }
  const list = await meta.listAdsetsOfCampaign(camp.id);
  const running = list.find((a) => a.effective_status === 'ACTIVE');
  if (b.adset.mode === 'auto') {
    if (!running) throw new StopError(`Campaign "${camp.name}" không có adset đang chạy. Ghi "Adset: mới" hoặc ID adset cụ thể.`);
    env.patch({ adset: { id: running.id, name: running.name, owned: false } });
    return;
  }
  const src = running ?? list[0];
  if (!src) throw new StopError(`Campaign "${camp.name}" chưa có adset nào để sao chép target`);
  if (!running) env.warn(`Camp không có adset đang chạy; sao chép target từ adset "${src.name}" (${src.effective_status})`);
  const countries = ((src.targeting?.geo_locations as { countries?: string[] } | undefined)?.countries ?? []) as string[];
  const name = adsetName(camp.name, countries.length ? countries : ['copy']);
  let id = env.ctx.resumed ? await meta.findByExactName('adsets', name, env.req.created_at) : null;
  if (!id) id = await meta.createAdset({ name, campaignId: camp.id, copyFrom: src });
  store.insertMetaObject({ request_id: env.req.id, level: 'adset', meta_id: id, name });
  store.audit('agent', 'create_adset', { requestId: env.req.id, target: id, detail: { name, copied_from: src.id } });
  env.patch({ adset: { id, name, owned: true, copiedFrom: src.id } });
}

// ---------- Bước 9: ad gắn Post ID ----------
interface DesiredAd {
  key: string;
  name: string;
  creativeId: string;
  postId: string;
  variant: number | null;
  mediaRowId: number | null;
}

export function desiredAds(env: StepEnv): DesiredAd[] {
  const { store } = env.deps;
  const b = brief(env);
  const creatives = store.listMetaObjects(env.req.id, 'creative').filter((o) => o.post_id);
  if (b.type === 'ADD' && b.postIds.length) {
    const productName = env.ctx.productName ?? 'Post';
    return b.postIds.map((postId, i) => {
      const c = creatives.find((o) => o.post_id === postId)!;
      const known = store.findPostById(postId);
      const srcMedia = known ? store.db.prepare(`SELECT name FROM media WHERE sha256=? LIMIT 1`).get(known.media_id) as { name: string } | undefined : undefined;
      const srcVar = known
        ? (store.db.prepare(`SELECT variant FROM copy_variants WHERE variant_key=? LIMIT 1`).get(known.variant_id) as { variant: number } | undefined)
        : undefined;
      const name = srcMedia && srcVar ? adName(productName, srcMedia.name, srcVar.variant) : `${productName} - ${postId} - P${i + 1}`;
      return { key: `post:${postId}`, name, creativeId: c.meta_id, postId, variant: null, mediaRowId: null };
    });
  }
  const productName = env.ctx.productName ?? env.ctx.product?.title ?? 'Ad';
  const out: DesiredAd[] = [];
  for (const m of store.listMedia(env.req.id)) {
    for (const v of store.activeVariants(env.req.id)) {
      const post = store.findPost(m.sha256!, v.variant_key);
      if (!post) throw new Error(`Chưa có Post ID cho ${m.name} × V${v.variant}`);
      const c = creatives.find((o) => o.post_id === post.post_id && o.media_row_id === m.id) ?? creatives.find((o) => o.post_id === post.post_id);
      if (!c) throw new Error(`Chưa có creative cho ${m.name} × V${v.variant}`);
      out.push({ key: `m${m.id}:v${v.variant}`, name: adName(productName, m.name, v.variant), creativeId: c.meta_id, postId: post.post_id, variant: v.variant, mediaRowId: m.id });
    }
  }
  return out;
}

async function stepAds(env: StepEnv): Promise<void> {
  const { store, meta } = env.deps;
  const adsetId = env.ctx.adset!.id;
  const desired = desiredAds(env);
  const existing = store.listMetaObjects(env.req.id, 'ad').filter((o) => o.owned);
  const keyOf = (o: { media_row_id: number | null; variant: number | null; post_id: string | null }) =>
    o.media_row_id ? `m${o.media_row_id}:v${o.variant}` : `post:${o.post_id}`;

  for (const d of desired) {
    const ex = existing.find((o) => keyOf(o) === d.key);
    if (ex) {
      if (ex.creative_id !== d.creativeId) {
        // "Sửa copy": giữ ad, đổi sang creative (bài) mới.
        await meta.updateAdCreative(ex.meta_id, d.creativeId);
        store.updateMetaObject(ex.id, { creative_id: d.creativeId, post_id: d.postId });
        store.audit('agent', 'update_ad_creative', { requestId: env.req.id, target: ex.meta_id, detail: { creative: d.creativeId, post: d.postId } });
      }
      continue;
    }
    let id = env.ctx.resumed ? await meta.findByExactName('ads', d.name, env.req.created_at) : null;
    if (!id) id = await meta.createAd({ name: d.name, adsetId, creativeId: d.creativeId });
    store.insertMetaObject({
      request_id: env.req.id,
      level: 'ad',
      meta_id: id,
      name: d.name,
      post_id: d.postId,
      variant: d.variant,
      media_row_id: d.mediaRowId,
      creative_id: d.creativeId,
    });
    store.audit('agent', 'create_ad', { requestId: env.req.id, target: id, detail: { name: d.name, post: d.postId } });
  }
  // Ad không còn trong bộ mong muốn (ví dụ sửa copy từ 3 xuống 2 phương án) → xoá.
  for (const ex of existing) {
    if (desired.some((d) => d.key === keyOf(ex))) continue;
    await meta.deleteObject(ex.meta_id);
    store.updateMetaObject(ex.id, { status: 'deleted' });
    store.audit('agent', 'delete_ad', { requestId: env.req.id, target: ex.meta_id, detail: 'không còn trong bộ copy mới' });
  }
}

// ---------- Bước 10: preview ----------
async function stepPreviews(env: StepEnv): Promise<void> {
  const { store, meta } = env.deps;
  const media = new Map(store.listMedia(env.req.id).map((m) => [m.id, m]));
  let failed = 0;
  for (const ad of store.listMetaObjects(env.req.id, 'ad')) {
    const m = ad.media_row_id ? media.get(ad.media_row_id) : undefined;
    const formats: Array<'MOBILE_FEED_STANDARD' | 'INSTAGRAM_REELS'> = ['MOBILE_FEED_STANDARD'];
    if (!m || m.kind === 'video') formats.push('INSTAGRAM_REELS');
    const links: Record<string, string> = {};
    for (const f of formats) {
      try {
        const url = await meta.preview(ad.meta_id, f);
        if (url) links[f] = url;
      } catch (err) {
        if (err instanceof MetaApiError) failed++;
        else throw err;
      }
    }
    store.updateMetaObject(ad.id, { preview_json: JSON.stringify(links) });
  }
  if (failed) env.warn(`${failed} link preview không lấy được (ad vẫn tạo bình thường)`);
}

// ---------- Bước 11: tin duyệt ----------
async function stepApproval(env: StepEnv): Promise<void> {
  await sendApproval(env.deps, env.req.id);
}

export const STEPS: Record<StepName, (env: StepEnv) => Promise<void>> = {
  resolve_campaign: stepResolveCampaign,
  product: stepProduct,
  media: stepMedia,
  copy: stepCopy,
  upload: stepUpload,
  creatives: stepCreatives,
  reuse_posts: stepReusePosts,
  campaign: stepCampaign,
  adset: stepAdset,
  ads: stepAds,
  previews: stepPreviews,
  approval: stepApproval,
};
