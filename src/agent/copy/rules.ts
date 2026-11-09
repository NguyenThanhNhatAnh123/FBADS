// Bộ quy tắc viết copy (mục "Quy tắc viết copy"). Agent tự soát mọi phương án trước khi gửi duyệt;
// phương án vi phạm bị gửi lại Claude để viết lại.
//
// Lý do danh sách cấm: nghệ sĩ không phải người bản địa → tránh vi phạm Indian Arts and Crafts Act.

export const STYLES = ['first_person_story', 'gift_giver', 'product_detail'] as const;
export type CopyStyle = (typeof STYLES)[number];

export interface CopyVariant {
  style: CopyStyle;
  primary_text: string;
  headline: string;
  description: string;
  reason: string;
}

// Cụm được phép — gỡ ra trước khi soát để không bắt nhầm.
const ALLOWED_PHRASES = [
  /native[\s-]+american[\s-]+inspired/gi,
  /native[\s-]+inspired/gi,
  /inspired\s+by\s+(the\s+)?native(\s+american)?\s+(art|artwork|designs?|patterns?|motifs?|traditions?|culture)/gi,
  /pacific\s+northwest[\s–—-]+inspired/gi,
  /indigenous[\s-]+inspired/gi,
];

// Tên bộ tộc / dân tộc cụ thể (không đầy đủ, ưu tiên các tên hay gặp trong ngách sản phẩm).
const TRIBE_NAMES = [
  'navajo', 'diné', 'cherokee', 'sioux', 'lakota', 'nakota', 'apache', 'hopi', 'zuni', 'pueblo',
  'cree', 'ojibwe', 'ojibwa', 'chippewa', 'anishinaabe', 'iroquois', 'haudenosaunee', 'mohawk', 'oneida', 'seneca',
  'haida', 'tlingit', 'tsimshian', 'kwakiutl', "kwakwaka'wakw", 'salish', 'nuu-chah-nulth',
  'choctaw', 'chickasaw', 'seminole', 'muscogee', 'comanche', 'cheyenne', 'arapaho', 'blackfoot', 'blackfeet',
  'shoshone', 'ute', 'paiute', 'pawnee', 'osage', 'kiowa', 'nez perce', 'inuit', 'yupik', 'métis', 'metis',
  "mi'kmaq", 'mikmaq', 'potawatomi', 'menominee', 'ho-chunk', 'winnebago', 'shawnee', 'lenape',
  'tohono', 'pima', 'yaqui', 'mohican', 'wampanoag', 'abenaki', 'assiniboine', 'gros ventre', 'mandan', 'hidatsa',
  'arikara', 'yakama', 'umatilla', 'klamath', 'modoc', 'hupa', 'pomo', 'miwok', 'chumash',
];
// Tên trùng từ thường (con quạ, con suối, tên bang...) — chỉ tính khi đi kèm nation/tribe/people/style...
const TRIBE_NAMES_AMBIGUOUS = ['crow', 'creek', 'dakota', 'chinook', 'delaware', 'huron', 'cayuga', 'mohave', 'mojave', 'dine'];
const TRIBE_SUFFIX = '(nation|nations|tribe|tribes|tribal|people|peoples|pattern|patterns|style|design|designs|art|artwork|beadwork|regalia)';

interface BanRule {
  re: RegExp;
  why: string;
}

const BANNED: BanRule[] = [
  { re: /\bauthentic(ally|ity)?\b/i, why: 'dùng từ "authentic"' },
  { re: /\bgenuine\b/i, why: 'dùng từ "genuine" (gợi ý hàng bản địa thật)' },
  { re: /\bnative[\s-]*made\b/i, why: 'dùng "Native-made"' },
  { re: /\btribal[\s-]*made\b/i, why: 'dùng "tribal-made"' },
  { re: /\bindian[\s-]*made\b/i, why: 'dùng "Indian-made"' },
  { re: /\b(native|indigenous|tribal)[\s-]*(owned|crafted|handcrafted|produced)\b/i, why: 'gợi ý sản phẩm do người bản địa làm/sở hữu' },
  {
    re: /\b(made|crafted|handcrafted|hand[\s-]?made|created|designed|painted|drawn|carved|sewn|woven|beaded|produced|illustrated)\s+by\s+(an?\s+|our\s+|the\s+)?(native|indigenous|tribal|first\s+nations?|american\s+indian|indian|tribe)/i,
    why: 'gợi ý sản phẩm do người bản địa làm ("made by Native ...")',
  },
  {
    re: /\b(native|indigenous|tribal|first\s+nations?)\s+(american\s+)?(artists?|artisans?|makers?|craftsm[ae]n|craftspeople|designers?|elders?)\b/i,
    why: 'nhắc "Native artist/artisan" (gợi ý người bản địa làm ra)',
  },
  { re: /\bfrom\s+(the\s+)?(reservation|rez|tribe)\b/i, why: 'gợi ý nguồn gốc bản địa' },
  { re: /\b(certified|official)\s+(native|tribal|indian)\b/i, why: 'gợi ý chứng nhận bản địa' },
  { re: /\bsupport(s|ing)?\s+(native|indigenous|tribal)\s+(artists?|communit(y|ies)|families|tribes?)\b/i, why: 'gợi ý tiền ủng hộ cộng đồng bản địa' },
  // Sức khoẻ / tâm linh có tác dụng thật
  { re: /\b(heals?|healing|cures?|curing|therapeutic|medicinal)\b/i, why: 'hứa hẹn tác dụng sức khoẻ' },
  { re: /\b(protects?|protection|shields?|guards?)\s+(you|your|against|from)\b/i, why: 'hứa hẹn bảo vệ / tác dụng tâm linh' },
  { re: /\bwards?\s+off\b/i, why: 'hứa hẹn xua đuổi (tâm linh)' },
  { re: /\bspiritual\s+(protection|healing|power|energy)\b/i, why: 'hứa hẹn tác dụng tâm linh' },
  { re: /\b(brings?|attracts?)\s+(good\s+)?(luck|fortune|prosperity|abundance)\b/i, why: 'hứa hẹn may mắn' },
  { re: /\bblessed\s+by\b/i, why: 'gợi ý được ban phước (tâm linh)' },
  { re: /\b(sacred|magical?)\s+powers?\b/i, why: 'hứa hẹn sức mạnh tâm linh' },
];

// Ưu đãi / khan hiếm: chỉ được dùng khi trang sản phẩm có ghi.
const OFFER_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bbuy\s+(\d+|one|two|three|four|five)\s*,?\s*get\s+(\d+|one|two|three)(\s+free)?\b/i, why: 'ưu đãi mua X tặng Y' },
  { re: /\b\d{1,2}\s?%\s*off\b/i, why: 'giảm giá %' },
  { re: /\$\d+(\.\d{2})?\s*off\b/i, why: 'giảm giá $' },
  { re: /\bfree\s+shipping\b/i, why: 'free shipping' },
  { re: /\b(bogo|sale|discount|clearance|coupon|promo\s*code)\b/i, why: 'giảm giá / khuyến mãi' },
  { re: /\bonly\s+\d+\s+(left|remaining)\b/i, why: 'số lượng còn lại' },
  { re: /\b(limited\s+(time|stock|edition|quantities)|while\s+supplies\s+last|selling\s+fast|almost\s+gone|last\s+chance)\b/i, why: 'khan hiếm / hạn chót' },
  { re: /\b(ends?|ending)\s+(today|tonight|soon|at\s+midnight|this\s+week(end)?|sunday|monday)\b/i, why: 'hạn chót' },
  { re: /\b(hurry|act\s+now|don'?t\s+miss\s+out|today\s+only|24\s*hours?\s+only)\b/i, why: 'thúc giục theo hạn chót' },
];

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function countEmoji(s: string): number {
  return (s.match(EMOJI_RE) ?? []).length;
}

function stripAllowed(s: string): string {
  let out = s;
  for (const re of ALLOWED_PHRASES) out = out.replace(re, ' ');
  return out;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

/** Có cả câu/dòng viết IN HOA không (≥ 10 chữ cái, ≥ 2 từ, không có chữ thường). */
export function hasAllCapsSentence(s: string): string | null {
  const pieces = s.split(/(?<=[.!?])\s+|\n+/);
  for (const p of pieces) {
    const letters = p.replace(/[^\p{L}]/gu, '');
    const words = p.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
    if (letters.length >= 10 && words.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return p.trim();
  }
  return null;
}

export interface CheckContext {
  pageText: string;
}

/** Trả về danh sách vi phạm (tiếng Việt) của một phương án; rỗng = đạt. */
export function checkVariant(v: CopyVariant, ctx: CheckContext): string[] {
  const issues: string[] = [];
  const all = [v.primary_text, v.headline, v.description].join('\n');
  const scan = stripAllowed(all);

  if (!STYLES.includes(v.style)) issues.push(`style "${v.style}" không thuộc ${STYLES.join(', ')}`);

  for (const r of BANNED) {
    const m = r.re.exec(scan);
    if (m) issues.push(`Từ/cụm bị cấm: "${m[0]}" — ${r.why}`);
  }
  const lowered = normalizeForMatch(scan);
  for (const t of TRIBE_NAMES) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(t)}($|[^\\p{L}])`, 'iu');
    if (re.test(lowered)) issues.push(`Có tên bộ tộc cụ thể: "${t}"`);
  }
  for (const t of TRIBE_NAMES_AMBIGUOUS) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(t)}\\s+${TRIBE_SUFFIX}($|[^\\p{L}])`, 'iu');
    if (re.test(lowered)) issues.push(`Có tên bộ tộc cụ thể: "${t}"`);
  }

  const page = normalizeForMatch(ctx.pageText);
  for (const o of OFFER_PATTERNS) {
    const m = o.re.exec(all);
    if (m && !page.includes(normalizeForMatch(m[0]))) issues.push(`Nhắc ${o.why} ("${m[0]}") nhưng trang sản phẩm không ghi — không tự nghĩ ra ưu đãi/hạn chót`);
  }

  const caps = hasAllCapsSentence(all);
  if (caps) issues.push(`Có câu viết IN HOA toàn bộ: "${caps.slice(0, 60)}"`);
  const emoji = countEmoji(all);
  if (emoji > 3) issues.push(`Dùng ${emoji} emoji (tối đa 3 mỗi phương án)`);

  // Cấu trúc
  const hl = v.headline.trim();
  const hlWords = hl.split(/\s+/).filter(Boolean).length;
  if (hl.length > 40) issues.push(`headline dài ${hl.length} ký tự (tối đa 40)`);
  if (hlWords < 4 || hlWords > 7) issues.push(`headline có ${hlWords} từ (cần 4–7 từ)`);
  const lines = v.primary_text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 6) issues.push(`primary_text có ${lines.length} dòng (cần 3–6 dòng ngắn)`);
  const hook = (lines[0] ?? '').split(/(?<=[.!?…])\s/)[0] ?? '';
  if (hook.length >= 125) issues.push(`câu hook dài ${hook.length} ký tự (cần dưới 125)`);
  const desc = v.description.trim();
  if (desc.length >= 30) issues.push(`description dài ${desc.length} ký tự (cần dưới 30)`);
  if (!desc) issues.push('description trống');
  return issues;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
