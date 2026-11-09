// Soát lại SAU mỗi lượt `claude -p`: đọc nhật ký phiên (~/.claude/projects/<thư mục lượt chạy>/<session_id>.jsonl),
// liệt kê mọi lần gọi tool có ghi dữ liệu và đánh dấu bất thường. Đây là lớp kiểm tra bằng code cho những gì
// danh sách tool không khoá được tới mức tham số — chủ yếu graphql_mutation của Shopify (cấp cho lượt create
// để đưa media qua Shopify Files) — và các lệnh Meta chạm vào object ngoài brief.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunKind } from './store.ts';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string; // nội dung tool_result (để biết file Shopify nào do lượt này tạo)
}

export interface AuditResult {
  found: boolean; // có đọc được nhật ký không
  writes: string[]; // tóm tắt các lần gọi có ghi dữ liệu
  anomalies: string[]; // bất thường (tiếng Việt)
}

const FB = 'mcp__claude_ai_Facebook_Ads__';
const SHOP = 'mcp__claude_ai_Shopify__';
const DRIVE = 'mcp__claude_ai_Google_Drive__';

/** Claude Code lưu phiên theo thư mục làm việc, đổi mọi ký tự không phải chữ / số thành "-". */
export function transcriptPath(workDir: string, sessionId: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string {
  return path.join(configDir, 'projects', path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** Các lần gọi tool của model (bỏ dòng trùng api-request-blob). */
export function readToolCalls(file: string): ToolCall[] | null {
  if (!fs.existsSync(file)) return null;
  const out: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j: { type?: string; message?: { content?: unknown } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(j.message?.content)) continue;
    for (const b of j.message!.content as Block[]) {
      if (j.type === 'assistant' && b.type === 'tool_use' && b.name) {
        const id = b.id ?? `${out.length}`;
        if (byId.has(id)) continue;
        const call = { id, name: b.name, input: b.input ?? {} };
        byId.set(id, call);
        out.push(call);
      } else if (j.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const call = byId.get(b.tool_use_id);
        if (!call || call.result !== undefined) continue;
        call.result = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n') : JSON.stringify(b.content ?? '');
      }
    }
  }
  return out;
}

/** Tên các trường gốc của một thao tác GraphQL, ví dụ "mutation X($a: T) { fileCreate(...) { … } }" → ["fileCreate"]. */
export function graphqlRootFields(q: string): string[] {
  const s = q.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n]*/g, '');
  const start = s.indexOf('{');
  if (start < 0) return [];
  const out: string[] = [];
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (ch === '(') {
      let d = 1;
      i++;
      while (i < s.length && d > 0) {
        if (s[i] === '(') d++;
        else if (s[i] === ')') d--;
        i++;
      }
      i--;
      continue;
    }
    if (depth === 1 && /[A-Za-z_]/.test(ch)) {
      const m = /^([A-Za-z_]\w*)(\s*:\s*([A-Za-z_]\w*))?/.exec(s.slice(i));
      if (m) {
        if (m[1] !== 'on' && m[1] !== '...') out.push(m[3] ?? m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return out;
}

const SHOP_ALLOWED_MUTATIONS = new Set(['fileCreate', 'fileDelete']);
const META_WRITE = ['ads_creative_upload_media', 'ads_create_creative', 'ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_update_entity', 'ads_creative_delete', 'ads_activate_entity'];
const RISKY_UPDATE_FIELDS = ['daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy', 'targeting', 'spend_cap', 'objective'];

const short = (v: unknown, n = 120) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

export interface AuditContext {
  kind: RunKind;
  /** ID Meta lượt activate được phép bật (campaign / adset / ad của brief). */
  approvedIds?: string[];
  /** ID Meta thuộc brief này (bản nháp đã nộp): sửa / xoá trên chính chúng không bị coi là bất thường. */
  ownIds?: string[];
}

/** Soát các lần gọi tool của một lượt. */
export function auditCalls(calls: ToolCall[], ctx: AuditContext): Omit<AuditResult, 'found'> {
  const writes: string[] = [];
  const anomalies: string[] = [];
  const createdShopFiles = new Set<string>();

  for (const c of calls) {
    const tool = c.name;
    if (tool === SHOP + 'graphql_mutation') {
      const q = String(c.input.query ?? '');
      const roots = graphqlRootFields(q);
      writes.push(`shopify ${roots.join(',') || '?'}`);
      if (ctx.kind !== 'create') anomalies.push(`Shopify graphql_mutation trong lượt ${ctx.kind} (chỉ lượt create được dùng)`);
      const bad = roots.filter((r) => !SHOP_ALLOWED_MUTATIONS.has(r));
      if (!roots.length || bad.length) anomalies.push(`Shopify mutation ngoài phạm vi: ${bad.join(', ') || short(q)} (chỉ được fileCreate / fileDelete)`);
      if (roots.includes('fileCreate') && c.result) for (const m of c.result.matchAll(/gid:\/\/shopify\/\w+\/\d+/g)) createdShopFiles.add(m[0]);
      if (roots.includes('fileDelete')) {
        const ids = (c.input.variables as { fileIds?: string[] } | undefined)?.fileIds ?? [...q.matchAll(/gid:\/\/shopify\/\w+\/\d+/g)].map((m) => m[0]);
        const foreign = ids.filter((id) => !createdShopFiles.has(id));
        if (foreign.length) anomalies.push(`fileDelete xoá file không do lượt này tạo: ${foreign.join(', ')}`);
      }
      continue;
    }
    if (tool.startsWith(SHOP) && !/__(search_products|get-product|graphql_query|get-shop-info|graphql_schema|search_docs_chunks)$/.test(tool)) {
      writes.push(`shopify ${tool.slice(SHOP.length)}`);
      anomalies.push(`Gọi tool Shopify có ghi dữ liệu: ${tool.slice(SHOP.length)}`);
      continue;
    }
    if (tool.startsWith(DRIVE) && !/__(get_file_metadata|search_files|read_file_content|download_file_content)$/.test(tool)) {
      writes.push(`drive ${tool.slice(DRIVE.length)}`);
      anomalies.push(`Gọi tool Drive có ghi dữ liệu: ${tool.slice(DRIVE.length)}`);
      continue;
    }
    if (tool.startsWith(FB)) {
      const name = tool.slice(FB.length);
      if (!META_WRITE.includes(name)) continue;
      const entity = String(c.input.entity_id ?? c.input.creative_id ?? c.input.campaign_id ?? c.input.ad_set_id ?? '');
      writes.push(`meta ${name}${entity ? ` ${entity}` : ''}`);
      if (name === 'ads_activate_entity') {
        if (ctx.kind !== 'activate') anomalies.push(`ads_activate_entity trong lượt ${ctx.kind}`);
        else if (ctx.approvedIds && !ctx.approvedIds.includes(entity)) anomalies.push(`Bật object ngoài danh sách được duyệt: ${entity}`);
      }
      const own = !!entity && ((ctx.ownIds ?? []).includes(entity) || (ctx.approvedIds ?? []).includes(entity));
      if (name === 'ads_update_entity' && !own) {
        let fields: Record<string, unknown> = {};
        try {
          fields = typeof c.input.fields === 'string' ? JSON.parse(c.input.fields) : ((c.input.fields as Record<string, unknown>) ?? {});
        } catch {
          /* fields không phải JSON */
        }
        const risky = Object.keys(fields).filter((k) => RISKY_UPDATE_FIELDS.includes(k));
        if (risky.length) anomalies.push(`ads_update_entity đổi ${risky.join(', ')} trên ${entity}`);
        const st = String(fields.status ?? '').toUpperCase();
        if (st === 'DELETED' || st === 'ARCHIVED') anomalies.push(`ads_update_entity đặt ${st} cho ${entity}`);
      }
    }
  }
  return { writes, anomalies };
}

/** Đọc nhật ký và soát một lượt. Không thấy nhật ký → found=false (không coi là bất thường). */
export function auditRun(workDir: string, sessionId: string | null | undefined, ctx: AuditContext): AuditResult {
  if (!sessionId) return { found: false, writes: [], anomalies: [] };
  const calls = readToolCalls(transcriptPath(workDir, sessionId));
  if (!calls) return { found: false, writes: [], anomalies: [] };
  return { found: true, ...auditCalls(calls, ctx) };
}
