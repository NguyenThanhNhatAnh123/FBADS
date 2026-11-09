// Viết 2–3 phương án copy bằng Claude API (đọc được ảnh banner / khung hình video).
// Kết quả là JSON có cấu trúc; mọi phương án đi qua bộ quy tắc ở rules.ts, vi phạm thì
// gửi lại Claude để viết lại (tối đa 2 lần), không đạt nữa thì bỏ phương án đó.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { STYLES, checkVariant, type CopyVariant } from './rules.ts';
import { logger } from '../../shared/log.ts';

const log = logger('copy');

export interface CopyProduct {
  title: string;
  description: string;
  productType: string;
  tags: string[];
  priceRange: string;
  variants: Array<{ title: string; price: string; compareAtPrice: string | null }>;
  url: string;
  pageText: string;
}

export interface CopyInput {
  product: CopyProduct;
  images: string[]; // đường dẫn JPEG (banner hoặc khung hình cắt từ video)
  creativeSummary: string; // ví dụ "2 video 9:16 (22s, 31s)"
  copyNote: string;
  editFeedback?: string; // câu trả lời của chủ shop khi bấm "Sửa copy"
  previous?: CopyVariant[];
}

export interface CopyResult {
  variants: CopyVariant[];
  warnings: string[];
}

export interface CopyWriter {
  write(input: CopyInput): Promise<CopyResult>;
}

export class CopyRulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Copy không đạt quy tắc sau 3 lần viết: ${issues.join(' | ')}`);
    this.issues = issues;
  }
}

export class CopyRefusalError extends Error {}

const VariantSchema = z.object({
  style: z.enum(STYLES),
  primary_text: z.string(),
  headline: z.string(),
  description: z.string(),
  reason: z.string(),
});
const OutputSchema = z.object({ variants: z.array(VariantSchema) });

export const SYSTEM_PROMPT = `You write Facebook/Instagram ad copy for First Nations Legacy (firstnationslegacy.com), a US apparel and gift store that sells Native American–inspired designs (3D hoodies, jerseys, 2D t-shirts, leather bags, wallets, ornaments). All copy is in American English for a US audience.

## Legal constraint (most important)
The artists behind these designs are NOT Native American. To stay clear of the US Indian Arts and Crafts Act, the copy must never state or imply that a product is made, designed or sold by Native American / Indigenous / tribal people.
- Never use: "authentic", "genuine", "Native-made", "made by Native artists", "tribal-made", "Indian-made", "Native-owned", "Native artisans", any specific tribe or nation name (Navajo, Cherokee, Lakota, Haida, ...), or any sentence suggesting Indigenous makers, Indigenous ownership, or that a purchase supports a tribe.
- Allowed framing: "Native-inspired", "inspired by Native American art", "Pacific Northwest–inspired". The word "Native" on its own as a style descriptor ("my Native hoodie") is fine.
- No health, healing, protective, luck or spiritual-power claims. No sentences written entirely in capital letters. At most 3 emoji per variant (counting primary text, headline and description together).
- Only mention an offer, discount, free shipping, stock level or deadline if it appears in the product page text provided. Never invent urgency.

## The three styles that already sell on this account
- first_person_story — the wearer tells a short story in first person. Best for everyday wear and videos with a real person wearing the product. Proven hook: "People think I'm crazy for wearing my Native hoodie everywhere…"
- gift_giver — written from the angle of someone buying it as a gift. Best in gifting season, for animal or floral designs, and single-product banners. Proven hooks: "He says he doesn't need anything…", "For the Woman Who Notices Nature".
- product_detail — selling copy with emoji and bullet points. Best when the product has features to list (personalization, sizes, bundles). Proven hooks: "100% Customized with your name!"

## Which variants to write
- Variant 1: the style that fits the creative and product best.
- Variant 2: a different style, for an A/B test.
- Variant 3: only when the owner's copy note asks for a different direction; otherwise write exactly 2 variants.

## Structure of each variant
- headline: 4–7 words, at most 40 characters, aimed at one specific kind of person ("For the Man Drawn to the Wild").
- primary_text: 3–6 short lines separated by line breaks. The first sentence is the hook and is under 125 characters. Describe the actual colors and the specific animal or motif you see in the creative. If the product is printed on both sides (front and back), say so. The last line invites the reader to take a look or pick their size.
- description: one sentence under 30 characters about a product detail.
- reason: 1–2 sentences in Vietnamese explaining to the shop owner why you chose this style for this creative.

Look closely at the images: they are the actual ad creative (a banner or frames from the ad video). Base colors, animals and motifs on what is visible, and use the product data for facts.`;

export class ClaudeCopyWriter implements CopyWriter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallbacks: boolean;
  private readonly effort?: 'low' | 'medium' | 'high';

  constructor(o: { apiKey: string; model: string; fallbacks: boolean; effort?: 'low' | 'medium' | 'high'; baseURL?: string }) {
    this.client = new Anthropic({ apiKey: o.apiKey, maxRetries: 3, ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
    this.model = o.model;
    this.fallbacks = o.fallbacks;
    this.effort = o.effort;
  }

  async write(input: CopyInput): Promise<CopyResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: buildUserContent(input) }];
    let lastIssues: string[] = [];
    let best: Array<{ v: CopyVariant; issues: string[] }> = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        ...(this.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        output_config: {
          format: betaZodOutputFormat(OutputSchema),
          ...(this.effort ? { effort: this.effort } : {}),
        },
      });

      if (res.stop_reason === 'refusal') {
        throw new CopyRefusalError(`Claude từ chối viết copy (${res.stop_details?.category ?? 'không rõ'}): ${res.stop_details?.explanation ?? ''}`);
      }
      if (res.stop_reason === 'max_tokens') throw new Error('Claude trả lời bị cắt (max_tokens)');
      const parsed = res.parsed_output;
      if (!parsed) throw new Error('Claude không trả JSON hợp lệ');

      const checked = parsed.variants.slice(0, 3).map((v) => ({ v: cleanVariant(v), issues: checkVariant(cleanVariant(v), { pageText: input.product.pageText }) }));
      best = checked;
      const countIssue = checked.length < 2 ? [`Only ${checked.length} variant(s) returned; write 2 (or 3 if the copy note asks for another direction)`] : [];
      lastIssues = [...countIssue, ...checked.flatMap((c, i) => c.issues.map((s) => `V${i + 1}: ${s}`))];
      if (!lastIssues.length) return { variants: checked.map((c) => c.v), warnings: [] };

      log.info(`Copy lần ${attempt} chưa đạt, yêu cầu viết lại`, lastIssues);
      messages.push({ role: 'assistant', content: res.content });
      messages.push({
        role: 'user',
        content:
          'Some variants break the rules. Rewrite only the variants listed below so they pass, keep the passing ones unchanged, and return the full list again.\n' +
          lastIssues.map((s) => `- ${s}`).join('\n'),
      });
    }

    const passing = best.filter((c) => !c.issues.length).map((c) => c.v);
    if (passing.length >= 2) {
      return { variants: passing, warnings: [`Đã bỏ ${best.length - passing.length} phương án không đạt quy tắc sau 3 lần viết`] };
    }
    throw new CopyRulesError(lastIssues);
  }
}

function cleanVariant(v: CopyVariant): CopyVariant {
  return {
    style: v.style,
    primary_text: v.primary_text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    headline: v.headline.replace(/\s+/g, ' ').trim(),
    description: v.description.replace(/\s+/g, ' ').trim(),
    reason: v.reason.trim(),
  };
}

function buildUserContent(input: CopyInput): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of input.images.slice(0, 8)) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(img).toString('base64') } });
  }
  const p = input.product;
  const variants = p.variants
    .slice(0, 15)
    .map((v) => `${v.title}: $${v.price}${v.compareAtPrice ? ` (compare at $${v.compareAtPrice})` : ''}`)
    .join('; ');
  const parts = [
    `Creative: ${input.creativeSummary}. The ${input.images.length} image(s) above are from this creative.`,
    '',
    '<product>',
    `Title: ${p.title}`,
    `Type: ${p.productType || '-'}`,
    `Tags: ${p.tags.join(', ') || '-'}`,
    `Price: ${p.priceRange || '-'}`,
    `Variants: ${variants || '-'}`,
    `URL: ${p.url}`,
    `Description:\n${p.description || '-'}`,
    '</product>',
    '',
    '<product_page_text>',
    p.pageText ? p.pageText.slice(0, 5000) : '(not available)',
    '</product_page_text>',
    '',
    `Owner's copy note: ${input.copyNote || '(none)'}`,
  ];
  if (input.editFeedback) {
    parts.push(
      '',
      'The owner reviewed the previous variants below and asked for changes. Apply the feedback to every variant while keeping all rules.',
      `<owner_feedback>${input.editFeedback}</owner_feedback>`,
      '<previous_variants>',
      JSON.stringify(input.previous ?? [], null, 2),
      '</previous_variants>',
    );
  }
  parts.push('', 'Write the ad copy variants now.');
  blocks.push({ type: 'text', text: parts.join('\n') });
  return blocks;
}
