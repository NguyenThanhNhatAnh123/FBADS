// Giá trị bắt buộc của bản nháp (tính bằng code, không để Claude tự nghĩ) và bước soát kết quả Claude nộp.
// Bridge từ chối submit_drafts nếu tên / budget / bid / trạng thái lệch, hoặc copy vi phạm quy tắc —
// Claude phải sửa rồi nộp lại, tin duyệt chỉ được gửi khi mọi thứ khớp.

import { z } from 'zod';
import type { AddBrief, Brief, NewBrief } from '../../agent/brief/parse.ts';
import { checkVariant, STYLES, type CopyVariant } from '../../agent/copy/rules.ts';
import { formatDate, startOfDayUtc, TZ_VN } from '../../shared/time.ts';
import type { JobAccount, JobLimits } from './config.ts';

export interface Expected {
  dateLabel: string;
  campaignName?: string;
  adsetName?: string;
  dailyBudgetCents?: number;
  bidStrategy?: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP';
  bidAmountCents?: number | null;
  startTimeIso?: string | null;
}

export const usdToCents = (usd: number): number => Math.round(usd * 100);

export function bidStrategyFor(runType: NewBrief['runType']): NonNullable<Expected['bidStrategy']> {
  return runType === 'CC' ? 'COST_CAP' : runType === 'BidCap' ? 'LOWEST_COST_WITH_BID_CAP' : 'LOWEST_COST_WITHOUT_CAP';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Tên camp theo quy ước chủ shop: `Dân - {Kiểu chạy} - {Sản phẩm} - {dd/MM/yyyy}` (ngày = ngày chạy, mặc định hôm nay giờ VN). */
export function expectedFor(brief: Brief, acc: JobAccount, createdAt: Date): Expected {
  if (brief.type === 'ADD') return { dateLabel: formatDate(createdAt, TZ_VN) };
  const b = brief;
  const dateLabel = b.startDate ? `${pad(b.startDate.d)}/${pad(b.startDate.m)}/${b.startDate.y}` : formatDate(createdAt, TZ_VN);
  const campaignName = `${acc.namePrefix} - ${b.runType} - ${b.product} - ${dateLabel}`;
  return {
    dateLabel,
    campaignName,
    adsetName: `${campaignName} - ${b.countries.join(', ')}`,
    dailyBudgetCents: usdToCents(b.budgetUsd),
    bidStrategy: bidStrategyFor(b.runType),
    bidAmountCents: b.runType !== 'Auto' && b.capUsd ? usdToCents(b.capUsd) : null,
    startTimeIso: b.startDate ? startOfDayUtc(acc.timezone, b.startDate.y, b.startDate.m, b.startDate.d).toISOString() : null,
  };
}

// ---------- Schema đầu vào các tool job (zod raw shape cho McpServer.registerTool) ----------

export const variantSchema = z.object({
  variant: z.number().int().min(1).max(3).describe('Số phương án: 1, 2, 3'),
  style: z.enum(STYLES),
  primary_text: z.string().min(1).max(3000),
  headline: z.string().min(1).max(200),
  description: z.string().max(200),
  reason: z.string().max(600).default(''),
});

export const checkCopyShape = {
  variants: z.array(variantSchema).min(1).max(3),
  product_page_text: z.string().max(30000).describe('Mô tả + giá + ưu đãi đọc từ trang sản phẩm Shopify (để soát ưu đãi có thật)'),
};

export const draftsShape = {
  product: z
    .object({
      title: z.string(),
      handle: z.string(),
      status: z.string().describe('Trạng thái sản phẩm trên Shopify, phải là ACTIVE'),
      price: z.string().optional(),
      page_text: z.string().max(30000).describe('Mô tả + giá + ưu đãi đã dùng để viết copy'),
    })
    .nullable()
    .describe('null khi brief #ADD chỉ dùng Post ID'),
  campaign: z.object({
    id: z.string().min(1),
    name: z.string(),
    existing: z.boolean().describe('true = campaign có sẵn (#ADD), false = vừa tạo nháp'),
    daily_budget_cents: z.number().int().nullable().describe('Đọc lại từ Meta sau khi tạo'),
    bid_strategy: z.string().nullable(),
    status: z.string().describe('Trạng thái đọc lại (DRAFT / PAUSED / ACTIVE...)'),
  }),
  adset: z.object({
    id: z.string().min(1),
    name: z.string(),
    existing: z.boolean(),
    copied_from: z.string().nullable().optional().describe('#ADD Adset mới: ID adset nguồn đã sao chép target / pixel / bid'),
    countries: z.array(z.string()).optional(),
    status: z.string().optional(),
  }),
  media: z
    .array(
      z.object({
        name: z.string().describe('Tên file trên Drive'),
        kind: z.enum(['video', 'image']),
        drive_file_id: z.string().optional(),
        meta_id: z.string().describe('video_id hoặc image_hash trên Meta'),
        shopify_file_id: z.string().optional().describe('ID file trung gian trên Shopify Files (đã xoá sau khi Meta có media)'),
        ratio: z.string().optional().describe('9:16, 4:5, 1:1 hoặc tỷ lệ đo được; bỏ trống nếu không đo được'),
        duration_s: z.number().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        warning: z.string().optional(),
      }),
    )
    .max(10),
  variants: z.array(variantSchema).max(3),
  ads: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        variant: z.number().int().min(1).max(3).nullable().describe('null khi ad dùng lại Post ID có sẵn'),
        media_name: z.string().nullable().optional(),
        creative_id: z.string().min(1),
        post_id: z.string().nullable().optional().describe('effective_object_story_id dạng {page_id}_{post_id} nếu đọc được'),
        preview_feed_url: z.string().nullable().optional(),
        preview_reels_url: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
  instagram_user_id: z.string().nullable().optional(),
  warnings: z.array(z.string().max(500)).max(20).default([]),
};

export type DraftVariant = CopyVariant & { variant: number };

export type DraftsPayload = {
  product: { title: string; handle: string; status: string; price?: string; page_text: string } | null;
  campaign: { id: string; name: string; existing: boolean; daily_budget_cents: number | null; bid_strategy: string | null; status: string };
  adset: { id: string; name: string; existing: boolean; copied_from?: string | null; countries?: string[]; status?: string };
  media: Array<{ name: string; kind: 'video' | 'image'; drive_file_id?: string; meta_id: string; shopify_file_id?: string; ratio?: string; duration_s?: number; width?: number; height?: number; warning?: string }>;
  variants: DraftVariant[];
  ads: Array<{ id: string; name: string; variant: number | null; media_name?: string | null; creative_id: string; post_id?: string | null; preview_feed_url?: string | null; preview_reels_url?: string | null }>;
  instagram_user_id?: string | null;
  warnings: string[];
};

export const activationShape = {
  results: z
    .array(
      z.object({
        id: z.string(),
        level: z.enum(['campaign', 'ad_set', 'ad']),
        effective_status: z.string().describe('Đọc lại sau khi bật (ACTIVE, PENDING_REVIEW, IN_PROCESS...)'),
        ok: z.boolean(),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(40),
  discarded: z.array(z.string()).max(40).default([]).describe('ID bản nháp của phương án không được chọn đã bỏ'),
  errors: z.array(z.string().max(800)).max(20).default([]),
};
export type ActivationPayload = {
  results: Array<{ id: string; level: 'campaign' | 'ad_set' | 'ad'; effective_status: string; ok: boolean; note?: string }>;
  discarded: string[];
  errors: string[];
};

export const cancelShape = {
  removed: z.array(z.string()).max(80).describe('ID campaign / adset / ad / creative đã xoá'),
  leftovers: z.array(z.string()).max(80).default([]).describe('ID còn sót, không xoá được'),
  note: z.string().max(800).optional(),
};
export type CancelPayload = { removed: string[]; leftovers: string[]; note?: string };

export const failureShape = {
  reason: z.string().min(1).max(1500).describe('Lý do bằng tiếng Việt, ngắn gọn, nói rõ chủ shop cần làm gì'),
  meta_error: z.string().max(1500).optional().describe('Nguyên văn error.message / error_user_msg của Meta nếu có'),
  leftover_ids: z.array(z.string()).max(80).default([]).describe('ID nháp / creative còn sót chưa dọn được'),
  retryable: z.boolean().default(true).describe('true nếu chủ shop sửa xong (ví dụ mở quyền Drive) có thể /retry'),
};
export type FailurePayload = { reason: string; meta_error?: string; leftover_ids: string[]; retryable: boolean };

export const choiceShape = {
  question: z.string().min(1).max(500),
  options: z
    .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120) }))
    .min(2)
    .max(8),
};

export const budgetShape = {
  campaigns: z
    .array(z.object({ id: z.string(), daily_budget_cents: z.number().int().nullable(), effective_status: z.string() }))
    .max(200)
    .describe('Đọc live từ Meta cho đúng các campaign bridge đưa trong prompt'),
};

// ---------- Soát kết quả ----------

export function copyIssues(variants: Array<CopyVariant & { variant?: number }>, pageText: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  variants.forEach((v, i) => {
    const key = `V${v.variant ?? i + 1}`;
    const issues = checkVariant(v, { pageText });
    if (issues.length) out[key] = issues;
  });
  return out;
}

const NOT_LIVE = (s: string | undefined) => !s || !/^ACTIVE$/i.test(s.trim());

/** Soát bản nháp Claude nộp. Trả về danh sách lỗi (rỗng = chấp nhận). */
export function validateDrafts(brief: Brief, exp: Expected, p: DraftsPayload, limits: JobLimits): string[] {
  const errs: string[] = [];
  const usesPosts = brief.type === 'ADD' && brief.postIds.length > 0;

  if (brief.type === 'NEW') {
    if (p.campaign.existing) errs.push('#NEW phải tạo campaign mới (campaign.existing=false)');
    if (p.campaign.name !== exp.campaignName) errs.push(`Tên campaign phải đúng "${exp.campaignName}" (đang là "${p.campaign.name}")`);
    if (p.campaign.daily_budget_cents !== exp.dailyBudgetCents) errs.push(`daily_budget của campaign phải là ${exp.dailyBudgetCents} cent (đọc lại được ${p.campaign.daily_budget_cents})`);
    if ((p.campaign.bid_strategy ?? '') !== exp.bidStrategy) errs.push(`bid_strategy phải là ${exp.bidStrategy} (đọc lại được ${p.campaign.bid_strategy})`);
    if (!NOT_LIVE(p.campaign.status)) errs.push('Campaign mới đang ACTIVE — chỉ được để nháp / tạm dừng cho tới khi chủ shop duyệt');
    if (p.adset.existing) errs.push('#NEW phải tạo adset mới');
    if (p.adset.name !== exp.adsetName) errs.push(`Tên adset phải đúng "${exp.adsetName}" (đang là "${p.adset.name}")`);
    if (p.adset.countries && [...p.adset.countries].sort().join(',') !== [...brief.countries].sort().join(',')) {
      errs.push(`Adset phải nhắm đúng quốc gia ${brief.countries.join(', ')} (đang là ${p.adset.countries.join(', ')})`);
    }
  } else {
    const b = brief as AddBrief;
    if (!p.campaign.existing) errs.push('#ADD phải dùng campaign có sẵn (campaign.existing=true), không tạo campaign mới');
    if (b.adset.mode === 'new' && p.adset.existing) errs.push('Brief ghi Adset: mới → phải tạo adset mới');
    if (b.adset.mode === 'id' && p.adset.id !== b.adset.id) errs.push(`Brief ghi Adset ${b.adset.id} nhưng kết quả là ${p.adset.id}`);
    if (b.adset.mode === 'new' && !p.adset.copied_from) errs.push('Adset mới phải ghi copied_from = ID adset nguồn đã sao chép target / pixel / bid');
  }
  if (!p.adset.existing && !NOT_LIVE(p.adset.status)) errs.push('Adset mới đang ACTIVE — chỉ được để nháp / tạm dừng');

  if (p.media.length > limits.maxFiles) errs.push(`Tối đa ${limits.maxFiles} file mỗi brief (đang có ${p.media.length})`);

  if (usesPosts) {
    if (p.ads.some((a) => a.variant !== null)) errs.push('Brief dùng Post ID: ad phải có variant=null (không viết copy mới)');
  } else {
    if (!p.product) errs.push('Thiếu thông tin sản phẩm Shopify (product)');
    else if (!/^active$/i.test(p.product.status)) errs.push(`Sản phẩm ${p.product.handle} không ACTIVE (${p.product.status}) — dừng brief bằng report_failure`);
    if (p.variants.length < 2) errs.push('Cần 2–3 phương án copy');
    const nums = p.variants.map((v) => v.variant);
    if (new Set(nums).size !== nums.length) errs.push('Số phương án (variant) bị trùng');
    const issues = copyIssues(p.variants, p.product?.page_text ?? '');
    for (const [k, list] of Object.entries(issues)) errs.push(`${k} vi phạm quy tắc copy: ${list.join('; ')}`);
    for (const a of p.ads) {
      if (a.variant === null || !nums.includes(a.variant)) errs.push(`Ad ${a.id} phải gắn với một phương án copy có trong variants`);
      else if (!a.name.endsWith(` - V${a.variant}`)) errs.push(`Tên ad "${a.name}" phải theo dạng "{Sản phẩm} - {tên file} - V${a.variant}"`);
    }
    if (!p.media.length) errs.push('Thiếu danh sách media đã tải lên Meta');
  }
  const ids = p.ads.map((a) => a.id);
  if (new Set(ids).size !== ids.length) errs.push('ID ad bị trùng');
  return errs;
}
