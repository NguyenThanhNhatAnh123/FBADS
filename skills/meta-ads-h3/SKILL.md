---
name: meta-ads-h3
description: Dựng quảng cáo Meta (Facebook / Instagram) cho shop First Nations Legacy trên tài khoản quảng cáo H3 từ brief #NEW hoặc #ADD — đọc sản phẩm Shopify, creative trên Google Drive, viết 2–3 phương án copy tiếng Anh đúng quy tắc shop (tránh vi phạm Indian Arts and Crafts Act), tạo campaign / adset / ad ở dạng nháp, chờ chủ shop duyệt ngay trong chat rồi mới bật, cuối cùng gửi báo cáo lên Telegram qua connector Telegram bridge. Dùng skill này bất cứ khi nào người dùng dán brief có dòng #NEW hoặc #ADD, hoặc nói kiểu "lên camp", "test mẫu mới", "thêm creative / video vào camp", "chạy ads H3", "dựng campaign cho sản phẩm…", "xử lý brief trên tele", kể cả khi không nhắc tên skill.
---

# Dựng quảng cáo H3 từ brief

Chủ shop gửi một brief, bạn dựng đủ campaign → adset → ad trên tài khoản H3, trình bày bản duyệt ngay trong chat, chỉ bật khi chủ shop nói rõ là duyệt, rồi báo kết quả lên Telegram. Mọi thứ tốn tiền đều chờ chủ shop: đó là nguyên tắc quan trọng nhất của skill này, vì một lệnh bật nhầm là tiêu tiền thật.

Toàn bộ trao đổi với chủ shop bằng tiếng Việt; copy quảng cáo bằng tiếng Anh Mỹ.

## Thông tin cố định (không hỏi lại)

| Mục | Giá trị |
| --- | --- |
| Ad account | `25496622559924808` (H3) — truyền dạng số, không có `act_`; USD; múi giờ America/Dawson |
| Page | `101065259399535` (Native Heritage Store) |
| Pixel | `625569536048355` (Native Pixel), sự kiện PURCHASE |
| Store | firstnationslegacy.com (Shopify) |
| Objective | `OUTCOME_SALES`, tối ưu `OFFSITE_CONVERSIONS`, CBO (budget ở campaign, theo cent: $50 → 5000) |
| Target | chỉ quốc gia trong brief; không tuổi / giới tính / interest; Advantage+ placements |
| CTA | `SHOP_NOW` |
| Tên | campaign `Dân - {Kiểu chạy} - {Sản phẩm} - {dd/MM/yyyy}` (ngày chạy, mặc định hôm nay giờ VN) · adset `{tên campaign} - {quốc gia}` · ad `{Sản phẩm} - {tên file không đuôi} - V{số phương án}` |
| Kiểu chạy | Auto → `LOWEST_COST_WITHOUT_CAP` · CC → `COST_CAP` · BidCap → `LOWEST_COST_WITH_BID_CAP` (CC / BidCap: `bid_amount` ở adset = mức cap theo cent) |

Connector Facebook Ads đang ở **draft mode**: `ads_create_*` chỉ tạo bản nháp trong Ads Manager, không chạy, không tiêu tiền; chỉ `ads_activate_entity` mới đưa lên chạy. Với mọi tool Facebook Ads, truyền `advertiser_request` là nguyên văn brief và `advertiser_job` = `create_and_launch_new_ads`.

## Quy trình

### 1. Nhận và đọc brief

- Brief thường được dán thẳng vào chat. Nếu chủ shop bảo "xử lý brief trên tele", gọi `list_inbox` của connector Telegram bridge, lấy tin bắt đầu bằng `#NEW` / `#ADD`; xử lý xong thì `mark_handled` id đó.
- Đọc brief theo `references/brief.md`. Thiếu trường bắt buộc hoặc giá trị sai → trả lời **một lần** liệt kê đủ mọi lỗi, không tạo gì.
- **Chạy thử**: nếu chủ shop nói "chạy thử", "test", "dry run", hoặc đang dặn không đụng tài khoản quảng cáo — làm mọi bước ĐỌC và viết copy như thật, nhưng không gọi tool nào ghi lên Meta (upload, create, update, delete, activate), không ghi gì lên Shopify; ID trong bản duyệt ghi `(chạy thử)`, báo cáo Telegram có chữ 🧪 CHẠY THỬ.

### 2. Giới hạn an toàn (hỏi lại trước khi tạo)

Số tiền trong skill viết kiểu Mỹ: `$1,500` là một nghìn năm trăm đô.

- Budget/ngày > $300, hoặc mức cap ngoài $5–$150 → hỏi xác nhận lần 2.
- Tổng budget/ngày các campaign ACTIVE có tên bắt đầu bằng `Dân - ` trên H3 (đọc bằng `ads_get_ad_entities`, cột `daily_budget` theo cent) cộng budget mới > $1,500 (một nghìn năm trăm đô / ngày) → từ chối, báo tổng hiện tại.
- Brief giống hệt brief vừa làm trong cuộc chat này → hỏi "vẫn tạo?".

### 3. Thu thập (chỉ đọc)

1. **Sản phẩm**: Shopify `graphql_query` theo handle trong Link SP (`productByIdentifier(identifier: {handle: "…"})` hoặc `products(first:1, query:"handle:…")`): title, status, mô tả, giá, ưu đãi trên trang. Không ACTIVE → dừng.
2. **Creative trên Drive**: `get_file_metadata` (thư mục: `search_files` với `parentId = '<id>' and trashed = false`), chỉ MP4/MOV và JPG/PNG, tối đa 10 file theo tên. Ghi lại kích thước / thời lượng nếu có.
3. **Instagram**: `ads_get_ig_accounts` tìm tài khoản IG gắn Page; không có thì tạo không kèm và ghi cảnh báo "ad chỉ chạy danh tính Page".

### 4. Đưa media lên Meta

Meta KHÔNG tải được link Google Drive (robots.txt của `drive.usercontent.google.com` chặn — lỗi subcode 3858258), nên đừng đưa link Drive cho Meta. Chọn đường theo loại file, chi tiết ở `references/meta-steps.md` mục Media:

- **Ảnh**: qua Shopify Files — file Drive phải để "Bất kỳ ai có đường liên kết" (`visibility` = `UNLISTED` hoặc `PUBLIC`); `fileCreate` với link tải Drive → chờ READY → đưa URL `cdn.shopify.com` cho `ads_creative_upload_media` (upload_source URL) → `fileDelete` file trung gian.
- **Video**: Shopify không nhận link ngoài cho video, nên dùng hộp chọn file của connector: `ads_creative_upload_media` với `upload_source: "LOCAL_FILE"`, nhờ chủ shop chọn đúng file video trên máy (máy có Google Drive for Desktop thì file nằm sẵn trong ổ G:), chờ chủ shop báo xong, rồi tìm video vừa tải bằng `ads_get_ad_videos` và chờ status ready.
- Ảnh cũng có thể đi đường hộp chọn file nếu chủ shop muốn.

Soát khung: video 5–60 giây, ảnh cạnh ngắn ≥ 1080 px, tỷ lệ 9:16 / 4:5 / 1:1 — khác thì vẫn làm nhưng ghi cảnh báo.

### 5. Viết copy

Viết 2 phương án (V3 chỉ khi Ghi chú copy muốn thêm hướng) theo `references/copy-rules.md` — đọc file đó trước khi viết, vì nó có 3 kiểu viết lấy từ các ad đang chạy tốt của shop, cấu trúc độ dài và danh sách từ cấm. Chỉ tả những gì chắc chắn có trong creative / trang sản phẩm (chưa xem ảnh thì đừng bịa "feathers", màu…).

Rồi soát bằng script: ghi `copy.json` bằng công cụ tạo / ghi file (không dùng heredoc `cat <<EOF` trong lệnh shell — nhiều môi trường chặn), sau đó chạy đúng một lệnh:

```bash
python <thư mục skill này>/scripts/check_copy.py copy.json
```

`copy.json` = `{"variants": [{"variant":1,"style":"…","headline":"…","primary_text":"…","description":"…","reason":"…"}], "page_text": "<mô tả + giá + ưu đãi trên trang SP>"}`. Thoát mã 1 = còn lỗi → viết lại tới khi sạch. Không chạy được script thì tự soát từng mục trong `references/copy-rules.md` và nói rõ trong bản duyệt là copy được soát tay.

### 6. Dựng bản nháp

Theo `references/meta-steps.md` mục Tạo: creative (mỗi media × mỗi phương án) → campaign → adset → ad, rồi `ads_get_ad_preview` lấy link xem trước. Đọc lại campaign / adset để chắc tên, budget, bid đúng và trạng thái chưa ACTIVE.

Lỗi giữa chừng: dọn mọi thứ vừa tạo (`references/meta-steps.md` mục Huỷ), báo lỗi kèm nguyên văn `error_user_msg` của Meta, gửi báo cáo lỗi lên Telegram.

### 7. Trình duyệt trong chat

Trình bày đúng mẫu này rồi DỪNG chờ chủ shop trả lời:

```
🟡 CHỜ DUYỆT · #NEW · H3
Camp: Dân - Auto - 3D Hoodie Raven - 09/11/2026
Budget: $50/ngày · CBO · Auto · US
Creative: 2 video (9:16 ✓)

V1 · first_person_story
Headline: …
Text: …
Description: …
Lý do chọn: …
Preview: <link>

V2 · gift_giver
…
⚠ Cảnh báo: (nếu có)

Trả lời: "duyệt" · "chỉ V1" / "chỉ V2" · "sửa: <yêu cầu>" · "huỷ"
```

- **duyệt / chỉ Vn** → bật theo `references/meta-steps.md` mục Bật (chỉ đúng các object của brief này; "chỉ Vn" thì bỏ nháp ad của phương án kia). Một chữ "ok" mơ hồ, hay câu hỏi, KHÔNG phải là duyệt — hỏi lại cho chắc.
- **sửa: …** → viết lại copy theo yêu cầu, soát lại, tạo creative mới, đổi creative của ad nháp, trình duyệt lại.
- **huỷ** → bỏ toàn bộ bản nháp của brief (mục Huỷ).

### 8. Báo cáo lên Telegram (bước cuối)

Gọi `send_message` của connector Telegram bridge (không cần chat_id — bridge chỉ gửi tới chat của chủ shop):

```
🟢 ĐANG CHẠY · #NEW · H3            (hoặc ⚪ ĐÃ HUỶ / 🔴 LỖI / 🧪 CHẠY THỬ)
Camp: <tên> · <id>
Budget: $50/ngày · Auto · US
Ad: <tên> · <id> · <effective_status>   (mỗi ad một dòng)
Copy: V1 first_person_story — "<headline>"
Preview: <link>
Ghi chú: <cảnh báo, ad đang chờ Meta duyệt…>
```

Không có tool Telegram bridge trong cuộc chat này → hiện báo cáo trong chat và nói chủ shop bật connector "telegram-bridge" (Claude Desktop trên máy chạy bridge) hoặc custom connector của bridge (claude.ai, cần tên miền công khai).

## Brief #ADD

Thêm ad vào campaign đang chạy, không sửa campaign / adset có sẵn (không đổi budget, target, trạng thái):

- **Camp** là ID → đọc đúng campaign đó; là một phần tên → tìm trên H3, nhiều kết quả thì đưa danh sách cho chủ shop chọn.
- **Adset** trống → adset đang chạy đầu tiên; `mới` → tạo adset mới sao chép targeting, promoted_object, bid_amount từ adset đang chạy đầu tiên; ID → đúng adset đó.
- **Post ID** có giá trị → creative bằng `object_story_id` = Post ID (giữ like / comment), không viết copy, không tải media.
- Khi bật: chỉ bật adset mới (nếu có) và các ad mới.

## Vì sao làm như vậy

- Nghệ sĩ không phải người bản địa, nên mọi câu gợi ý sản phẩm "do người bản địa làm" có thể vi phạm Indian Arts and Crafts Act — từ cấm trong copy-rules không phải để cho đẹp.
- Bản nháp + duyệt trong chat giữ cho không đồng nào bị tiêu khi chủ shop chưa xem copy và preview.
- Tên theo quy ước giúp báo cáo ngày / tuần nối campaign với dòng sản phẩm trong bảng ROAS hoà vốn.
