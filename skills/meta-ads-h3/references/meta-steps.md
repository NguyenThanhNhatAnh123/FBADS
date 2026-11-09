# Các lệnh gọi Meta / Shopify chi tiết

Ad account luôn là `25496622559924808`. Mọi tool Facebook Ads: `advertiser_job` = `create_and_launch_new_ads` (Huỷ: `update_existing_campaigns`), `advertiser_request` = nguyên văn brief, `hide_ui` = true khi tool có tham số này.

## Mục lục
- Media (ảnh qua Shopify Files, video qua hộp chọn file)
- Tạo (creative → campaign → adset → ad → preview)
- Bật
- Huỷ / dọn khi lỗi
- Đã biết về tài khoản H3

## Media

**Ảnh qua Shopify Files** (file Drive để "Bất kỳ ai có đường liên kết"):

1. Shopify `graphql_mutation`:
   ```graphql
   mutation fileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } } }
   ```
   variables `{"files":[{"originalSource":"https://drive.usercontent.google.com/download?id=<FILE_ID>&export=download&confirm=t","contentType":"IMAGE","alt":"ads-h3 <tên file>"}]}` — KHÔNG truyền `filename` (Shopify bắt đuôi tên khớp link gốc, link Drive không có đuôi).
2. Shopify `graphql_query` lặp tới khi `READY`:
   ```graphql
   { node(id: "<id>") { ... on MediaImage { fileStatus fileErrors { code message } image { url width height } } } }
   ```
   `FAILED` thường là file Drive chưa để công khai bằng link.
3. `ads_creative_upload_media`: `upload_source` `URL`, `media_type` `IMAGE`, `media_url` = `image.url` (cdn.shopify.com), `name` = tên file gốc → `image_hash`.
4. `graphql_mutation` `mutation fileDelete($fileIds: [ID!]!) { fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { message } } }` với đúng ID ở bước 1.

Chỉ dùng `graphql_mutation` cho `fileCreate` / `fileDelete` file của brief này — không mutation nào khác trên store.

**Video (và ảnh nếu muốn) qua hộp chọn file**:

1. `ads_creative_upload_media` với `upload_source: "LOCAL_FILE"` — app tải lên hiện ra trong chat.
2. Nói rõ chủ shop chọn file nào (tên file trên Drive; máy có Google Drive for Desktop thì nằm trong ổ G:, không thì tải về trước). Chờ chủ shop báo đã tải xong.
3. Video: `ads_get_ad_videos` (không `video_ids` để liệt kê mới nhất, rồi gọi lại với `video_ids` để lấy `status`, `length`, `picture`) tới khi `ready` (tối đa ~10 phút). Ảnh: `ads_get_ad_images`.

Link Drive / Dropbox đưa thẳng cho Meta luôn hỏng (robots.txt), đừng thử.

## Tạo

1. **Creative** — mỗi media × mỗi phương án một `ads_create_creative`:
   - `page_id` `101065259399535`, `link_url` = Link SP, `call_to_action_type` `SHOP_NOW`, `message` = primary_text, `headline`, `description`, `name` = tên ad, `instagram_user_id` nếu có.
   - Video: `video_id` + `image_url` = `picture` của video (thumbnail). Ảnh: `image_hash`.
   - Không bật `advantage_plus_creative`. `self_ai_disclosure`: hỏi chủ shop nếu creative làm bằng AI, không tự đặt.
   - #ADD có Post ID: chỉ `page_id` + `object_story_id` = Post ID (+ `instagram_user_id`), không copy / media.
2. **Campaign** — `ads_create_campaign`: `campaign_name`, `objective` `OUTCOME_SALES`, `buying_type` `AUCTION`, `special_ad_categories` `"[]"`, `campaign_daily_budget` = budget × 100, `campaign_bid_strategy` theo Kiểu chạy.
3. **Adset** — `ads_create_ad_set`: `campaign_id`, `ad_set_name`, `optimization_goal` `OFFSITE_CONVERSIONS`, `billing_event` `IMPRESSIONS`, `destination_type` `WEBSITE`, `promoted_object` `{"pixel_id":"625569536048355","custom_event_type":"PURCHASE"}`, `targeting` `{"geo_locations":{"countries":[...]}}`. CC / BidCap thêm `bid_amount` (cent). Ngày chạy tương lai thêm `start_time`. Không budget ở adset, không `targeting_automation`, không `publisher_platforms`.
4. **Ad** — `ads_create_ad`: `ad_set_id`, `ad_name`, `creative` `{"creative_id":"<id>"}`.
5. **Preview** — `ads_get_ad_preview(ad_id, ad_format "MOBILE_FEED_STANDARD")`, video thêm `"INSTAGRAM_REELS"`; ad nháp chưa render thì thử bằng `creative_id`. Đưa `preview_url` vào bản duyệt.
6. **Đọc lại** — tên, `daily_budget`, `bid_strategy`, trạng thái của campaign / adset; lệch giá trị trong brief thì sửa bằng `ads_update_entity` trên đúng object nháp đó.

## Bật (chỉ sau khi chủ shop nói rõ "duyệt" / "chỉ Vn")

- #NEW: `ads_activate_entity(entity_type "campaign", entity_id <campaign>, publish_as_active true, object_ids [campaign, adset, các ad được duyệt])`; "chỉ Vn" thêm `allow_partial_publish true`.
- #ADD adset mới: như trên với `entity_type "ad_set"`; adset có sẵn: bật từng ad mới (`entity_type "ad"`, `publish_as_active true`). Không bật lại campaign / adset có sẵn.
- Publish là bất đồng bộ (PUBLISHING): làm theo `verification_hint`, chờ rồi đọc lại live bằng `ads_get_ad_entities` (ID live có thể khác ID nháp). Object được duyệt còn PAUSED thì bật riêng theo thứ tự campaign → adset → ad. Ad mới ở `PENDING_REVIEW` / `IN_PROCESS` là bình thường.
- Phương án không được chọn: bỏ nháp ad đó (mục Huỷ) và `ads_creative_delete` creative của nó.

## Huỷ / dọn khi lỗi

- `ads_update_entity(entity_type, entity_id, discard_draft_changes true)` → xem `discard_preview`; chỉ gọi lại kèm `confirmation_token` khi danh sách chỉ gồm object của brief này (campaign mới thì kéo theo adset / ad của nó). Có object lạ → không xác nhận, báo chủ shop.
- Object đã live (không còn nháp) → `fields {"status":"PAUSED"}`, không xoá.
- Sau đó `ads_creative_delete` các creative của brief, và `fileDelete` file trung gian trên Shopify nếu còn.

## Đã biết về tài khoản H3 (09/11/2026)

- Connector ở draft mode; đọc bản nháp bằng `object_state=draft` có thể báo "tool is new and is being gradually rolled out" — khi đó kiểm tra bằng kết quả trả về của từng lệnh tạo và preview, rồi báo chủ shop xem trong Ads Manager.
- `ads_get_ig_accounts` hiện trả rỗng: Page chưa gắn Instagram cho quảng cáo.
- Ảnh `33.png` thư mục "Thảm chân Shape": 1536×1024 (3:2, cạnh ngắn < 1080) → cảnh báo tỷ lệ.
