// `claude -p` giả cho test: đọc prompt từ stdin, kết nối server MCP "adsjob" trong --mcp-config,
// diễn lại việc Claude thật sẽ làm (theo kịch bản trong brief) rồi in JSON kết quả như --output-format json.
//
// Kịch bản theo chữ trong brief:
//   SILENT   → thoát mà không báo gì (lượt chạy lại thì làm bình thường)
//   FAILME   → report_failure
//   BADCOPY  → nộp copy vi phạm trước, bị trả lỗi thì nộp lại copy đúng
//   Camp chữ (không phải số) và chưa chọn → need_choice

import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const prompt = fs.readFileSync(0, 'utf8');
const logFile = process.env.FAKE_CLAUDE_LOG;
const m = /<<RUN (\w+) job=(\d+) run=(\d+)>>/.exec(prompt);
const kind = m?.[1] ?? 'unknown';
if (logFile) {
  fs.appendFileSync(
    logFile,
    JSON.stringify({ kind, job: Number(m?.[2]), run: Number(m?.[3]), argv, cwd: process.cwd(), hasBotToken: !!process.env.TG_BOT_TOKEN, hasApiKey: !!process.env.ANTHROPIC_API_KEY, hasMetaReadToken: !!process.env.META_READ_TOKEN, hasDriveCredentials: !!process.env.DRIVE_SERVICE_ACCOUNT_JSON }) + '\n',
  );
}

// Nhật ký phiên giống Claude Code (để audit.ts soát lại): chỉ ghi khi test đặt CLAUDE_CONFIG_DIR.
const transcript: string[] = [];
let toolSeq = 0;
function logCall(name: string, input: Record<string, unknown>, result: string) {
  const id = `toolu_fake_${++toolSeq}`;
  transcript.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }));
  transcript.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }] }] } }));
}
function flushTranscript() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return;
  const proj = `${dir}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}`;
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(`${proj}/fake-${m?.[3]}.jsonl`, transcript.join('\n') + '\n');
}

const done = (result: string, extra: Record<string, unknown> = {}) => {
  flushTranscript();
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: `fake-${m?.[3]}`, num_turns: 5, total_cost_usd: 0, permission_denials: [], ...extra }) + '\n');
  process.exit(0);
};

if (kind === 'create' && /SILENT/.test(prompt) && !/lượt chạy lại/.test(prompt)) done('Tôi quên gọi submit.');

const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config')!, 'utf8'));
const url = cfg.mcpServers.adsjob.url as string;
const client = new Client({ name: 'fake-claude', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  logCall(`mcp__adsjob__${name}`, args, r.content[0].text);
  return { ...JSON.parse(r.content[0].text), _isError: !!r.isError };
}

const job = await call('get_job');
const brief = job.brief;
const exp = job.expected;
await call('report_progress', { text: `Đang làm lượt ${kind}…` });

const GOOD = [
  {
    variant: 1,
    style: 'first_person_story',
    headline: 'For the Man Drawn to the Wild',
    primary_text: "People think I'm crazy for wearing my raven hoodie everywhere.\nThe deep black and turquoise feathers catch every eye.\nPrinted on both sides, soft inside.\nTap to pick your size.",
    description: 'Soft fleece, 2-sided print',
    reason: 'Video có người mặc thật',
  },
  {
    variant: 2,
    style: 'gift_giver',
    headline: 'For the Woman Who Notices Nature',
    primary_text: "She says she doesn't need anything.\nBut this raven hoodie in black and turquoise says otherwise.\nNative-inspired art on both sides.\nSee it and choose her size.",
    description: "A gift she'll wear daily",
    reason: 'A/B góc tặng quà',
  },
];

function drafts(variants = GOOD, suffix = '') {
  const product = brief.product ?? 'Hoodie';
  const isAdd = brief.type === 'ADD';
  const usesPosts = isAdd && brief.postIds.length > 0;
  const campId = job.args.campId ?? (isAdd ? brief.camp : 'c-draft-1');
  return {
    product: usesPosts ? null : { title: product, handle: brief.productHandle ?? 'h', status: 'ACTIVE', price: '$49.99', page_text: 'Soft hoodie, printed on both sides.' },
    campaign: isAdd
      ? { id: String(campId), name: `Dân - Auto - ${product} - 01/11/2026`, existing: true, daily_budget_cents: 5000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'ACTIVE' }
      : { id: campId, name: exp.campaignName, existing: false, daily_budget_cents: exp.dailyBudgetCents, bid_strategy: exp.bidStrategy, status: 'DRAFT' },
    adset: isAdd
      ? brief.adset.mode === 'new'
        ? { id: 'as-new', name: 'Dân - Auto - X - US', existing: false, copied_from: 'as-src', status: 'DRAFT' }
        : { id: 'as-live', name: 'Dân - Auto - X - US', existing: true, status: 'ACTIVE' }
      : { id: 'as-draft-1', name: exp.adsetName, existing: false, countries: brief.countries, status: 'DRAFT' },
    media: usesPosts ? [] : [{ name: 'raven.mp4', kind: 'video', meta_id: 'vid-1', ratio: '9:16', duration_s: 20 }],
    variants: usesPosts ? [] : variants,
    ads: usesPosts
      ? brief.postIds.map((p: string, i: number) => ({ id: `ad-p${i}`, name: `${product} - ${p}`, variant: null, creative_id: `cr-p${i}`, post_id: p }))
      : variants.map((v) => ({
          id: `ad-${v.variant}${suffix}`,
          name: `${product} - raven - V${v.variant}`,
          variant: v.variant,
          media_name: 'raven.mp4',
          creative_id: `cr-${v.variant}${suffix}`,
          post_id: `101065259399535_90${v.variant}`,
          preview_feed_url: `https://fb.example/preview/${v.variant}`,
        })),
    warnings: [],
  };
}

if (kind === 'create') {
  if (/FAILME/.test(prompt)) {
    await call('report_failure', { reason: 'Thư mục Drive chưa mở quyền xem bằng link', meta_error: '(#100) Unable to download media', leftover_ids: [], retryable: true });
    done('failed');
  }
  if (brief.type === 'ADD' && !/^\d+$/.test(brief.camp) && !job.args.campId) {
    await call('need_choice', { question: `Camp "${brief.camp}" khớp 2 campaign, chọn một:`, options: [{ id: '111111', label: 'Dân - Auto - Hoodie A · ACTIVE' }, { id: '222222', label: 'Dân - CC - Hoodie B · ACTIVE' }] });
    done('asked');
  }
  if (job.limits && /campaign bridge đang quản lý/.test(prompt)) {
    const ids = [...prompt.matchAll(/object_ids=(\[[^\]]*\])/g)].map((x) => JSON.parse(x[1]))[0] ?? [];
    const cents = /BIGTOTAL/.test(prompt) ? 140000 : 5000; // BIGTOTAL: giả lập các camp đang chạy đã gần chạm trần
    const r = await call('check_budget', { campaigns: ids.map((id: string) => ({ id, daily_budget_cents: cents, effective_status: 'ACTIVE' })) });
    if (r.stop) done('stopped by budget');
  }
  if (!/CHẠY THỬ/.test(prompt) && !(brief.type === 'ADD' && brief.postIds.length)) {
    // Đưa media qua Shopify Files như prompt thật: fileCreate → (Meta upload) → fileDelete đúng file vừa tạo.
    const SM = 'mcp__claude_ai_Shopify__graphql_mutation';
    logCall(SM, { query: 'mutation fileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { message } } }', variables: { files: [{ originalSource: 'https://drive.usercontent.google.com/download?id=X&export=download&confirm=t', contentType: 'VIDEO' }] } }, '{"data":{"fileCreate":{"files":[{"id":"gid://shopify/Video/111","fileStatus":"UPLOADED"}]}}}');
    logCall('mcp__claude_ai_Facebook_Ads__ads_creative_upload_media', { ad_account_id: '25496622559924808', upload_source: 'URL', media_type: 'VIDEO', media_url: 'https://cdn.shopify.com/videos/raven.mp4' }, '{"video_id":"vid-1"}');
    logCall(SM, { query: 'mutation fileDelete($fileIds: [ID!]!) { fileDelete(fileIds: $fileIds) { deletedFileIds } }', variables: { fileIds: ['gid://shopify/Video/111'] } }, '{"data":{"fileDelete":{"deletedFileIds":["gid://shopify/Video/111"]}}}');
    if (/BADMUTATION/.test(prompt)) logCall(SM, { query: 'mutation { productUpdate(input: {id: "gid://shopify/Product/1", title: "x"}) { product { id } } }' }, '{"data":{}}');
  }
  await call('check_copy', { variants: GOOD, product_page_text: 'Soft hoodie' });
  if (/BADCOPY/.test(prompt)) {
    const bad = [{ ...GOOD[0], headline: 'Authentic Native-made Raven Hoodie' }, GOOD[1]];
    const r = await call('submit_drafts', drafts(bad));
    if (!r._isError) throw new Error('copy vi phạm mà bridge vẫn nhận');
  }
  const r = await call('submit_drafts', drafts());
  if (r._isError) throw new Error(`submit_drafts bị trả: ${JSON.stringify(r.errors)}`);
  done('drafts ok');
}

if (kind === 'edit') {
  const v = GOOD.map((x) => ({ ...x, headline: x.variant === 1 ? 'For the Man Who Loves Ravens' : x.headline }));
  const r = await call('submit_drafts', drafts(v, 'e'));
  if (r._isError) throw new Error(`submit_drafts (edit) bị trả: ${JSON.stringify(r.errors)}`);
  done('edited');
}

if (kind === 'activate') {
  const cur = job.current_drafts;
  const chosen = job.args.variants === 'all' ? null : job.args.variants;
  const ads = cur.ads.filter((a: any) => !chosen || chosen.includes(a.variant));
  const others = cur.ads.filter((a: any) => !ads.includes(a));
  const results = [
    ...(cur.campaign.existing ? [] : [{ id: 'c-live-1', level: 'campaign', effective_status: 'ACTIVE', ok: true }]),
    ...(cur.adset.existing ? [] : [{ id: 'as-live-1', level: 'ad_set', effective_status: 'ACTIVE', ok: true }]),
    ...ads.map((a: any) => ({ id: a.id.replace('ad-', 'ad-live-'), level: 'ad', effective_status: 'PENDING_REVIEW', ok: true })),
  ];
  await call('submit_activation', { results, discarded: others.map((a: any) => a.id), errors: [] });
  done('activated');
}

if (kind === 'cancel') {
  const cur = job.current_drafts;
  await call('submit_cancel', { removed: [cur.campaign.id, cur.adset.id, ...cur.ads.map((a: any) => a.id), ...cur.ads.map((a: any) => a.creative_id)], leftovers: [] });
  done('cancelled');
}

done(`unknown kind ${kind}`);
