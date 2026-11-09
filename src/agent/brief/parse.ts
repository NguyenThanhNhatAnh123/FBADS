// Đọc brief Telegram (#NEW / #ADD): dòng đầu là lệnh, các dòng sau dạng `Tên: giá trị`.
// Không phân biệt hoa thường / dấu tiếng Việt, bỏ qua dòng trống. Trả về brief đã chuẩn hoá
// hoặc danh sách lỗi (gửi trong đúng một tin, không tạo gì trên Meta).

import { COUNTRY_ALIASES, COUNTRY_CODES } from './countries.ts';
import { calendarDate } from '../../shared/time.ts';

export type RunType = 'Auto' | 'CC' | 'BidCap';

export interface DriveRef {
  kind: 'file' | 'folder' | 'unknown';
  id: string;
  url: string;
}

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export interface NewBrief {
  type: 'NEW';
  account: string;
  runType: RunType;
  capUsd: number | null;
  product: string;
  productUrl: string;
  productHandle: string;
  creative: DriveRef;
  countries: string[];
  budgetUsd: number;
  startDate: YMD | null; // null = hôm nay
  copyNote: string;
}

export interface AddBrief {
  type: 'ADD';
  account: string;
  camp: string; // ID hoặc một phần tên
  adset: { mode: 'auto' } | { mode: 'new' } | { mode: 'id'; id: string };
  postIds: string[];
  productUrl: string | null;
  productHandle: string | null;
  creative: DriveRef | null;
  copyNote: string;
}

export type Brief = NewBrief | AddBrief;

export interface ParseContext {
  accountNames: string[];
  pageId: string;
  shopDomain: string; // firstnationslegacy.com
  timezone: string; // múi giờ tài khoản, để hiểu "hôm nay"
  now?: Date;
}

export interface ParseResult {
  brief: Brief | null;
  errors: string[];
  warnings: string[];
}

type FieldKey =
  | 'account'
  | 'runType'
  | 'cap'
  | 'product'
  | 'productUrl'
  | 'creative'
  | 'countries'
  | 'budget'
  | 'startDate'
  | 'copyNote'
  | 'camp'
  | 'adset'
  | 'postIds';

const FIELD_LABEL: Record<FieldKey, string> = {
  account: 'TK',
  runType: 'Kiểu chạy',
  cap: 'Mức cap ($)',
  product: 'Sản phẩm',
  productUrl: 'Link SP',
  creative: 'Creative',
  countries: 'Quốc gia',
  budget: 'Budget/ngày ($)',
  startDate: 'Ngày chạy',
  copyNote: 'Ghi chú copy',
  camp: 'Camp',
  adset: 'Adset',
  postIds: 'Post ID',
};

const KEY_ALIASES: Record<string, FieldKey> = {
  tk: 'account',
  'tai khoan': 'account',
  account: 'account',
  'kieu chay': 'runType',
  kieu: 'runType',
  'muc cap': 'cap',
  cap: 'cap',
  'san pham': 'product',
  sp: 'product',
  'link sp': 'productUrl',
  'link san pham': 'productUrl',
  link: 'productUrl',
  creative: 'creative',
  'link creative': 'creative',
  'quoc gia': 'countries',
  country: 'countries',
  countries: 'countries',
  'budget/ngay': 'budget',
  'budget ngay': 'budget',
  budget: 'budget',
  'ngan sach': 'budget',
  'ngay chay': 'startDate',
  'ghi chu copy': 'copyNote',
  'ghi chu': 'copyNote',
  camp: 'camp',
  campaign: 'camp',
  adset: 'adset',
  'ad set': 'adset',
  'post id': 'postIds',
  'post ids': 'postIds',
  postid: 'postIds',
};

/** Bỏ dấu tiếng Việt, hạ chữ thường, gom khoảng trắng. */
export function normalizeKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

export function detectCommand(text: string): 'NEW' | 'ADD' | null {
  const first = text.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const m = /^#(new|add)\b/i.exec(first);
  return m ? (m[1].toUpperCase() as 'NEW' | 'ADD') : null;
}

/** Tách các dòng `Tên: giá trị`. Dòng không có tên hợp lệ được nối vào Ghi chú copy nếu đang ở trường đó. */
export function splitFields(text: string): { fields: Partial<Record<FieldKey, string>>; unknown: string[] } {
  const lines = text.split(/\r?\n/).slice(1);
  const fields: Partial<Record<FieldKey, string>> = {};
  const unknown: string[] = [];
  let last: FieldKey | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:]{1,32}):\s*(.*)$/.exec(line);
    const key = m ? KEY_ALIASES[normalizeKey(m[1])] : undefined;
    if (m && key) {
      fields[key] = m[2].trim();
      last = key;
    } else if (last === 'copyNote') {
      fields.copyNote = [fields.copyNote, line].filter(Boolean).join('\n');
    } else if (last === 'postIds' && /^[\d_,\s]+$/.test(line)) {
      fields.postIds = [fields.postIds, line].filter(Boolean).join(', ');
    } else {
      unknown.push(line);
    }
  }
  return { fields, unknown };
}

export function parseRunType(v: string): RunType | null {
  const k = normalizeKey(v).replace(/[\s_-]/g, '');
  if (k === 'auto' || k === 'lowestcost') return 'Auto';
  if (k === 'cc' || k === 'costcap') return 'CC';
  if (k === 'bidcap' || k === 'bc') return 'BidCap';
  return null;
}

/** Số tiền USD: chấp nhận "$50", "50.5", "50,5", "1.500" (nghìn). Trả về null nếu không hợp lệ. */
export function parseMoney(v: string): number | null {
  let s = v.replace(/\$|usd/gi, '').replace(/\s/g, '');
  if (!s) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, ''); // dấu phân cách nghìn
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return n > 0 ? n : null;
}

export function parseDriveLink(v: string): DriveRef | null {
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)drive\.google\.com$/.test(url.hostname) && url.hostname !== 'docs.google.com') return null;
  const p = url.pathname;
  let m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(p);
  if (m) return { kind: 'folder', id: m[1], url: v.trim() };
  m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(p);
  if (m) return { kind: 'file', id: m[1], url: v.trim() };
  const id = url.searchParams.get('id');
  if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return { kind: 'unknown', id, url: v.trim() };
  return null;
}

export function parseProductUrl(v: string, shopDomain: string): { url: string; handle: string } | null {
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== shopDomain.toLowerCase().replace(/^www\./, '')) return null;
  const m = /\/products\/([^/?#]+)/.exec(url.pathname);
  if (!m) return null;
  const handle = decodeURIComponent(m[1]).toLowerCase();
  return { url: `https://${url.hostname}/products/${encodeURIComponent(handle)}`, handle };
}

export function parseCountries(v: string): { codes: string[]; bad: string[] } {
  const codes: string[] = [];
  const bad: string[] = [];
  for (const raw of v.split(/[,;\s]+/)) {
    if (!raw) continue;
    let c = raw.toUpperCase();
    c = COUNTRY_ALIASES[c] ?? c;
    if (COUNTRY_CODES.has(c)) {
      if (!codes.includes(c)) codes.push(c);
    } else bad.push(raw);
  }
  return { codes, bad };
}

/** "hôm nay" / trống → null; "dd/MM" hoặc "dd/MM/yyyy" → ngày. Ném lỗi chuỗi nếu sai. */
export function parseStartDate(v: string, tz: string, now = new Date()): YMD | null {
  const k = normalizeKey(v);
  if (!k || k === 'hom nay' || k === 'today' || k === 'nay') return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(k);
  if (!m) throw new Error(`Ngày chạy "${v}" không hiểu — ghi "hôm nay" hoặc dd/MM`);
  const today = calendarDate(tz, now);
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : today.y;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`Ngày chạy "${v}" không tồn tại`);
  const cmp = Date.UTC(y, mo - 1, d) - Date.UTC(today.y, today.m - 1, today.d);
  if (cmp < 0) throw new Error(`Ngày chạy ${v} đã qua (hôm nay theo giờ tài khoản là ${today.d}/${today.m})`);
  if (cmp === 0) return null;
  if (cmp > 90 * 86400_000) throw new Error(`Ngày chạy ${v} xa quá 90 ngày — kiểm tra lại`);
  return { y, m: mo, d };
}

export function parseBrief(text: string, ctx: ParseContext): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cmd = detectCommand(text);
  if (!cmd) return { brief: null, errors: ['Dòng đầu phải là #NEW hoặc #ADD'], warnings };

  const { fields, unknown } = splitFields(text);
  if (unknown.length) warnings.push(`Bỏ qua ${unknown.length} dòng không đúng dạng "Tên: giá trị": ${unknown.slice(0, 3).map((u) => `"${u.slice(0, 40)}"`).join(', ')}`);

  const missing: FieldKey[] = [];
  const need = (k: FieldKey): string => {
    const v = fields[k]?.trim() ?? '';
    if (!v) missing.push(k);
    return v;
  };

  // TK
  const accountRaw = need('account');
  let account = '';
  if (accountRaw) {
    const hit = ctx.accountNames.find((n) => n.toLowerCase() === accountRaw.toLowerCase());
    if (hit) account = hit;
    else errors.push(`TK "${accountRaw}" không có trong danh sách. Tên hợp lệ: ${ctx.accountNames.join(', ')}`);
  }

  const copyNote = fields.copyNote?.trim() ?? '';

  if (cmd === 'NEW') {
    const runRaw = need('runType');
    const runType = runRaw ? parseRunType(runRaw) : null;
    if (runRaw && !runType) errors.push(`Kiểu chạy "${runRaw}" không hợp lệ — chỉ nhận Auto, CC hoặc BidCap`);

    let capUsd: number | null = null;
    const capRaw = fields.cap?.trim() ?? '';
    if (runType === 'CC' || runType === 'BidCap') {
      if (!capRaw) errors.push(`Kiểu chạy ${runType} cần Mức cap ($)`);
      else {
        capUsd = parseMoney(capRaw);
        if (capUsd === null) errors.push(`Mức cap "${capRaw}" không phải số dương`);
      }
    } else if (capRaw && runType === 'Auto') {
      warnings.push('Kiểu chạy Auto nên bỏ qua Mức cap');
    }

    let product = need('product');
    if (product.length > 40) {
      warnings.push(`Tên sản phẩm dài ${product.length} ký tự, đã cắt còn 40: "${product.slice(0, 40).trim()}"`);
      product = product.slice(0, 40).trim();
    }

    const urlRaw = need('productUrl');
    const prod = urlRaw ? parseProductUrl(urlRaw, ctx.shopDomain) : null;
    if (urlRaw && !prod) errors.push(`Link SP phải là trang sản phẩm thuộc ${ctx.shopDomain} (dạng /products/...)`);

    const creativeRaw = need('creative');
    const creative = creativeRaw ? parseDriveLink(creativeRaw) : null;
    if (creativeRaw && !creative) errors.push('Creative phải là link file hoặc thư mục Google Drive');

    const countriesRaw = need('countries');
    let countries: string[] = [];
    if (countriesRaw) {
      const r = parseCountries(countriesRaw);
      countries = r.codes;
      if (r.bad.length) errors.push(`Mã quốc gia không hợp lệ: ${r.bad.join(', ')} (dùng mã 2 chữ, ví dụ US, CA)`);
      else if (!r.codes.length) missing.push('countries');
    }

    const budgetRaw = need('budget');
    const budgetUsd = budgetRaw ? parseMoney(budgetRaw) : null;
    if (budgetRaw && budgetUsd === null) errors.push(`Budget/ngày "${budgetRaw}" không phải số dương`);
    else if (budgetUsd !== null && budgetUsd < 1) errors.push('Budget/ngày tối thiểu $1');

    let startDate: YMD | null = null;
    try {
      startDate = parseStartDate(fields.startDate ?? '', ctx.timezone, ctx.now);
    } catch (e) {
      errors.push((e as Error).message);
    }

    pushMissing(errors, missing);
    if (errors.length) return { brief: null, errors, warnings };
    return {
      brief: {
        type: 'NEW',
        account,
        runType: runType!,
        capUsd,
        product,
        productUrl: prod!.url,
        productHandle: prod!.handle,
        creative: creative!,
        countries,
        budgetUsd: budgetUsd!,
        startDate,
        copyNote,
      },
      errors,
      warnings,
    };
  }

  // ---- #ADD ----
  const camp = need('camp');

  const adsetRaw = fields.adset?.trim() ?? '';
  let adset: AddBrief['adset'] = { mode: 'auto' };
  if (adsetRaw) {
    const k = normalizeKey(adsetRaw);
    if (k === 'moi' || k === 'new') adset = { mode: 'new' };
    else if (/^\d{6,}$/.test(adsetRaw)) adset = { mode: 'id', id: adsetRaw };
    else errors.push(`Adset "${adsetRaw}" không hợp lệ — ghi "mới", ID adset, hoặc để trống`);
  }

  const postIds: string[] = [];
  const postRaw = fields.postIds?.trim() ?? '';
  if (postRaw) {
    for (const p of postRaw.split(/[,;\s]+/).filter(Boolean)) {
      if (!/^\d+_\d+$/.test(p)) errors.push(`Post ID "${p}" sai dạng — cần {page_id}_{post_id}`);
      else if (p.split('_')[0] !== ctx.pageId) errors.push(`Post ID ${p} không thuộc Page của tài khoản (Page ${ctx.pageId})`);
      else if (!postIds.includes(p)) postIds.push(p);
    }
  }

  let productUrl: string | null = null;
  let productHandle: string | null = null;
  let creative: DriveRef | null = null;
  const urlRaw = fields.productUrl?.trim() ?? '';
  const creativeRaw = fields.creative?.trim() ?? '';
  if (!postRaw) {
    if (!urlRaw) missing.push('productUrl');
    if (!creativeRaw) missing.push('creative');
  } else if (creativeRaw) {
    warnings.push('Đã có Post ID nên bỏ qua Creative');
  }
  if (urlRaw) {
    const prod = parseProductUrl(urlRaw, ctx.shopDomain);
    if (!prod) errors.push(`Link SP phải là trang sản phẩm thuộc ${ctx.shopDomain} (dạng /products/...)`);
    else {
      productUrl = prod.url;
      productHandle = prod.handle;
    }
  }
  if (creativeRaw && !postRaw) {
    creative = parseDriveLink(creativeRaw);
    if (!creative) errors.push('Creative phải là link file hoặc thư mục Google Drive');
  }

  pushMissing(errors, missing);
  if (errors.length) return { brief: null, errors, warnings };
  return {
    brief: { type: 'ADD', account, camp, adset, postIds, productUrl, productHandle, creative, copyNote },
    errors,
    warnings,
  };
}

function pushMissing(errors: string[], missing: FieldKey[]): void {
  const uniq = [...new Set(missing)];
  if (uniq.length) errors.unshift(`Thiếu trường bắt buộc: ${uniq.map((k) => FIELD_LABEL[k]).join(', ')}`);
}

/** Khoá so sánh brief trùng: bỏ khoảng trắng, hạ chữ thường. */
export function briefFingerprint(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => normalizeKey(l))
    .filter(Boolean)
    .join('|');
}
