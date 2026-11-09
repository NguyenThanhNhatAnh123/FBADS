# Meta Ads AI Agent – Đặc tả Giai đoạn 1

Nov 7, 2026 · @Võ Thành Dân

## Mục tiêu và phạm vi

Giai đoạn 1 làm một việc: chủ shop gửi một brief lên Telegram, Agent tự dựng đủ campaign → adset → ad trên tài khoản H3 ở trạng thái **tạm dừng**, gửi lại bản duyệt, và chỉ bật khi chủ shop bấm **Duyệt**.

**Làm trong Giai đoạn 1**

- Nhận brief `#NEW` (test mẫu mới) và `#ADD` (thêm creative vào camp đang chạy) qua Telegram.
- Tải video hoặc banner từ link Google Drive, kiểm tra định dạng và tỷ lệ khung.
- Đọc trang sản phẩm Shopify để lấy tên, giá, ưu đãi, mô tả thiết kế.
- Dùng Claude API viết 2–3 phương án copy (primary text, headline, description).
- Tạo campaign, adset, creative, ad trên H3, tất cả ở trạng thái PAUSED.
- Gửi tin duyệt có preview và nút **Duyệt & chạy / Sửa / Huỷ**; chỉ bật khi được duyệt.
- Ghi lại mọi brief, mọi object đã tạo và mọi lần duyệt.

**Chưa làm (các giai đoạn sau)**

- Báo cáo ngày, báo cáo tuần, đối chiếu Shopify, cảnh báo thanh toán (Giai đoạn 2).
- Đề xuất tắt ad và tăng budget 20% theo bảng ROAS (Giai đoạn 3).
- Nhiều BM, nhiều tài khoản, tự tối ưu cách chọn kiểu copy (Giai đoạn 4).

**Nguyên tắc không đổi:** Agent không bao giờ tự bật, tự tăng budget hay tự xoá thứ gì đang chạy. Mọi thay đổi làm tốn tiền đều chờ chủ shop bấm duyệt.

## Kiến trúc tổng quan

Agent là một chương trình Node.js chạy liên tục trên server Windows văn phòng; nó chỉ gọi ra ngoài tới Telegram, Google Drive, Shopify, Claude API và Meta, nên không cần mở cổng hay Cloudflare Tunnel.

&#91;embedded content: kiến trúc Agent · 1 server, 4 dịch vụ bên ngoài\]

Chủ shop chỉ nói chuyện với bot; mọi lệnh tạo hay bật quảng cáo đi qua bộ xử lý brief và được ghi lại trong SQLite trước khi gọi Meta.

**Stack đề xuất** (team đã quen JavaScript qua các dashboard Next.js)

- Ngôn ngữ: Node.js bản LTS + TypeScript
- Telegram: thư viện `grammY`, chế độ long polling
- Meta: gọi thẳng Graph API bằng `fetch` (hoặc `facebook-nodejs-business-sdk`)
- Google Drive: `googleapis` với service account
- Shopify: Admin GraphQL API bằng `fetch`
- Claude: `@anthropic-ai/sdk`
- Cơ sở dữ liệu: `better-sqlite3`
- Xử lý video: `ffmpeg` / `ffprobe`
- Chạy nền: `pm2` (tự khởi động lại khi lỗi hoặc khi máy khởi động lại)

## Cấu hình cố định cho H3

Các giá trị dưới đây đã kiểm tra trực tiếp trên tài khoản ngày 07/11/2026. Agent dùng chúng làm mặc định, chủ shop không cần nhập lại trong brief.

| Mục | Giá trị | Ghi chú |
| --- | --- | --- |
| Ad account | `act_25496622559924808` (H3) | BM sở hữu: HT 3973332942 bm1 (`1320752765148375`), tiền tệ USD |
| Múi giờ tài khoản | `America/Dawson` (UTC-7) | Ngày quảng cáo chốt lúc 14:00 giờ VN |
| Pixel | `625569536048355` — Native Pixel | Thuộc BM `129771707967059`, khác BM của ad account: token phải có quyền trên cả hai |
| Page | `101065259399535` — Native Heritage Store | Page duy nhất gắn vào H3 |
| Store Shopify | firstnationslegacy.com (`xzvd1h-0b.myshopify.com`) | Gói Basic, múi giờ PST |
| Objective | `OUTCOME_SALES` |  |
| Tối ưu | `OFFSITE_CONVERSIONS`, sự kiện `PURCHASE` | `promoted_object: {pixel_id, custom_event_type: PURCHASE}` |
| Ngân sách | CBO, `daily_budget` ở cấp campaign | Đơn vị cent: $50 → `5000` |
| Target | Chỉ quốc gia, không giới hạn tuổi, giới tính, interest | `geo_locations.countries` lấy từ brief |
| Vị trí hiển thị | Advantage+ placements | Không truyền `publisher_platforms` |
| CTA | `SHOP_NOW` |  |
| Trạng thái khi tạo | `PAUSED` ở cả campaign, adset, ad | Chỉ đổi sang `ACTIVE` sau khi duyệt |

**Kiểu chạy trong brief → chiến lược giá thầu**

| Brief ghi | `bid_strategy` (campaign) | Cần thêm |
| --- | --- | --- |
| Auto | `LOWEST_COST_WITHOUT_CAP` | Không |
| CC | `COST_CAP` | `bid_amount` ở adset = mức cap trong brief |
| BidCap | `LOWEST_COST_WITH_BID_CAP` | `bid_amount` ở adset = mức cap trong brief |

**Quy ước tên** (theo chủ shop): `Dân - {Kiểu chạy} - {Sản phẩm} - {dd/MM/yyyy}`, ví dụ `Dân - Auto - 3D Hoodie Raven - 07/11/2026`. Adset: `{Tên camp} - {Quốc gia}`. Ad: `{Sản phẩm} - {tên file creative} - V{số phương án copy}`.

## Mẫu brief Telegram

Mỗi brief là một tin nhắn văn bản: dòng đầu là lệnh, các dòng sau theo dạng `Tên: giá trị`. Agent đọc theo tên trường, không phân biệt hoa thường, bỏ qua dòng trống.

**#NEW — test mẫu mới (tạo campaign mới)**

```
#NEW
TK: H3
Kiểu chạy: Auto
Mức cap ($):
Sản phẩm: 3D Hoodie Raven
Link SP: https://firstnationslegacy.com/products/...
Creative: https://drive.google.com/...
Quốc gia: US
Budget/ngày ($): 50
Ngày chạy: hôm nay
Ghi chú copy:
```

**#ADD — thêm creative vào campaign đang chạy**

```
#ADD
TK: H3
Camp: 120248209112780436
Adset: mới
Post ID:
Link SP: https://firstnationslegacy.com/products/...
Creative: https://drive.google.com/...
Ghi chú copy:
```

| Trường | Bắt buộc | Giá trị hợp lệ | Agent kiểm tra |
| --- | --- | --- | --- |
| TK | Có | Tên tài khoản đã khai báo (Giai đoạn 1: chỉ `H3`) | Tên lạ → từ chối, liệt kê tên hợp lệ |
| Kiểu chạy | Có (#NEW) | `Auto`, `CC`, `BidCap` | Sai chữ → hỏi lại |
| Mức cap ($) | Khi CC hoặc BidCap | Số dương, dấu chấm hoặc phẩy | Thiếu khi chọn CC/BidCap → hỏi lại |
| Sản phẩm | Có (#NEW) | Tên ngắn để đặt tên camp | Dài quá 40 ký tự → cắt, báo lại |
| Link SP | Có (trừ khi có Post ID) | URL thuộc `firstnationslegacy.com` | Trang trả lỗi hoặc sản phẩm không active → dừng |
| Creative | Có (trừ khi có Post ID) | Link file hoặc thư mục Google Drive | Không truy cập được → báo cần share cho tài khoản dịch vụ |
| Quốc gia | Có (#NEW) | Mã 2 chữ, cách nhau bằng dấu phẩy (`US, CA`) | Mã lạ → hỏi lại |
| Budget/ngày ($) | Có (#NEW) | Số dương | Ngoài khung an toàn (mục Xử lý lỗi) → xin xác nhận lần 2 |
| Ngày chạy | Không | `hôm nay` hoặc `dd/MM` | Trống = hôm nay; ngày tương lai → đặt `start_time` |
| Camp | Có (#ADD) | ID hoặc một phần tên campaign | Nhiều kết quả → gửi danh sách để chọn |
| Adset | Không (#ADD) | `mới` hoặc ID adset có sẵn | Trống = thêm vào adset đang chạy đầu tiên của camp |
| Post ID | Không (#ADD) | Một hoặc nhiều Post ID dạng `{page_id}_{post_id}`, cách nhau bằng dấu phẩy | Có giá trị → dùng lại bài đó, bỏ qua tải creative và viết copy; bài không thuộc Page Native Heritage Store → từ chối |
| Ghi chú copy | Không | Văn bản tự do | Đưa thẳng vào prompt viết copy |

**Thư mục Drive:** mỗi file video hoặc ảnh trong thư mục thành một ad riêng, dùng chung bộ copy. Tối đa 10 file mỗi brief; nhiều hơn → báo lại và chỉ lấy 10 file đầu theo tên.

Brief thiếu trường bắt buộc → Agent trả lời đúng một tin liệt kê các trường còn thiếu, không tạo gì trên Meta.

## Luồng xử lý

Một brief `#NEW` đi qua 11 bước; mỗi bước ghi trạng thái vào bảng `requests` để chạy lại được từ bước hỏng mà không tạo trùng. Dùng Graph API phiên bản mới nhất đang được hỗ trợ; mọi số tiền gửi theo cent.

1. **Nhận và đọc brief.** Chỉ nhận tin từ `chat_id` đã cho phép. Tách trường, kiểm tra theo bảng ở mục Mẫu brief. Lỗi → trả lời danh sách lỗi, dừng.
2. **Lấy dữ liệu sản phẩm.** Từ handle trong Link SP, gọi Shopify Admin API (`productByHandle` hoặc `products(query: "handle:...")`): tên, giá các biến thể, mô tả, ảnh, trạng thái. Sản phẩm không `ACTIVE` → dừng.
3. **Tải creative từ Drive.** Google Drive API, tải về thư mục tạm. Kiểm tra:
   - Video: MP4/MOV, dài 5–60 giây, đo tỷ lệ khung bằng `ffprobe`.
   - Ảnh: JPG/PNG, cạnh ngắn ≥ 1080 px.
   - Tỷ lệ khác 9:16, 4:5, 1:1 → vẫn làm tiếp nhưng ghi cảnh báo vào tin duyệt.
4. **Viết copy.** Gửi Claude API: ảnh banner (hoặc 3 khung hình cắt từ video bằng `ffmpeg`), dữ liệu sản phẩm, Ghi chú copy, bộ quy tắc ở mục Quy tắc viết copy. Nhận về JSON gồm 2–3 phương án, mỗi phương án có `style`, `primary_text`, `headline`, `description`, `reason`.
5. **Tải media lên Meta.**
   - Ảnh: `POST /act_{id}/adimages` → `image_hash`.
   - Video: `POST /act_{id}/advideos` → `video_id`; hỏi `GET /{video_id}?fields=status` mỗi 10 giây đến khi `video_status = ready` (tối đa 10 phút). Lấy ảnh thumbnail từ `GET /{video_id}/thumbnails`.
6. **Tạo creative và lấy Post ID** — thay cho bước "dựng camp nháp rồi tắt" khi làm tay; chưa cần campaign hay adset.
   - Mỗi tổ hợp creative × phương án copy: `POST /act_{id}/adcreatives` với `object_story_spec.page_id`. Video dùng `video_data {video_id, image_url, message, title, link_description, call_to_action:{type:SHOP_NOW, value:{link}}}`; ảnh dùng `link_data {image_hash, link, message, name, description, call_to_action}`. Meta tự tạo một bài ẩn trên Page.
   - Đọc `GET /{creative_id}?fields=effective_object_story_id` → đó là **Post ID** (`{page_id}_{post_id}`). Chưa có ngay → hỏi lại mỗi 5 giây, tối đa 2 phút.
   - Lưu Post ID, `creative_id`, media và phương án copy vào bảng `posts`.
7. **Tạo campaign.** `POST /act_{id}/campaigns` với `name`, `objective=OUTCOME_SALES`, `status=PAUSED`, `special_ad_categories=[]`, `daily_budget`, `bid_strategy`.
8. **Tạo adset.** `POST /act_{id}/adsets` với `campaign_id`, `name`, `optimization_goal=OFFSITE_CONVERSIONS`, `billing_event=IMPRESSIONS`, `promoted_object={pixel_id, custom_event_type:PURCHASE}`, `targeting={geo_locations:{countries:[...]}}`, `status=PAUSED`; thêm `bid_amount` khi CC/BidCap; thêm `start_time` khi Ngày chạy là ngày tương lai. Dev kiểm tra trường bắt buộc mới nhất về Advantage+ audience khi gọi lần đầu.
9. **Tạo ad gắn Post ID.** Mỗi Post ID một ad: `POST /act_{id}/ads` với `adset_id`, `creative:{creative_id}` (creative ở bước 6, đã trỏ vào đúng bài), `status=PAUSED`. Lỗi giữa chừng → dừng, xoá các object đã tạo trong lần này, báo lỗi kèm mã lỗi Meta.
10. **Lấy preview.** `GET /{ad_id}/previews?ad_format=MOBILE_FEED_STANDARD` cho mỗi ad; video thêm `INSTAGRAM_REELS`. Gửi link preview và link bài (`https://facebook.com/{post_id}`) vào tin duyệt.
11. **Chờ duyệt rồi bật.** Gửi tin duyệt (mục Tin nhắn duyệt). Bấm **Duyệt & chạy** → `POST /{id}` với `status=ACTIVE` theo thứ tự ad → adset → campaign, rồi đọc lại `effective_status` của từng object và báo kết quả.

**Khác biệt của #ADD:** bỏ bước 7. Bước 8 chỉ chạy khi Adset = `mới`, và adset mới sao chép `targeting`, `promoted_object`, `bid_amount` từ adset đang chạy đầu tiên của camp. Khi duyệt, chỉ bật ad mới (và adset mới nếu có); campaign đang chạy giữ nguyên.

**Dùng lại Post ID** (brief `#ADD` có trường Post ID, video tốt nghiệp sang camp scale, chạy lại ở tài khoản khác): bỏ bước 2–5. Bước 6 đổi thành tạo creative bằng `object_story_id = Post ID` — không tạo bài mới, nên like, comment, share dồn về một bài. Agent tự tra bảng `posts`: video đã có Post ID với phương án copy đó thì luôn dùng lại, không tạo bài trùng.

## Quy tắc viết copy

Agent chọn kiểu viết theo creative và sản phẩm, viết 2–3 phương án, và ghi lý do chọn để Giai đoạn 4 học dần kiểu nào bán tốt. Toàn bộ copy bằng tiếng Anh Mỹ.

**Ba kiểu viết lấy từ các ad đang chạy trên H3**

| Kiểu (`style`) | Dùng khi | Mẫu đang chạy |
| --- | --- | --- |
| `first_person_story` — người mặc kể chuyện | Áo mặc hằng ngày, video có người mặc thật | Hoodie: "People think I'm crazy for wearing my Native hoodie everywhere…" (camp ROAS cao nhất tuần 31/10–06/11) |
| `gift_giver` — góc người mua tặng quà | Mùa quà tặng, thiết kế con vật hoặc hoa lá, banner sản phẩm đơn | Jersey: "He says he doesn't need anything…", "For the Woman Who Notices Nature" |
| `product_detail` — bán hàng, emoji + gạch đầu dòng | Sản phẩm có tính năng cần liệt kê (cá nhân hoá, kích cỡ, combo) | Túi da: "100% Customized with your name!"; Ornament |

Mặc định: phương án 1 theo kiểu hợp nhất với creative, phương án 2 theo kiểu thứ hai để A/B, phương án 3 (tuỳ chọn) khi Ghi chú copy yêu cầu hướng khác.

**Cấu trúc mỗi phương án**

- `headline`: 4–7 từ, nhắm vào một kiểu người cụ thể ("For the Man Drawn to the Wild"), tối đa 40 ký tự.
- `primary_text`: 3–6 dòng ngắn có xuống dòng; câu đầu là hook dưới 125 ký tự; tả màu sắc và con vật cụ thể; nhắc in 2 mặt khi sản phẩm in 2 mặt; câu cuối kêu gọi xem hoặc chọn size.
- `description`: một câu dưới 30 ký tự về chi tiết sản phẩm.
- Ưu đãi (ví dụ Buy 5 Get 2) chỉ đưa vào khi đọc được trên trang sản phẩm; không tự nghĩ ra giảm giá, số lượng còn lại hay hạn chót.

**Từ và cách viết bị cấm** (chủ shop xác nhận nghệ sĩ không phải người bản địa)

- Không dùng: `authentic`, `Native-made`, `made by Native artists`, `tribal-made`, tên bộ tộc cụ thể, bất kỳ câu nào gợi ý sản phẩm do người bản địa làm. Lý do: tránh vi phạm Indian Arts and Crafts Act của Mỹ.
- Được dùng: `Native-inspired`, `inspired by Native American art`, `Pacific Northwest–inspired`.
- Không hứa hẹn sức khoẻ, tâm linh có tác dụng thật; không dùng chữ IN HOA cả câu; tối đa 3 emoji mỗi phương án.
- Agent tự soát lại copy bằng danh sách cấm trước khi gửi duyệt; phương án vi phạm bị viết lại.

## Tin nhắn duyệt và bảo mật

Mỗi brief nhận đúng một tin duyệt; chủ shop quyết định bằng nút bấm, không phải gõ lệnh.

**Nội dung tin duyệt**

```
🟡 CHỜ DUYỆT · #NEW · H3
Camp: Dân - Auto - 3D Hoodie Raven - 07/11/2026
Budget: $50/ngày · CBO · Auto · US
Pixel: Native Pixel · Page: Native Heritage Store
Creative: 2 video (9:16 ✓)

V1 · first_person_story
Headline: ...
Text: ...
Lý do chọn: ...
Post ID: 101065259399535_... (mở bài)

V2 · gift_giver
Headline: ...
Text: ...
Post ID: 101065259399535_... (mở bài)

Preview: [V1 Feed] [V1 Reels] [V2 Feed] [V2 Reels]
⚠ Cảnh báo: (nếu có)
```

Kèm ảnh hoặc video creative và các nút:

| Nút | Việc Agent làm |
| --- | --- |
| Duyệt & chạy | Bật mọi ad, adset, campaign của brief (bước 11), sửa tin thành 🟢 ĐANG CHẠY kèm ID |
| Chỉ V1 / Chỉ V2 | Xoá ad của phương án còn lại, bật phần được chọn |
| Sửa copy | Hỏi "Sửa gì?"; câu trả lời của chủ shop đi vào prompt; viết lại, cập nhật creative, gửi tin duyệt mới |
| Huỷ | Xoá toàn bộ object PAUSED của brief, sửa tin thành ⚪ ĐÃ HUỶ |

Brief chưa được duyệt sau 24 giờ → nhắc một lần; sau 72 giờ → tự huỷ và xoá object PAUSED.

**Bảo mật**

- Bot chỉ phản hồi `chat_id` của chủ shop (danh sách cho phép trong `.env`); tin từ nơi khác bị bỏ qua và ghi log.
- `callback_data` của mỗi nút = `request_id` + hành động + chữ ký HMAC ngắn; nút đã bấm một lần thì vô hiệu (chống bấm hai lần).
- Bot chạy bằng long polling (`getUpdates`): server Windows không cần mở cổng ra Internet.
- Token và khoá API chỉ nằm trong `.env` trên server, không đưa vào Git, không gửi qua Telegram.

## Lưu trữ dữ liệu

Một file SQLite trên server là đủ cho Giai đoạn 1; sao lưu file đó mỗi ngày vào Google Drive.

| Bảng | Một dòng là | Cột chính |
| --- | --- | --- |
| `requests` | Một brief | `id`, `type` (NEW/ADD), `raw_text`, `parsed_json`, `account`, `status` (received → validated → media\_ready → copy\_ready → created → pending\_approval → active / cancelled / failed), `step`, `error`, `created_at` |
| `posts` | Một bài trên Page (một tổ hợp creative × phương án copy) | `post_id` (`{page_id}_{post_id}`), `media_id`, `variant_id`, `creative_id`, `product_handle`, `first_request_id`, `created_at`; duy nhất theo (`media_id`, `variant_id`) để không tạo bài trùng |
| `meta_objects` | Một object đã tạo trên Meta | `request_id`, `level` (campaign/adset/creative/ad), `meta_id`, `name`, `post_id`, `status`, `created_at` |
| `copy_variants` | Một phương án copy | `request_id`, `variant`, `style`, `headline`, `primary_text`, `description`, `reason`, `chosen` |
| `media` | Một file creative | `request_id`, `drive_file_id`, `kind` (video/image), `ratio`, `duration_s`, `meta_video_id` / `image_hash` |
| `audit_log` | Một hành động | `at`, `actor` (agent/owner), `action`, `target_meta_id`, `detail` |

Bảng `copy_variants` có cột `style` để Giai đoạn 4 nối với số liệu ROAS của từng ad và chấm điểm kiểu viết. Bảng ROAS hoà vốn vẫn nằm ở Google Sheets **ROAS\_hoa\_von\_san\_pham**; Agent chỉ đọc file đó, không sửa.

## Tài khoản, token và quyền

Chủ shop chuẩn bị năm khoá dưới đây trước khi dev bắt đầu; toàn bộ đi vào file `.env` trên server.

| Dịch vụ | Cần tạo | Quyền | Biến `.env` |
| --- | --- | --- | --- |
| Meta | System User trong BM HT 3973332942 bm1 (`1320752765148375`), token không hết hạn | `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`; gán quyền quản lý ad account H3, quyền quảng cáo trên Page Native Heritage Store, và quyền dùng Native Pixel (pixel thuộc BM `129771707967059`, phải chia sẻ sang BM của H3 hoặc gán trực tiếp) | `META_TOKEN`, `META_AD_ACCOUNT`, `META_PIXEL_ID`, `META_PAGE_ID` |
| Telegram | Bot mới qua @BotFather | Chỉ chat riêng với chủ shop | `TG_BOT_TOKEN`, `TG_ALLOWED_CHAT_IDS` |
| Google | Service account trong Google Cloud, bật Drive API (và Sheets API cho Giai đoạn 3) | Thư mục creative và file ROAS share quyền Người xem cho email của service account | `GOOGLE_SA_JSON`, `ROAS_SHEET_ID` |
| Shopify | Custom app trong Shopify admin của First Nations Legacy | `read_products` (Giai đoạn 1); thêm `read_orders` cho Giai đoạn 2 | `SHOPIFY_DOMAIN`, `SHOPIFY_TOKEN` |
| Claude API | API key trong Claude Console | — | `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (đề xuất `claude-sonnet-5-5`, đọc được ảnh) |

Dev kiểm tra lại danh sách quyền Meta với tài liệu Marketing API hiện hành ở lần gọi đầu tiên; thiếu quyền Page hoặc Pixel sẽ báo lỗi ngay ở bước tạo adset hoặc creative.

**Cài trên server Windows:** Node.js bản LTS, `ffmpeg` và `ffprobe` trong PATH, `pm2` (hoặc NSSM) để chạy Agent như dịch vụ, tự khởi động lại khi lỗi hoặc khi máy khởi động lại.

## Xử lý lỗi và giới hạn an toàn

Nguyên tắc: lỗi nào cũng dừng brief đó, dọn object vừa tạo, và báo chủ shop bằng tiếng Việt kèm mã lỗi gốc; không bao giờ để lại object chạy dở.

| Tình huống | Agent làm gì |
| --- | --- |
| Link Drive không truy cập được | Báo cần share cho email service account, giữ brief ở trạng thái chờ, chạy lại khi chủ shop gõ `/retry {id}` |
| Video Meta xử lý quá 10 phút hoặc báo lỗi | Xoá campaign, adset vừa tạo; báo tên file lỗi |
| Meta từ chối một lệnh tạo (thiếu quyền, sai tham số) | Dừng, xoá object của brief, gửi nguyên văn `error.message` và `error_user_msg` |
| Meta báo giới hạn tần suất gọi API | Chờ theo thời gian Meta trả về rồi thử lại, tối đa 3 lần |
| Token Meta hết hạn hoặc bị thu hồi | Dừng mọi brief, gửi cảnh báo đỏ lên Telegram |
| Ad bị từ chối sau khi bật | Báo lý do từ chối và ID ad (Giai đoạn 2 sẽ tự kiểm tra mỗi giờ) |
| Gửi trùng một brief trong 10 phút | Hỏi lại "Brief này giống brief #id, vẫn tạo?" |
| Server khởi động lại giữa chừng | Đọc `requests` có trạng thái dở, chạy tiếp từ `step` đã ghi |

**Giới hạn an toàn** (sửa được trong `.env`)

- Budget/ngày một brief > **$300** → bắt buộc bấm xác nhận lần 2 trước khi tạo.
- Tổng budget/ngày các camp Agent đang quản lý trên H3 > **$1.500** → từ chối brief mới, báo tổng hiện tại.
- Mức cap (CC/BidCap) < $5 hoặc > $150 → hỏi lại vì nhiều khả năng gõ nhầm.
- Agent không có lệnh nào để xoá hay tắt object không do chính nó tạo ra trong Giai đoạn 1.

## Checklist nghiệm thu

Giai đoạn 1 xong khi cả 12 mục dưới đây chạy đúng trên H3, test với budget $5–10/ngày rồi huỷ.

- [ ] Brief `#NEW` hợp lệ, 1 video → camp, adset, 2 ad ở trạng thái PAUSED, tên đúng quy ước, nhận tin duyệt trong 5 phút
- [ ] Mỗi ad trong tin duyệt có Post ID riêng, mở được bài trên Page Native Heritage Store, và không có campaign nháp nào bị tạo thêm
- [ ] Brief `#NEW` với thư mục Drive 3 file → 3 creative × 2 phương án copy = 6 ad
- [ ] Brief `#ADD` vào camp có sẵn, Adset = `mới` → adset mới sao chép đúng target và pixel, camp cũ không bị sửa
- [ ] Brief `#ADD` có Post ID → ad mới dùng đúng bài cũ (cùng like, comment), không gọi Claude API, không tạo bài mới
- [ ] Bấm **Duyệt & chạy** → `effective_status` của mọi object chuyển ACTIVE, tin đổi thành 🟢 kèm ID
- [ ] Bấm **Huỷ** → mọi object PAUSED của brief bị xoá khỏi H3
- [ ] Bấm **Sửa copy**, trả lời "nhấn mạnh in 2 mặt" → nhận tin duyệt mới với copy đã sửa
- [ ] Brief thiếu Link SP và gõ sai Kiểu chạy → một tin liệt kê đủ 2 lỗi, không có gì được tạo trên Meta
- [ ] Brief Budget $400 → bị yêu cầu xác nhận lần 2
- [ ] Tin nhắn từ một tài khoản Telegram khác → bot im lặng, có dòng trong `audit_log`
- [ ] Copy của 10 brief thử không chứa từ nào trong danh sách cấm

## Chuẩn bị cho Giai đoạn 2–4

Giai đoạn 1 nên dựng sẵn ba thứ để các giai đoạn sau chỉ cần thêm việc, không phải sửa nền.

| Giai đoạn | Việc chính | Đã chốt với chủ shop | Nền cần có từ Giai đoạn 1 |
| --- | --- | --- | --- |
| 2 — Báo cáo | Báo cáo ngày 14:30 giờ VN; báo cáo tuần 14:30 thứ Hai; đối chiếu đơn Shopify; cảnh báo khi số tiền chưa thanh toán đạt 80% ngưỡng thanh toán | Ngày chốt theo múi giờ `America/Dawson` (14:00 → 14:00 giờ VN); Shopify lọc đơn theo đúng khung giờ đó dù store dùng PST | Bộ lập lịch trong Agent (ví dụ `node-cron` với `TZ=Asia/Ho_Chi_Minh`), hàm đổi khung giờ Dawson ↔ VN ↔ PST |
| 3 — Đề xuất tắt / scale | Đọc bảng ROAS hoà vốn, gửi đề xuất tắt ad hoặc tăng 20% kèm nút duyệt | Chờ duyệt từng đề xuất, không tự làm | Hàm đọc Google Sheets **ROAS\_hoa\_von\_san\_pham** theo cột tên sản phẩm; cột `product_key` trong `requests` để nối ad với dòng sản phẩm |
| 4 — Mở rộng | Nhiều BM, nhiều tài khoản; chọn kiểu copy theo kết quả | — | Cấu hình tài khoản để trong bảng `accounts`, không hard-code H3; cột `style` trong `copy_variants` |

**Còn chờ chủ shop**

- Giá vốn của Áo 3D Hoodie, Túi Sách, Ví cầm tay, Áo 2D T-shirt trong bảng ROAS (cần trước Giai đoạn 3).
- Bật connector Google Sheets để Claude nhập số liệu Shopify vào bảng ROAS.
- Tạo System User và các khoá ở mục Tài khoản, token và quyền.

Bot Telegram do MCP bridge giữ và chuyển brief sang Agent; đặc tả ở tab MCP Telegram bridge.
