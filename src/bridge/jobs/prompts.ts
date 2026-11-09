// Prompt và danh sách tool cho từng loại lượt `claude -p`.
//
// Rào chắn cứng nằm ở danh sách tool, không nằm ở prompt: chạy với --permission-mode dontAsk nên tool
// không có trong allowedTools bị từ chối ngay. Lượt create / edit / cancel KHÔNG có ads_activate_entity,
// mà connector Facebook Ads đang ở draft mode → các lượt đó không thể làm quảng cáo chạy hay tiêu tiền.
// Chỉ lượt activate (sinh ra khi chủ shop bấm Duyệt trên Telegram) mới có ads_activate_entity.

import type { AddBrief, Brief, NewBrief } from '../../agent/brief/parse.ts';
import type { JobAccount, JobLimits } from './config.ts';
import type { JobRow, RunKind } from './store.ts';
import type { DraftsPayload, Expected } from './validate.ts';

const FB = 'mcp__claude_ai_Facebook_Ads__';
const SHOP = 'mcp__claude_ai_Shopify__';
const DRIVE = 'mcp__claude_ai_Google_Drive__';
export const JOB_SERVER = 'adsjob';
const JOB = `mcp__${JOB_SERVER}__`;

const FB_READ = [
  'ads_get_ad_accounts',
  'ads_get_ad_entities',
  'ads_get_ad_account_pages',
  'ads_get_pages_for_business',
  'ads_get_ig_accounts',
  'ads_get_field_context',
  'ads_get_errors',
  'ads_get_ad_videos',
  'ads_get_ad_images',
  'ads_get_creatives',
  'ads_get_creative_ads',
  'ads_get_ad_preview',
  'ads_get_help_article',
  'ads_get_async_result',
];
const FB_BUILD = ['ads_creative_upload_media', 'ads_create_creative', 'ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_update_entity', 'ads_creative_delete'];
const SHOP_READ = ['search_products', 'get-product', 'graphql_query', 'get-shop-info'];
const DRIVE_READ = ['get_file_metadata', 'search_files'];

export const JOB_TOOLS: Record<RunKind, string[]> = {
  create: ['get_job', 'wait', 'report_progress', 'check_budget', 'check_copy', 'need_choice', 'submit_drafts', 'report_failure'],
  edit: ['get_job', 'wait', 'report_progress', 'check_copy', 'submit_drafts', 'report_failure'],
  activate: ['get_job', 'wait', 'report_progress', 'submit_activation', 'report_failure'],
  cancel: ['get_job', 'wait', 'report_progress', 'submit_cancel', 'report_failure'],
};

export function allowedToolsFor(kind: RunKind, dry = false): string[] {
  const job = JOB_TOOLS[kind].map((t) => JOB + t);
  const fbRead = FB_READ.map((t) => FB + t);
  // Chạy thử: chỉ tool ĐỌC — không có tool nào ghi lên Meta (upload, create, update, delete, activate).
  if (dry) return [...fbRead, ...SHOP_READ.map((t) => SHOP + t), ...DRIVE_READ.map((t) => DRIVE + t), ...job];
  switch (kind) {
    case 'create':
      // graphql_mutation CHỈ cho lượt create (đưa media qua Shopify Files); audit.ts soát lại mọi mutation sau lượt chạy.
      return [...fbRead, ...FB_BUILD.map((t) => FB + t), ...SHOP_READ.map((t) => SHOP + t), SHOP + 'graphql_mutation', ...DRIVE_READ.map((t) => DRIVE + t), ...job];
    case 'edit':
      return [...fbRead, ...FB_BUILD.map((t) => FB + t), ...SHOP_READ.map((t) => SHOP + t), ...DRIVE_READ.map((t) => DRIVE + t), ...job];
    case 'activate':
      return [...fbRead, FB + 'ads_activate_entity', FB + 'ads_update_entity', FB + 'ads_creative_delete', ...job];
    case 'cancel':
      return [...fbRead, FB + 'ads_update_entity', FB + 'ads_creative_delete', ...job];
  }
}

/** Cấm thêm (phòng khi settings ở đâu đó cho phép rộng). dontAsk đã chặn mọi tool ngoài allowedTools. */
export function disallowedToolsFor(kind: RunKind, dry = false): string[] {
  const out = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];
  if (kind !== 'activate' || dry) out.push(FB + 'ads_activate_entity');
  if (dry) out.push(...FB_BUILD.map((t) => FB + t));
  if (kind !== 'create' || dry) out.push(SHOP + 'graphql_mutation'); // chỉ lượt create thật được đưa media qua Shopify Files
  out.push(
    FB + 'ads_boost_ig_post',
    FB + 'ads_create_custom_audience',
    FB + 'ads_update_custom_audience',
    FB + 'ads_update_custom_audience_users',
    FB + 'ads_delete_custom_audience',
    FB + 'ads_experiment_abtest_create_test',
    FB + 'ads_experiment_lift_create_test',
    SHOP + 'create-product',
    SHOP + 'update-product',
    SHOP + 'bulk-update-product-status',
    SHOP + 'set-inventory',
    SHOP + 'create-discount',
    SHOP + 'create-collection',
    SHOP + 'update-collection',
    DRIVE + 'share_file',
    DRIVE + 'trash_file',
    DRIVE + 'update_file',
    DRIVE + 'create_file',
  );
  return out;
}

export interface RunArgs {
  variants?: number[] | 'all';
  label?: string; // nhãn nút chủ shop bấm
  note?: string; // yêu cầu sửa copy
  campId?: string; // campaign chủ shop chọn khi #ADD khớp nhiều camp
  auto?: boolean; // tự huỷ sau 72 giờ
  retry?: boolean;
}

export interface PromptContext {
  runId: number;
  kind: RunKind;
  job: JobRow;
  brief: Brief;
  expected: Expected;
  acc: JobAccount;
  limits: JobLimits;
  args: RunArgs;
  previous: DraftsPayload | null;
  leftovers: string[];
  managedActiveCampaignIds: string[];
  dry?: boolean;
}

const COPY_RULES = `QUY TẮC COPY (toàn bộ bằng tiếng Anh Mỹ)
Ba kiểu viết (style) lấy từ các ad đang chạy trên H3:
- first_person_story — người mặc kể chuyện. Dùng khi: áo mặc hằng ngày, video có người mặc thật. Mẫu: "People think I'm crazy for wearing my Native hoodie everywhere…"
- gift_giver — góc người mua tặng quà. Dùng khi: mùa quà tặng, thiết kế con vật hoặc hoa lá, banner sản phẩm đơn. Mẫu: "He says he doesn't need anything…", "For the Woman Who Notices Nature"
- product_detail — bán hàng, emoji + gạch đầu dòng. Dùng khi: sản phẩm có tính năng cần liệt kê (cá nhân hoá, kích cỡ, combo). Mẫu: "100% Customized with your name!"
Mặc định: V1 theo kiểu hợp nhất với creative và sản phẩm, V2 theo kiểu thứ hai để A/B, V3 (tuỳ chọn) chỉ khi Ghi chú copy yêu cầu hướng khác. Ghi lý do chọn (reason, tiếng Việt, 1 câu).
Cấu trúc mỗi phương án:
- headline: 4–7 từ, nhắm vào một kiểu người cụ thể ("For the Man Drawn to the Wild"), tối đa 40 ký tự.
- primary_text: 3–6 dòng ngắn có xuống dòng; câu đầu là hook dưới 125 ký tự; tả màu sắc và con vật cụ thể; nhắc in 2 mặt khi sản phẩm in 2 mặt; câu cuối kêu gọi xem hoặc chọn size.
- description: một câu dưới 30 ký tự về chi tiết sản phẩm.
- Ưu đãi (ví dụ Buy 5 Get 2) chỉ đưa vào khi đọc được trên trang sản phẩm; không tự nghĩ ra giảm giá, số lượng còn lại hay hạn chót.
Bị cấm (nghệ sĩ không phải người bản địa — tránh vi phạm Indian Arts and Crafts Act):
- Không dùng: authentic, genuine, Native-made, made by Native artists, tribal-made, tên bộ tộc cụ thể, bất kỳ câu nào gợi ý sản phẩm do người bản địa làm.
- Được dùng: Native-inspired, inspired by Native American art, Pacific Northwest–inspired.
- Không hứa hẹn sức khoẻ, tâm linh có tác dụng thật; không viết IN HOA cả câu; tối đa 3 emoji mỗi phương án.
Luôn gọi check_copy trước khi tạo creative; còn lỗi thì viết lại.`;

/**
 * Đưa media Drive → Meta qua Shopify Files. Meta không tải được link Drive: robots.txt của
 * drive.usercontent.google.com là "Disallow: /" (lỗi Meta subcode 3858258). Shopify tự kéo được link đó
 * (đã thử 09/11/2026) và trả URL cdn.shopify.com mà Meta tải được. File trung gian bị xoá sau khi Meta có media.
 */
export function mediaViaShopify(jobId: number): string {
  return `Đưa từng file lên Meta QUA SHOPIFY FILES (Meta không tải được link Drive vì robots.txt của Google chặn):
   a. graphql_mutation (Shopify): query "mutation fileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } } }", variables {"files":[{"originalSource":"https://drive.usercontent.google.com/download?id=<FILE_ID>&export=download&confirm=t","contentType":"IMAGE" hoặc "VIDEO","alt":"ads-brief-${jobId} <tên file trên Drive>"}]}. KHÔNG truyền filename (Shopify bắt đuôi khớp link gốc). Có thể gửi nhiều file trong một lần.
   b. graphql_query (Shopify): "{ node(id: \\"<id>\\") { ... on MediaImage { fileStatus fileErrors { code message } image { url width height } } ... on Video { fileStatus fileErrors { code message } duration sources { url mimeType width height } } } }" — wait(10) giữa các lần, tới khi fileStatus READY (tối đa 10 phút). FAILED → dọn và report_failure kèm fileErrors (thường do file Drive chưa để "Bất kỳ ai có đường liên kết"). Ảnh: url = image.url, ghi width / height. Video: url = source video/mp4 có chiều cao lớn nhất, ghi width / height, duration_s = duration / 1000.
   c. ads_creative_upload_media(ad_account_id, upload_source "URL", media_type "IMAGE" / "VIDEO", media_url = URL cdn.shopify.com ở bước b, name = tên file gốc trên Drive). Ảnh → image_hash. Video → video_id; wait(30) rồi ads_get_ad_videos(video_ids=[...]) tới khi status ready (tối đa 10 phút; quá → dọn và report_failure nêu tên file), lấy length và picture (thumbnail).
   d. Khi Meta đã có media (có image_hash, video ready): xoá file trung gian bằng graphql_mutation "mutation fileDelete($fileIds: [ID!]!) { fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { message } } }" với đúng các ID đã tạo ở bước a. Ghi shopify_file_id của từng media khi nộp.
   CHỈ được dùng graphql_mutation cho fileCreate và fileDelete các file do lượt này tạo. Mọi mutation khác (sản phẩm, giá, tồn kho, đơn hàng, khách hàng, discount, theme, metafield...) bị CẤM — bridge đọc lại nhật ký lượt chạy và khoá brief nếu thấy.`;
}

function fbCommon(acc: JobAccount, job: JobRow, advertiserJob: string): string {
  return `THÔNG TIN CỐ ĐỊNH (không hỏi lại)
- Ad account ${acc.name}: ad_account_id "${acc.adAccountId}" (dạng số, không có act_), tiền ${acc.currency}, múi giờ ${acc.timezone}.
- Page: ${acc.pageId} (${acc.pageName}). Pixel: ${acc.pixelId} (${acc.pixelName}). Store Shopify: ${acc.shopDomain}.
- Connector Facebook Ads đang ở DRAFT MODE: ads_create_* chỉ tạo bản nháp trong Ads Manager; chỉ ads_activate_entity mới đưa lên chạy.
- Mọi tool Facebook Ads: advertiser_job = "${advertiserJob}", scheduled_task_run = true, hide_ui = true nếu tool có tham số này, advertiser_request = nguyên văn brief của chủ shop (phần chữ ở mục BRIEF).
- Chỉ dùng các tool được cấp. Tool bị từ chối thì đừng thử lại cách khác để vượt rào — báo bằng report_failure.

BRIEF #${job.id} (chủ shop gửi trên Telegram)
"""
${job.raw_text.trim()}
"""`;
}

function header(c: PromptContext, task: string): string {
  return `Bạn chạy tự động, không có người trực, trong bridge Telegram của shop First Nations Legacy (bán áo, túi, phụ kiện in hoạ tiết lấy cảm hứng từ nghệ thuật bản địa Bắc Mỹ).
<<RUN ${c.kind} job=${c.job.id} run=${c.runId}>>
${task}
Chủ shop KHÔNG đọc câu trả lời cuối của bạn: mọi kết quả chỉ được báo qua tool của server "${JOB_SERVER}" (submit_* / report_failure${c.kind === 'create' ? ' / need_choice' : ''}). Gọi report_progress khi bắt đầu mỗi bước lớn (một câu tiếng Việt ngắn) để chủ shop thấy tiến độ. Báo xong kết quả thì dừng, không gọi thêm tool.`;
}

function money(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function createNew(c: PromptContext, b: NewBrief): string {
  const e = c.expected;
  const acc = c.acc;
  const capLine = e.bidAmountCents ? `, bid_amount ${e.bidAmountCents} (mức cap $${money(b.capUsd!)} theo cent)` : '';
  const startLine = e.startTimeIso ? `, start_time "${e.startTimeIso}" (00:00 ngày chạy theo giờ tài khoản)` : '';
  const budgetStep = c.managedActiveCampaignIds.length
    ? `0. Trần ngân sách: đọc live bằng ads_get_ad_entities (level=campaign, object_ids=${JSON.stringify(c.managedActiveCampaignIds)}) daily_budget và effective_status của các campaign bridge đang quản lý, rồi gọi check_budget với đủ các campaign đó. check_budget trả stop=true → dừng ngay, không tạo gì.\n`
    : '';
  const retryStep =
    c.args.retry || c.leftovers.length
      ? `1. Đây là lượt chạy lại. Tìm bản nháp sót: ads_get_ad_entities (object_state=draft, level=campaign) campaign có tên đúng "${e.campaignName}". Có thì bỏ nó (ads_update_entity discard_draft_changes=true trên campaign đó: gọi xem trước, chỉ gọi lại kèm confirmation_token khi danh sách chỉ gồm campaign / adset / ad có tên bắt đầu bằng "${e.campaignName}"), rồi làm lại từ đầu.${c.leftovers.length ? ` Lượt trước báo còn sót các ID: ${c.leftovers.join(', ')} — creative trong số đó thì xoá bằng ads_creative_delete.` : ''}\n`
      : '1. Lượt chạy đầu: chưa có bản nháp cũ cần dọn.\n';
  return `${header(c, `VIỆC CẦN LÀM: dựng campaign → adset → ad cho brief #NEW dưới đây trên ${acc.name}, CHỈ Ở DẠNG NHÁP, rồi nộp bằng submit_drafts. Không được bật gì.`)}

${fbCommon(acc, c.job, 'create_and_launch_new_ads')}

Brief đã đọc (bridge đã kiểm tra hợp lệ): ${JSON.stringify(b)}
Cảnh báo khi đọc brief: ${JSON.parse(c.job.warnings_json).join(' · ') || 'không'}

GIÁ TRỊ BẮT BUỘC (bridge soát lại, lệch là bị trả về)
- Tên campaign: "${e.campaignName}"
- Tên adset: "${e.adsetName}"
- Tên ad: "${b.product} - {tên file không có đuôi} - V{số phương án}"
- ads_create_campaign: campaign_name như trên, objective OUTCOME_SALES, buying_type AUCTION, special_ad_categories "[]", campaign_daily_budget ${e.dailyBudgetCents} ($${money(b.budgetUsd)}/ngày, CBO), campaign_bid_strategy ${e.bidStrategy}.
- ads_create_ad_set: optimization_goal OFFSITE_CONVERSIONS, billing_event IMPRESSIONS, destination_type WEBSITE, promoted_object {"pixel_id":"${acc.pixelId}","custom_event_type":"PURCHASE"}, targeting {"geo_locations":{"countries":${JSON.stringify(b.countries)}}}${capLine}${startLine}. Không đặt budget ở adset, không thêm tuổi / giới tính / interest, không gửi targeting_automation, không gửi publisher_platforms (Advantage+ placements).
- ads_create_creative: page_id ${acc.pageId}, link_url "${b.productUrl}", call_to_action_type SHOP_NOW.

BƯỚC LÀM
${budgetStep}${retryStep}2. Sản phẩm (Shopify): tìm theo handle "${b.productHandle}" (search_products, hoặc graphql_query products(first: 1, query: "handle:${b.productHandle}")): title, status, mô tả, giá các biến thể, ưu đãi ghi trên trang. status khác ACTIVE → report_failure(retryable=false).
3. Creative trên Drive (${b.creative.kind === 'folder' ? 'thư mục' : 'file'} id ${b.creative.id}, link ${b.creative.url}):
   - ${b.creative.kind === 'folder' ? `Thư mục: search_files query "parentId = '${b.creative.id}' and trashed = false", chỉ lấy video và ảnh, xếp theo tên tăng dần, tối đa ${c.limits.maxFiles} file (nhiều hơn → chỉ lấy ${c.limits.maxFiles} file đầu và thêm warning).` : `File: get_file_metadata(fileId "${b.creative.id}", includeRichMetadata=true).${b.creative.kind === 'unknown' ? ' Nếu id này là thư mục thì liệt kê file trong đó như một thư mục.' : ''}`}
   - Chỉ nhận video MP4 / MOV và ảnh JPG / PNG; file khác bỏ qua kèm warning. Không còn file nào → report_failure.
   - Quyền: Meta tự tải file qua link công khai nên file phải ở chế độ "Bất kỳ ai có đường liên kết". Đọc visibility (get_file_metadata includeRichMetadata=true): "UNLISTED" (= bất kỳ ai có đường liên kết) hoặc "PUBLIC" là được; giá trị khác (ví dụ "PRIVATE", chỉ trong tổ chức) → report_failure với reason "Mở quyền 'Bất kỳ ai có đường liên kết – Người xem' cho ${b.creative.kind === 'folder' ? 'thư mục' : 'file'} creative rồi gõ /retry ${c.job.id}".
   - Kích thước / thời lượng lấy ở bước 4 (Shopify trả width / height / duration). Video cần 5–60 giây, ảnh cạnh ngắn ≥ 1080 px; tỷ lệ khác 9:16, 4:5, 1:1 → vẫn làm, ghi warning của media đó. Không đo được thì bỏ trống, không đoán.
4. ${mediaViaShopify(c.job.id)}
5. Viết 2 phương án copy (V3 chỉ khi Ghi chú copy yêu cầu hướng khác) theo QUY TẮC COPY bên dưới, đưa Ghi chú copy của brief vào cách viết. Gọi check_copy (product_page_text = mô tả + giá + ưu đãi đọc ở bước 2) cho tới khi không còn lỗi.
6. Instagram: tìm instagram_user_id của tài khoản Instagram gắn với Page ${acc.pageId} (ads_get_ig_accounts, hoặc đọc từ một ad đang chạy trên ${acc.name}). Không tìm được → tạo không kèm và thêm warning "Chưa gắn Instagram — ad có thể không chạy ở vị trí Instagram".
7. Creative: mỗi media × mỗi phương án một ads_create_creative: page_id, link_url, call_to_action_type SHOP_NOW, message = primary_text, headline, description, name = tên ad tương ứng, instagram_user_id nếu có; video: video_id + image_url = picture của video đó; ảnh: image_hash. Không bật advantage_plus_creative, không gửi self_ai_disclosure.
   Post ID: đọc effective_object_story_id của creative bằng ads_get_creatives nếu tool trả về; không có thì post_id = null.
8. ads_create_campaign với các giá trị bắt buộc ở trên.
9. ads_create_ad_set dưới campaign vừa tạo.
10. ads_create_ad: mỗi creative một ad, creative {"creative_id":"<id>"}, ad_name = tên ad.
11. ads_get_ad_entities (object_state=draft) cho campaign: xem active_errors. Lỗi chặn → sửa bằng ads_update_entity trên đúng object nháp của brief này. Đọc lại name, daily_budget, bid_strategy, status của campaign và adset để nộp.
12. Preview: ads_get_ad_preview(ad_id, ad_format "MOBILE_FEED_STANDARD") cho mỗi ad, ad video thêm "INSTAGRAM_REELS"; lấy preview_url (ad nháp chưa render thì thử lại một lần bằng creative_id). Không lấy được → null.
13. submit_drafts với đủ ID. Bị trả lỗi → sửa đúng chỗ (copy sai: viết lại, tạo creative mới, đổi creative của ad nháp bằng ads_update_entity fields {"creative":{"creative_id":"<mới>"}}, xoá creative cũ) rồi nộp lại.

KHI LỖI GIỮA CHỪNG (Meta từ chối, thiếu quyền, video lỗi...)
- Dọn mọi thứ lượt này đã tạo: bỏ bản nháp campaign (ads_update_entity discard_draft_changes=true: xem trước, rồi gọi lại kèm confirmation_token — quy định của chủ shop là tự dọn object do chính brief này tạo; chỉ xác nhận khi danh sách xem trước chỉ gồm object của brief này), xoá creative đã tạo (ads_creative_delete) và file trung gian trên Shopify (fileDelete đúng các ID lượt này tạo).
- report_failure: lý do tiếng Việt + nguyên văn error.message / error_user_msg của Meta + ID còn sót nếu dọn không hết.
- Meta báo giới hạn tần suất gọi API: wait đúng thời gian Meta trả về rồi thử lại, tối đa 3 lần.

TUYỆT ĐỐI KHÔNG
- Không bật gì (ads_activate_entity bị khoá ở lượt này), không đặt status ACTIVE, không tăng budget, không sửa / tắt / xoá object nào không do lượt này tạo.
- Không tự nghĩ ra ưu đãi, giảm giá, số lượng còn lại, hạn chót.

${COPY_RULES}`;
}

function createAdd(c: PromptContext, b: AddBrief): string {
  const acc = c.acc;
  const camp = c.args.campId
    ? `Chủ shop đã chọn campaign ID ${c.args.campId} — dùng đúng campaign này (ads_get_ad_entities level=campaign, object_ids=["${c.args.campId}"]).`
    : /^\d{6,}$/.test(b.camp)
      ? `Brief ghi Camp: ${b.camp} → ads_get_ad_entities level=campaign, object_ids=["${b.camp}"]. Không thấy trên ${acc.name} → report_failure.`
      : `Brief ghi Camp: "${b.camp}" (một phần tên) → tìm campaign trên ${acc.name} có tên chứa chuỗi đó (không phân biệt hoa thường), ưu tiên campaign đang ACTIVE. 0 kết quả → report_failure. Nhiều hơn 1 → gọi need_choice với tối đa 8 campaign (id + "tên · trạng thái") rồi dừng lượt này.`;
  const adset =
    b.adset.mode === 'new'
      ? `Adset: MỚI. Đọc adset đang chạy (ACTIVE) đầu tiên của campaign: targeting, promoted_object, bid_amount, optimization_goal, billing_event, destination_type. Tạo adset mới dưới campaign đó với đúng các giá trị ấy (giữ nguyên targeting kể cả targeting_automation của adset nguồn), tên "{tên campaign} - {các mã quốc gia trong targeting nguồn, cách nhau ", "}". Campaign CBO → không đặt budget ở adset. copied_from = ID adset nguồn. Không có adset nào đang chạy → report_failure.`
      : b.adset.mode === 'id'
        ? `Adset: dùng đúng adset ${b.adset.id} (phải thuộc campaign; không thuộc → report_failure). Không sửa adset này.`
        : `Adset: dùng adset đang chạy (ACTIVE) đầu tiên của campaign; không có → report_failure. Không sửa adset này.`;
  const posts = b.postIds.length
    ? `4. Creative từ Post ID có sẵn (${b.postIds.join(', ')}): mỗi Post ID một ads_create_creative(ad_account_id, page_id ${acc.pageId}, object_story_id = Post ID, instagram_user_id nếu có, name "{Sản phẩm} - {Post ID}") — không viết copy, không tải media, không gọi Shopify, không tạo bài mới. Trong submit_drafts: product = null, media = [], variants = [], mỗi ad variant = null, post_id = Post ID.`
    : `4. Không có Post ID: lấy sản phẩm Shopify theo handle "${b.productHandle}" (status khác ACTIVE → report_failure retryable=false); đọc creative trên Drive (${b.creative?.kind} id ${b.creative?.id}, link ${b.creative?.url}): thư mục → search_files query "parentId = '${b.creative?.id}' and trashed = false", chỉ video MP4/MOV và ảnh JPG/PNG, xếp theo tên, tối đa ${c.limits.maxFiles} file. File phải ở chế độ "Bất kỳ ai có đường liên kết": visibility (get_file_metadata includeRichMetadata=true) phải là "UNLISTED" hoặc "PUBLIC"; giá trị khác → report_failure "Mở quyền 'Bất kỳ ai có đường liên kết – Người xem' cho creative rồi gõ /retry ${c.job.id}".
   ${mediaViaShopify(c.job.id)}
   Viết 2 phương án copy (V3 chỉ khi Ghi chú copy yêu cầu) theo QUY TẮC COPY, check_copy tới khi sạch.
   Creative: mỗi media × mỗi phương án một ads_create_creative (page_id ${acc.pageId}, link_url "${b.productUrl}", call_to_action_type SHOP_NOW, message / headline / description, video_id + image_url thumbnail hoặc image_hash, instagram_user_id nếu có, name = tên ad "{Sản phẩm} - {tên file không đuôi} - V{n}"). Đọc Post ID bằng ads_get_creatives nếu có.`;
  return `${header(c, `VIỆC CẦN LÀM: thêm ad mới vào campaign đang chạy trên ${acc.name} theo brief #ADD dưới đây, CHỈ Ở DẠNG NHÁP, rồi nộp bằng submit_drafts. Không được bật gì, không sửa campaign / adset đang chạy.`)}

${fbCommon(acc, c.job, 'create_and_launch_new_ads')}

Brief đã đọc (bridge đã kiểm tra hợp lệ): ${JSON.stringify(b)}

BƯỚC LÀM
1. Campaign: ${camp}
2. ${adset}
3. Tên sản phẩm cho tên ad: phần giữa của tên campaign dạng "${acc.namePrefix} - {Kiểu} - {Sản phẩm} - {dd/MM/yyyy}"; tên không đúng dạng → dùng title sản phẩm trên Shopify.
${posts}
5. Instagram: tìm instagram_user_id gắn với Page ${acc.pageId} (ads_get_ig_accounts hoặc đọc từ ad đang chạy của campaign). Không có → warning.
6. Ad: mỗi creative một ads_create_ad dưới adset ở bước 2, creative {"creative_id":"<id>"}, ad_name = tên ad.
7. ads_get_ad_entities (object_state=draft): xem active_errors của object mới; lỗi chặn → sửa bằng ads_update_entity trên đúng object nháp mới. Đọc lại trạng thái.
8. Preview: ads_get_ad_preview(ad_id, "MOBILE_FEED_STANDARD"), ad video thêm "INSTAGRAM_REELS"; lấy preview_url (lỗi thì thử bằng creative_id); không có → null.
9. submit_drafts: campaign.existing = true (ghi đúng id, tên, budget, bid_strategy, status hiện tại của campaign), adset.existing = ${b.adset.mode === 'new' ? 'false (adset mới)' : 'true'}. Bị trả lỗi → sửa rồi nộp lại.

KHI LỖI GIỮA CHỪNG: dọn object lượt này tạo (bỏ nháp adset mới hoặc từng ad mới bằng ads_update_entity discard_draft_changes — xem trước rồi xác nhận bằng confirmation_token chỉ khi danh sách chỉ gồm object mới của brief này; xoá creative đã tạo; fileDelete file trung gian trên Shopify do lượt này tạo), rồi report_failure kèm nguyên văn lỗi Meta.
TUYỆT ĐỐI KHÔNG: bật gì, đổi budget / target / trạng thái của campaign hay adset có sẵn, xoá object không do lượt này tạo, tự nghĩ ra ưu đãi.

${b.postIds.length ? '' : COPY_RULES}`;
}

function editRun(c: PromptContext): string {
  const p = c.previous!;
  return `${header(c, `VIỆC CẦN LÀM: chủ shop bấm "Sửa copy" cho brief #${c.job.id} và yêu cầu: «${(c.args.note ?? '').trim()}». Viết lại copy theo yêu cầu đó rồi cập nhật các ad NHÁP của brief. Không bật gì.`)}

${fbCommon(c.acc, c.job, 'create_and_launch_new_ads')}

BẢN NHÁP HIỆN TẠI (đã nộp lần trước): ${JSON.stringify(p)}
${c.expected.campaignName ? `Tên campaign / adset giữ nguyên: "${c.expected.campaignName}" / "${c.expected.adsetName}".` : ''}

BƯỚC LÀM
1. Đọc lại sản phẩm trên Shopify nếu cần (handle ${p.product?.handle ?? '?'}).
2. Viết lại 2–3 phương án theo yêu cầu sửa + QUY TẮC COPY (giữ số phương án như cũ trừ khi yêu cầu khác); check_copy tới khi sạch.
3. Với mỗi ad: tạo creative mới cùng media (video_id + thumbnail cũ hoặc image_hash cũ), cùng link, SHOP_NOW, page_id ${c.acc.pageId}${p.instagram_user_id ? `, instagram_user_id ${p.instagram_user_id}` : ''}, name = tên ad. Đổi creative của ad nháp: ads_update_entity(entity_type "ad", entity_id, fields {"creative":{"creative_id":"<mới>"}}). Bị từ chối → tạo ad mới cùng adset với creative mới, rồi bỏ ad nháp cũ (discard_draft_changes: xem trước, xác nhận bằng confirmation_token chỉ khi danh sách chỉ gồm đúng ad đó).
4. Xoá creative cũ không còn gắn với ad nào (ads_creative_delete).
5. Preview mới cho từng ad, đọc lại trạng thái, rồi submit_drafts với TOÀN BỘ trạng thái mới (cấu trúc như lần trước, variants / ads đã cập nhật).
Lỗi giữa chừng → report_failure kèm nguyên văn lỗi Meta (bản nháp cũ vẫn còn, ghi rõ ad nào đã đổi creative).
TUYỆT ĐỐI KHÔNG bật gì, không sửa object ngoài brief này.

${COPY_RULES}`;
}

function activateRun(c: PromptContext): string {
  const p = c.previous!;
  const chosen = c.args.variants === 'all' || !c.args.variants ? null : c.args.variants;
  const approvedAds = p.ads.filter((a) => !chosen || (a.variant !== null && chosen.includes(a.variant)));
  const otherAds = p.ads.filter((a) => !approvedAds.includes(a));
  const isNew = !p.campaign.existing;
  const list = [
    isNew ? `- campaign ${p.campaign.id} "${p.campaign.name}" (mới, đang nháp)` : `- campaign ${p.campaign.id} "${p.campaign.name}" — CÓ SẴN, đang chạy: KHÔNG bật / sửa lại`,
    p.adset.existing ? `- adset ${p.adset.id} "${p.adset.name}" — CÓ SẴN: không sửa, không bật lại` : `- adset ${p.adset.id} "${p.adset.name}" (mới, đang nháp)`,
    ...approvedAds.map((a) => `- ad ${a.id} "${a.name}" (nháp, creative ${a.creative_id})`),
  ].join('\n');
  const others = otherAds.length
    ? `\nKHÔNG được duyệt (phương án khác): ${otherAds.map((a) => `ad ${a.id} (creative ${a.creative_id})`).join(', ')} → không publish; sau khi publish xong phần được duyệt, bỏ bản nháp các ad này (ads_update_entity discard_draft_changes: xem trước, xác nhận bằng confirmation_token chỉ khi danh sách chỉ gồm đúng các ad này) rồi xoá creative của chúng (ads_creative_delete). Ghi ID đã bỏ vào discarded.`
    : '';
  const how = isNew
    ? `2. Publish: ads_activate_entity(ad_account_id, entity_type "campaign", entity_id "${p.campaign.id}", publish_as_active=true, object_ids=${JSON.stringify([p.campaign.id, p.adset.id, ...approvedAds.map((a) => a.id)])}${otherAds.length ? ', allow_partial_publish=true (chủ shop đã chọn đúng tập con này)' : ''}).`
    : p.adset.existing
      ? `2. Publish từng ad mới dưới adset đang chạy: ads_activate_entity(entity_type "ad", entity_id = ID ad, publish_as_active=true).`
      : `2. Publish adset mới cùng các ad được duyệt: ads_activate_entity(entity_type "ad_set", entity_id "${p.adset.id}", publish_as_active=true, object_ids=${JSON.stringify([p.adset.id, ...approvedAds.map((a) => a.id)])}${otherAds.length ? ', allow_partial_publish=true' : ''}).`;
  return `${header(c, `VIỆC CẦN LÀM: chủ shop đã bấm "${c.args.label ?? 'Duyệt & chạy'}" trên Telegram cho brief #${c.job.id}. Đó là phê duyệt rõ ràng để bật ĐÚNG các object dưới đây. Bật chúng lên chạy thật, đọc lại trạng thái, rồi gọi submit_activation.`)}

${fbCommon(c.acc, c.job, 'create_and_launch_new_ads')}

OBJECT ĐƯỢC DUYỆT
${list}${others}

CÁCH BẬT (connector đang ở draft mode)
1. ads_get_ad_entities (object_state=draft) cho ${isNew ? `campaign ${p.campaign.id}` : `các object mới ở trên`}: xem object nào còn nháp và active_errors. Lỗi chặn → sửa bằng ads_update_entity trên đúng object nháp đó; không sửa được → report_failure (chưa bật gì).
${how}
3. PUBLISHING là bất đồng bộ: làm theo verification_hint nếu có; wait(15) rồi đọc lại live bằng ads_get_ad_entities cho tới khi thấy object live và trạng thái của chúng (tối đa khoảng 5 phút). ID live có thể khác ID nháp — báo ID live.
4. Object được duyệt nào sau khi publish vẫn PAUSED thì bật riêng bằng ads_activate_entity theo thứ tự ${isNew ? 'campaign → adset → ad' : 'adset → ad'}. Ad mới thường ở PENDING_REVIEW / IN_PROCESS — vậy là đúng, ok = true.
5. submit_activation: results cho từng object được duyệt (id live, level, effective_status, ok = đã bật và không bị từ chối; bị từ chối thì note = lý do), discarded, errors (nguyên văn lỗi Meta nếu có).
TUYỆT ĐỐI KHÔNG bật / sửa object ngoài danh sách, không đổi budget, target, không bật lại campaign / adset có sẵn.`;
}

function cancelRun(c: PromptContext): string {
  const p = c.previous!;
  const isNew = !p.campaign.existing;
  const why = c.args.auto ? `brief #${c.job.id} quá ${c.limits.autoCancelAfterH} giờ chưa được duyệt nên tự huỷ theo quy định của chủ shop` : `chủ shop bấm "Huỷ" trên Telegram cho brief #${c.job.id}`;
  const step1 = isNew
    ? `1. Bỏ bản nháp campaign ${p.campaign.id}: ads_update_entity(entity_type "campaign", entity_id "${p.campaign.id}", discard_draft_changes=true) → xem discard_preview. Chỉ khi danh sách chỉ gồm campaign / adset / ad có tên bắt đầu bằng "${p.campaign.name}" mới gọi lại kèm confirmation_token. Có object lạ → không xác nhận, report_failure liệt kê.`
    : p.adset.existing
      ? `1. Bỏ bản nháp từng ad mới (${p.ads.map((a) => a.id).join(', ')}): ads_update_entity(entity_type "ad", discard_draft_changes=true) — xem trước, xác nhận bằng confirmation_token chỉ khi danh sách chỉ gồm đúng ad đó. Không đụng campaign / adset có sẵn.`
      : `1. Bỏ bản nháp adset mới ${p.adset.id} (kéo theo các ad của nó): ads_update_entity(entity_type "ad_set", entity_id "${p.adset.id}", discard_draft_changes=true) — xem trước, xác nhận chỉ khi danh sách chỉ gồm adset này và ad của nó. Không đụng campaign có sẵn.`;
  return `${header(c, `VIỆC CẦN LÀM: ${why}. Xoá toàn bộ object nháp của brief này rồi gọi submit_cancel.`)}

${fbCommon(c.acc, c.job, 'update_existing_campaigns')}

OBJECT CỦA BRIEF: ${JSON.stringify({ campaign: p.campaign, adset: p.adset, ads: p.ads.map((a) => ({ id: a.id, name: a.name, creative_id: a.creative_id })) })}

BƯỚC LÀM
${step1}
2. Object nào đã live (không còn ở dạng nháp, ví dụ một lượt bật trước chạy dở): đặt PAUSED bằng ads_update_entity fields {"status":"PAUSED"} (không xoá) và ghi vào leftovers kèm note.
3. Xoá creative của brief sau khi ad đã bị bỏ: ${p.ads.map((a) => a.creative_id).join(', ')} (ads_creative_delete; creative còn gắn ad live thì để lại, ghi vào leftovers).
4. submit_cancel(removed, leftovers, note).
TUYỆT ĐỐI KHÔNG bật gì, không đụng object ngoài brief này.`;
}

/** Chạy thử: làm như thật mọi bước ĐỌC + viết copy, nộp bản nháp với ID giả. Không gọi tool ghi Meta (đã khoá). */
function dryRun(c: PromptContext): string {
  const b = c.brief;
  const e = c.expected;
  const acc = c.acc;
  const isEdit = c.kind === 'edit';
  const p = c.previous;
  const task = isEdit
    ? `VIỆC CẦN LÀM (CHẠY THỬ — KHÔNG ĐƯỢC TẠO / SỬA GÌ TRÊN META): chủ shop bấm "Sửa copy" cho brief #${c.job.id} và yêu cầu: «${(c.args.note ?? '').trim()}». Viết lại copy rồi nộp lại bản nháp GIẢ bằng submit_drafts.`
    : `VIỆC CẦN LÀM (CHẠY THỬ — KHÔNG ĐƯỢC TẠO / SỬA GÌ TRÊN META): kiểm tra brief #${c.job.id} như khi chạy thật (sản phẩm, creative, quyền Drive, copy) rồi nộp bản nháp GIẢ bằng submit_drafts để chủ shop xem tin duyệt.`;
  const fake = `ID GIẢ khi nộp submit_drafts (không có gì được tạo trên Meta):
- campaign: ${b.type === 'NEW' ? `{"id":"DRY-CAMPAIGN","name":"${e.campaignName}","existing":false,"daily_budget_cents":${e.dailyBudgetCents},"bid_strategy":"${e.bidStrategy}","status":"DRY_RUN"}` : 'campaign THẬT đọc được ở bước 1 (existing=true, đúng id / tên / daily_budget / bid_strategy / effective_status đọc được)'}
- adset: ${b.type === 'NEW' ? `{"id":"DRY-ADSET","name":"${e.adsetName}","existing":false,"countries":${JSON.stringify(b.countries)},"status":"DRY_RUN"}` : b.adset.mode === 'new' ? '{"id":"DRY-ADSET","name":"{tên campaign} - {quốc gia của adset nguồn}","existing":false,"copied_from":"<ID adset nguồn đọc được>","status":"DRY_RUN"}' : 'adset THẬT đọc được (existing=true)'}
- media: mỗi file một mục, meta_id "DRY-MEDIA-{n}", kèm kích thước / thời lượng đọc được từ Drive (không đoán)
- ads: mỗi media × mỗi phương án một ad: id "DRY-AD-{n}${isEdit ? '-E' : ''}", creative_id "DRY-CR-{n}${isEdit ? '-E' : ''}", name đúng quy ước "{Sản phẩm} - {tên file không đuôi} - V{số phương án}", post_id null, preview null${b.type === 'ADD' && b.postIds.length ? '; brief dùng Post ID: mỗi Post ID một ad variant=null, post_id = Post ID, product=null, media=[], variants=[]' : ''}
- warnings: thêm "Chạy thử: chưa tải media, chưa tạo gì trên Meta"`;
  const steps = isEdit
    ? `BẢN NHÁP GIẢ HIỆN TẠI: ${JSON.stringify(p)}
BƯỚC LÀM
1. Đọc lại sản phẩm trên Shopify nếu cần (handle ${p?.product?.handle ?? '?'}).
2. Viết lại 2–3 phương án theo yêu cầu sửa + QUY TẮC COPY; check_copy tới khi sạch.
3. submit_drafts với toàn bộ trạng thái mới: giữ campaign / adset / media như cũ, variants mới, ads mới theo ID GIẢ bên dưới.`
    : `BƯỚC LÀM (chỉ đọc)
1. ${b.type === 'NEW' ? `Sản phẩm (Shopify): tìm theo handle "${b.productHandle}": title, status, mô tả, giá, ưu đãi trên trang. status khác ACTIVE → report_failure(retryable=false).` : `Campaign / adset: đọc bằng ads_get_ad_entities như khi chạy thật (Camp: "${c.args.campId ?? b.camp}"; khớp nhiều campaign → need_choice rồi dừng). ${b.productHandle ? `Sản phẩm Shopify theo handle "${b.productHandle}".` : ''}`}
2. ${b.type === 'ADD' && b.postIds.length ? 'Brief dùng Post ID: không cần đọc Drive.' : `Creative trên Drive (${(b.creative ?? { kind: '?' }).kind} id ${b.creative?.id}): ${b.creative?.kind === 'folder' ? `search_files query "parentId = '${b.creative?.id}' and trashed = false", chỉ video MP4/MOV và ảnh JPG/PNG, theo tên, tối đa ${c.limits.maxFiles} file` : 'get_file_metadata'}; đọc visibility bằng get_file_metadata includeRichMetadata=true: phải là "UNLISTED" hoặc "PUBLIC", khác → report_failure "Mở quyền 'Bất kỳ ai có đường liên kết – Người xem' cho creative rồi gõ /retry ${c.job.id}". Ghi kích thước / thời lượng nếu metadata có. Không tải file.`}
3. Instagram: đọc instagram_user_id gắn với Page ${acc.pageId} (ads_get_ig_accounts) nếu được; không có → warning.
4. ${b.type === 'ADD' && b.postIds.length ? 'Không viết copy.' : 'Viết 2 phương án copy (V3 chỉ khi Ghi chú copy yêu cầu) theo QUY TẮC COPY; check_copy (product_page_text = mô tả + giá + ưu đãi) tới khi sạch.'}
5. submit_drafts với ID GIẢ bên dưới. Bị trả lỗi → sửa đúng chỗ rồi nộp lại.`;
  return `${header(c, task)}

${fbCommon(acc, c.job, 'create_and_launch_new_ads')}

Brief đã đọc (bridge đã kiểm tra hợp lệ): ${JSON.stringify(b)}
${e.campaignName ? `Giá trị bắt buộc: tên campaign "${e.campaignName}", tên adset "${e.adsetName}", daily_budget ${e.dailyBudgetCents} cent, bid_strategy ${e.bidStrategy}.` : ''}

${steps}

${fake}

TUYỆT ĐỐI KHÔNG gọi tool nào ghi lên Facebook Ads (upload media, tạo / sửa / xoá / bật) — các tool đó đã bị khoá ở chế độ chạy thử. Không sửa gì trên Shopify / Drive.

${b.type === 'ADD' && b.postIds.length ? '' : COPY_RULES}`;
}

export function buildPrompt(c: PromptContext): string {
  if (c.dry && (c.kind === 'create' || c.kind === 'edit')) return dryRun(c);
  switch (c.kind) {
    case 'create':
      return c.brief.type === 'NEW' ? createNew(c, c.brief) : createAdd(c, c.brief);
    case 'edit':
      return editRun(c);
    case 'activate':
      return activateRun(c);
    case 'cancel':
      return cancelRun(c);
  }
}
