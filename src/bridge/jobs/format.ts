// Nội dung tin Telegram (HTML) của chế độ BRIEF_HANDLER=claude: tin duyệt, trạng thái, nhãn.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Brief } from '../../agent/brief/parse.ts';
import { escapeHtml as esc, type InlineKeyboard } from '../../shared/telegram.ts';
import type { JobAccount } from './config.ts';
import type { JobRow, JobStatus } from './store.ts';
import type { DraftsPayload } from './validate.ts';

const TG_LIMIT = 4096;

export const STATUS_LABEL: Record<JobStatus, string> = {
  confirm: 'chờ xác nhận lần 2',
  queued: 'đang chờ Claude',
  running: 'Claude đang làm',
  choosing: 'chờ chọn campaign',
  pending_approval: 'chờ duyệt',
  activating: 'đang bật',
  active: 'đang chạy',
  cancelling: 'đang huỷ',
  cancelled: 'đã huỷ',
  failed: 'lỗi (/retry được)',
  rejected: 'bị từ chối',
};

export function briefTitle(job: Pick<JobRow, 'type'>, brief: Brief | null, acc: JobAccount): string {
  if (!brief) return `#${job.type} · ${acc.name}`;
  return brief.type === 'NEW' ? `#NEW · ${brief.account} · ${brief.product}` : `#ADD · ${brief.account} · camp ${brief.camp}`;
}

// ---------- callback_data: bj:{job}:{action}:{version}:{chữ ký} (≤ 64 byte) ----------

export function signButton(secret: string, jobId: number, action: string, version: number): string {
  const sig = createHmac('sha256', secret).update(`bj:${jobId}:${action}:${version}`).digest('base64url').slice(0, 10);
  return `bj:${jobId}:${action}:${version}:${sig}`;
}

export function parseButton(secret: string, data: string): { jobId: number; action: string; version: number } | null {
  const m = /^bj:(\d+):([a-z0-9]{1,4}):(\d+):([A-Za-z0-9_-]{10})$/.exec(data);
  if (!m) return null;
  const expected = signButton(secret, Number(m[1]), m[2], Number(m[3])).slice(-10);
  const a = Buffer.from(expected);
  const b = Buffer.from(m[4]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { jobId: Number(m[1]), action: m[2], version: Number(m[3]) };
}

export function approvalKeyboard(secret: string, jobId: number, version: number, variantCount: number): InlineKeyboard {
  const b = (text: string, action: string) => ({ text, callback_data: signButton(secret, jobId, action, version) });
  const rows = [[b('✅ Duyệt & chạy', 'ok')]];
  if (variantCount >= 2) rows.push(Array.from({ length: Math.min(variantCount, 3) }, (_, i) => b(`Chỉ V${i + 1}`, `v${i + 1}`)));
  const last = [];
  if (variantCount >= 1) last.push(b('✏️ Sửa copy', 'ed'));
  last.push(b('❌ Huỷ', 'cx'));
  rows.push(last);
  return { inline_keyboard: rows };
}

export function confirmKeyboard(secret: string, jobId: number, version: number): InlineKeyboard {
  return {
    inline_keyboard: [[{ text: '✅ Vẫn tạo', callback_data: signButton(secret, jobId, 'yes', version) }, { text: '❌ Huỷ', callback_data: signButton(secret, jobId, 'no', version) }]],
  };
}

export function choiceKeyboard(secret: string, jobId: number, version: number, options: Array<{ label: string }>): InlineKeyboard {
  return { inline_keyboard: options.map((o, i) => [{ text: `${i + 1}. ${o.label}`.slice(0, 64), callback_data: signButton(secret, jobId, `c${i}`, version) }]) };
}

// ---------- Tin duyệt ----------

const postLink = (postId: string) => `https://facebook.com/${postId}`;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function composeApproval(job: JobRow, brief: Brief, p: DraftsPayload, acc: JobAccount, opts: { dry?: boolean } = {}, maxPrimary = 600): string {
  const lines: string[] = [];
  lines.push(`🟡 <b>CHỜ DUYỆT</b> · #${brief.type} · ${esc(brief.account)} · brief #${job.id}${opts.dry ? ' · 🧪 <b>CHẠY THỬ</b>' : ''}`);
  lines.push(`Camp: ${esc(p.campaign.name)}${p.campaign.existing ? ' (có sẵn, giữ nguyên)' : ''}`);
  if (brief.type === 'NEW') {
    const run = brief.runType === 'Auto' ? 'Auto' : `${brief.runType} $${fmt(brief.capUsd ?? 0)}`;
    lines.push(`Budget: $${fmt(brief.budgetUsd)}/ngày · CBO · ${run} · ${brief.countries.join(', ')}`);
    if (brief.startDate) lines.push(`Bắt đầu: ${String(brief.startDate.d).padStart(2, '0')}/${String(brief.startDate.m).padStart(2, '0')}/${brief.startDate.y} (giờ tài khoản)`);
  } else {
    lines.push(p.adset.existing ? `Adset: ${esc(p.adset.name)} (đang chạy)` : `Adset: mới — ${esc(p.adset.name)}${p.adset.copied_from ? `, sao chép target / pixel / bid từ adset ${esc(p.adset.copied_from)}` : ''}`);
  }
  lines.push(`Pixel: ${esc(acc.pixelName)} · Page: ${esc(acc.pageName)}`);

  if (p.media.length) {
    const desc = (list: DraftsPayload['media'], label: string) => {
      const ratios = [...new Set(list.map((m) => m.ratio || '?'))];
      return `${list.length} ${label} (${ratios.join(', ')} ${list.every((m) => !m.warning) ? '✓' : '⚠'})`;
    };
    const parts = [];
    const vids = p.media.filter((m) => m.kind === 'video');
    const imgs = p.media.filter((m) => m.kind === 'image');
    if (vids.length) parts.push(desc(vids, 'video'));
    if (imgs.length) parts.push(desc(imgs, 'ảnh'));
    lines.push(`Creative: ${parts.join(', ')}`);
  } else if (brief.type === 'ADD' && brief.postIds.length) {
    lines.push(`Creative: dùng lại ${brief.postIds.length} bài có sẵn (không tạo bài mới)`);
  }

  const previews: string[] = [];
  const multi = p.media.length > 1;
  const pushPreview = (a: DraftsPayload['ads'][number], label: string) => {
    if (a.preview_feed_url) previews.push(`<a href="${esc(a.preview_feed_url)}">[${label} Feed]</a>`);
    if (a.preview_reels_url) previews.push(`<a href="${esc(a.preview_reels_url)}">[${label} Reels]</a>`);
  };
  const variants = [...p.variants].sort((a, b) => a.variant - b.variant);
  for (const v of variants) {
    lines.push('');
    lines.push(`<b>V${v.variant} · ${esc(v.style)}</b>`);
    lines.push(`Headline: ${esc(v.headline)}`);
    const text = v.primary_text.length > maxPrimary ? v.primary_text.slice(0, maxPrimary) + '…' : v.primary_text;
    lines.push(`Text: ${esc(text)}`);
    lines.push(`Description: ${esc(v.description)}`);
    if (v.reason) lines.push(`Lý do chọn: ${esc(v.reason)}`);
    p.ads
      .filter((a) => a.variant === v.variant)
      .forEach((a) => {
        const mi = p.media.findIndex((m) => m.name === a.media_name);
        const label = multi && a.media_name ? `${esc(a.media_name)} → ` : '';
        if (a.post_id) lines.push(`Post ID: ${label}<code>${esc(a.post_id)}</code> (<a href="${postLink(a.post_id)}">mở bài</a>)`);
        pushPreview(a, multi && mi >= 0 ? `${mi + 1}.V${v.variant}` : `V${v.variant}`);
      });
  }
  if (!variants.length) {
    lines.push('');
    p.ads.forEach((a, i) => {
      lines.push(`Ad ${i + 1}: ${esc(a.name)}${a.post_id ? ` · Post ID <code>${esc(a.post_id)}</code> (<a href="${postLink(a.post_id)}">mở bài</a>)` : ''}`);
      pushPreview(a, `P${i + 1}`);
    });
  }
  if (previews.length) {
    lines.push('');
    lines.push(`Preview: ${previews.join(' ')}`);
  }
  const warnings = [...(JSON.parse(job.warnings_json) as string[]), ...p.warnings, ...p.media.filter((m) => m.warning).map((m) => `${m.name}: ${m.warning}`)];
  if (warnings.length) {
    lines.push('');
    lines.push(`⚠ Cảnh báo:\n${warnings.map((w) => `• ${esc(w)}`).join('\n')}`);
  }
  lines.push('');
  lines.push(
    opts.dry
      ? `<i>🧪 Chạy thử (CLAUDE_DRY_RUN=1): chưa tải media, chưa tạo gì trên Meta — ID là giả. Bấm nút chỉ để thử luồng.</i>`
      : `<i>Bản nháp trong Ads Manager, chưa chạy, chưa tiêu tiền. ID: camp <code>${esc(p.campaign.id)}</code> · adset <code>${esc(p.adset.id)}</code> · ${p.ads.length} ad</i>`,
  );
  const text = lines.join('\n');
  if (text.length > TG_LIMIT && maxPrimary > 120) return composeApproval(job, brief, p, acc, opts, Math.floor(maxPrimary / 2));
  return text.length > TG_LIMIT ? text.slice(0, TG_LIMIT - 20) + '\n…(đã rút gọn)' : text;
}

/** Thay dòng đầu (🟡 CHỜ DUYỆT…) bằng tiêu đề mới, giữ phần còn lại, nối thêm `tail`. */
export function restamp(approvalText: string, newHeader: string, tail = ''): string {
  const nl = approvalText.indexOf('\n');
  const rest = nl >= 0 ? approvalText.slice(nl) : '';
  const out = `${newHeader}${rest}${tail ? `\n\n${tail}` : ''}`;
  return out.length > TG_LIMIT ? out.slice(0, TG_LIMIT - 20) + '\n…(đã rút gọn)' : out;
}

export function helpText(acc: JobAccount): string {
  return [
    '<b>Bot quảng cáo — chế độ Claude (connector, không dùng key)</b>',
    '',
    'Gửi brief dạng:',
    '<pre>#NEW\nTK: H3\nKiểu chạy: Auto\nMức cap ($):\nSản phẩm: 3D Hoodie Raven\nLink SP: https://' +
      esc(acc.shopDomain) +
      '/products/...\nCreative: https://drive.google.com/...\nQuốc gia: US\nBudget/ngày ($): 50\nNgày chạy: hôm nay\nGhi chú copy:</pre>',
    '<pre>#ADD\nTK: H3\nCamp: 120248209112780436\nAdset: mới\nPost ID:\nLink SP: https://' + esc(acc.shopDomain) + '/products/...\nCreative: https://drive.google.com/...\nGhi chú copy:</pre>',
    'Thư mục / file creative trên Drive phải để chế độ <b>Bất kỳ ai có đường liên kết – Người xem</b> (Meta tự tải file qua link).',
    '',
    'Lệnh: /status — các brief đang xử lý · /retry {số brief} — chạy lại brief bị lỗi',
  ].join('\n');
}
