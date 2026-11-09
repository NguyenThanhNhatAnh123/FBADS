# MCP Telegram bridge

Bridge là một web service nhỏ trên server văn phòng: nó giữ bot Telegram duy nhất, chuyển brief cho Agent ngay lập tức, và cho Claude trên claude.ai gửi báo cáo, cảnh báo, tin có nút lên Telegram qua một custom connector.

## Chia việc

Việc nào cần nhanh và có giới hạn cứng bằng code thì Agent làm; việc nào cần phân tích và viết nhận xét thì Claude làm qua bridge.

| Việc | Ai làm | Vì sao |
| --- | --- | --- |
| Nhận brief `#NEW` / `#ADD`, tạo creative → Post ID → camp, bật khi duyệt | **Agent** (code riêng, tab chính) | Phản hồi trong vài phút; budget tối đa, cấm tự bật, dọn object khi lỗi được khoá bằng code |
| Báo cáo ngày 14:30, báo cáo tuần 14:30 thứ Hai | **Claude** (scheduled task) → bridge | Đọc Meta và Shopify bằng connector sẵn có, viết nhận xét và đề xuất, gửi lên Telegram |
| Cảnh báo sắp chạm ngưỡng thanh toán | **Claude** (scheduled task mỗi giờ) → bridge | Không cần code logic riêng |
| Hỏi đáp tại chỗ trong claude.ai ("gửi bảng này lên tele") | **Claude** → bridge | Làm ngay trong chat |
| Tin tự do bạn gõ trên Telegram (không bắt đầu bằng `#NEW` / `#ADD`) | Bridge lưu vào hộp thư; **Claude** đọc ở lượt chạy kế tiếp | Claude chỉ hoạt động khi được gọi, không tự thức dậy khi có tin mới |

Bridge không tự phân tích, không gọi Meta hay Shopify: nó chỉ nhận, chuyển và gửi tin. Mọi quyết định tốn tiền vẫn đi qua nút duyệt của Agent.

## Luồng tin

&#91;embedded content: luồng tin qua bridge · 1 bot, 2 nơi nhận\]

Brief và nút duyệt lên camp đến Agent ngay khi bạn gửi; mọi tin khác nằm trong hộp thư cho đến lượt chạy kế tiếp của Claude. Agent và Claude đều gửi tin lên cùng một chat.

## Tool MCP

Bridge mở 7 tool, tất cả chỉ làm việc với đúng một chat Telegram của chủ shop; không tool nào nhận `chat_id` từ Claude.

| Tool | Đầu vào | Trả về | Tác động |
| --- | --- | --- | --- |
| `send_message` | `text` (Markdown Telegram, tối đa 4.096 ký tự; dài hơn thì bridge tự chia), `silent?` | `message_id` | Gửi một tin lên Telegram |
| `send_file` | `filename`, `content_base64` (≤ 10 MB) hoặc `url`, `caption?` | `message_id` | Gửi file: CSV, PNG biểu đồ, PDF báo cáo |
| `send_approval` | `text`, `ref` (mã việc do Claude đặt), `buttons` \[{`id`, `label`}\] tối đa 4 nút | `message_id` | Gửi tin có nút; lần bấm được lưu cho `list_button_presses` |
| `list_inbox` | `since_id?`, `limit?` (mặc định 20) | Danh sách tin tự do chưa xử lý: `id`, `text`, `at`, `reply_to?` | Chỉ đọc |
| `list_button_presses` | `ref?`, `since_id?` | Danh sách lần bấm: `id`, `ref`, `button_id`, `at` | Chỉ đọc |
| `mark_handled` | `ids` | Số mục đã đánh dấu | Đánh dấu tin hoặc lần bấm đã xử lý, để lượt sau không đọc lại |
| `get_status` | — | Bot còn sống, webhook đã đặt, Agent có phản hồi, số tin chưa xử lý | Chỉ đọc |

**Không có trong bridge** (cố ý): tool tạo, bật, tắt quảng cáo; tool gửi tin tới chat khác; tool đọc lịch sử chat cũ. Nút duyệt lên camp do Agent tự gửi và tự xử lý, Claude không bấm hộ được.

## Webhook và quy tắc chuyển tin

Telegram đẩy mọi tin và mọi lần bấm nút vào một địa chỉ duy nhất của bridge; bridge phân loại trong vài mili giây rồi trả `200` ngay.

- Địa chỉ: `POST https://<tên-miền-bridge>/tg/webhook`, đặt bằng `setWebhook` kèm `secret_token`. Request thiếu header `X-Telegram-Bot-Api-Secret-Token` đúng giá trị → trả `401`, ghi log.
- Chỉ xử lý update có `chat.id` nằm trong `TG_ALLOWED_CHAT_IDS`; còn lại bỏ qua và ghi log.
- Lưu `update_id` đã nhận; Telegram gửi lại cùng một update → bỏ qua.

| Update nhận được | Bridge chuyển tới | Cách chuyển |
| --- | --- | --- |
| Tin văn bản bắt đầu bằng `#NEW` hoặc `#ADD` | Agent | `POST http://127.0.0.1:{AGENT_PORT}/brief` kèm header `X-Bridge-Key` |
| Bấm nút có `callback_data` bắt đầu bằng `ag:` | Agent | `POST http://127.0.0.1:{AGENT_PORT}/callback` |
| Lệnh `/retry`, `/status` | Agent | Như dòng trên |
| Bấm nút có `callback_data` bắt đầu bằng `cl:` | Hộp nút bấm cho Claude | Lưu vào `button_presses`, trả lời ngay "Đã ghi nhận, Claude sẽ xử lý ở lượt chạy kế tiếp" |
| Mọi tin văn bản khác, ảnh, file | Hộp thư cho Claude | Lưu vào `inbox`, không trả lời tự động |

Agent không chạy được (lỗi kết nối localhost) → bridge giữ brief trong hàng đợi, thử lại mỗi 30 giây trong 10 phút, rồi báo lên Telegram "Agent không phản hồi". Agent gửi tin duyệt, tin kết quả lên Telegram bằng cùng bot token, gọi thẳng Bot API; chỉ phần **nhận** tin đi qua bridge.

## Xác thực và triển khai

Bridge chạy cạnh Agent trên cùng server Windows, mở ra Internet đúng hai đường qua Cloudflare Tunnel sẵn có: `/tg/webhook` cho Telegram và `/mcp` cho Claude.

**Kết nối với Claude**

- MCP theo transport Streamable HTTP tại `https://<tên-miền-bridge>/mcp`.
- Thêm vào claude.ai dưới dạng custom connector. Server phải truy cập được từ dải IP của Anthropic; custom connector cho phép khai báo cố định credential trong header ([hướng dẫn](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
- Giai đoạn đầu dùng header `Authorization: Bearer <MCP_TOKEN>`, token dài tối thiểu 32 ký tự ngẫu nhiên; request sai token → `401`. Khi cần nhiều người dùng, nâng lên OAuth.
- Tuỳ chọn: luật Cloudflare chỉ cho dải IP của Anthropic vào `/mcp`, chỉ cho dải IP của Telegram vào `/tg/webhook`.

**Giới hạn an toàn**

- Tối đa 30 tin gửi mỗi phút (dưới giới hạn của Telegram); vượt thì xếp hàng.
- Tool không nhận đường dẫn file trên server, chỉ nhận nội dung base64 hoặc URL công khai, để Claude không đọc được file trong máy.
- Mỗi lần gọi tool ghi vào `bridge_log`: thời gian, tool, kích thước dữ liệu, `message_id`.

**Stack và chạy nền**

- Node.js LTS + TypeScript, `@modelcontextprotocol/sdk`, `express`, `better-sqlite3` (file database riêng của bridge).
- `pm2` chạy hai tiến trình `bridge` và `agent`; Cloudflare Tunnel trỏ hostname bridge vào cổng của bridge, không trỏ vào Agent.
- Biến `.env` của bridge: `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `TG_ALLOWED_CHAT_IDS`, `MCP_TOKEN`, `AGENT_PORT`, `BRIDGE_KEY` (chung với Agent).

**Thay đổi ở tab chính:** Agent bỏ long polling, nhận brief và lần bấm nút qua `POST /brief`, `/callback` từ bridge trên localhost; vẫn gửi tin bằng Bot API như cũ.

## Scheduled task trong Claude

Ba task tạo một lần trong claude.ai sau khi bridge chạy; mỗi lượt là một phiên mới nên prompt phải tự đủ thông tin, và task cần được bật tự duyệt ("Automatically approve") để không dừng lại chờ xin quyền khi gửi tin.

| Task | Lịch (giờ VN) | Khung số liệu | Đọc | Gửi qua bridge |
| --- | --- | --- | --- | --- |
| Báo cáo ngày H3 | Mỗi ngày khoảng 14:30, có thể lệch vài phút | Ngày vừa chốt theo `America/Dawson`: 14:00 hôm qua → 14:00 hôm nay giờ VN (07:00 → 07:00 UTC) | Facebook Ads: campaign, adset, ad; Shopify: đơn và doanh thu cùng khung UTC; Google Sheets ROAS hoà vốn | `send_message` báo cáo, `send_file` CSV chi tiết ad |
| Báo cáo tuần H3 | Thứ Hai khoảng 14:30 | Thứ Hai → Chủ nhật theo `America/Dawson`, so với tuần trước | Như trên, thêm xu hướng frequency và CTR theo creative | `send_message` + `send_file` |
| Cảnh báo thanh toán H3 | Mỗi giờ | Số tiền chưa thanh toán so với ngưỡng thanh toán | Số dư và ngưỡng của tài khoản | `send_message` chỉ khi đạt ≥ 80% ngưỡng, tối đa một lần mỗi mốc 80% / 90% / 100% |

**Nội dung báo cáo ngày** (prompt của task liệt kê đủ):

1. Tổng tài khoản: chi tiêu, đơn và doanh thu theo Meta, đơn và doanh thu theo Shopify, ROAS Meta, ROAS thật, CPA, CPM, CTR link.
2. Phễu: link click → add to cart → checkout → purchase, kèm tỷ lệ rơi từng bước.
3. Từng campaign: so ROAS với mốc hoà vốn và mục tiêu của dòng sản phẩm trong bảng ROAS → gắn nhãn Lỗ / Lãi mỏng / Lãi tốt.
4. Top 3 và bottom 3 ad theo ROAS (tối thiểu $20 chi tiêu).
5. Bất thường: add to cart cao bất thường so với click, budget bị đổi, ad bị từ chối, frequency > 2,5.
6. Đề xuất bằng nút `send_approval` (`cl:` prefix) cho Giai đoạn 3; ở Giai đoạn 2 chỉ ghi đề xuất bằng chữ.

**Cần kiểm tra khi tạo task cảnh báo thanh toán:** nếu connector Facebook Ads không trả về số dư và ngưỡng thanh toán, Agent đọc qua Graph API và mở thêm `GET /billing` trên localhost; bridge bọc lại thành tool `get_billing_status`.

## Lưu trữ và nghiệm thu

| Bảng (SQLite của bridge) | Một dòng là | Cột chính |
| --- | --- | --- |
| `updates` | Một update Telegram đã nhận | `update_id`, `kind`, `routed_to` (agent/inbox/buttons), `at` |
| `inbox` | Một tin tự do cho Claude | `id`, `message_id`, `text`, `file_id?`, `reply_to?`, `at`, `handled_at` |
| `button_presses` | Một lần bấm nút `cl:` | `id`, `ref`, `button_id`, `message_id`, `at`, `handled_at` |
| `agent_queue` | Một brief hoặc lần bấm chờ chuyển Agent | `id`, `payload`, `tries`, `last_error`, `delivered_at` |
| `bridge_log` | Một lần gọi tool MCP | `at`, `tool`, `bytes`, `message_id`, `error?` |

**Checklist nghiệm thu**

- [ ] `setWebhook` thành công; request giả không có `secret_token` bị trả `401`
- [ ] Gửi `#NEW` trên Telegram → Agent nhận trong 2 giây, tin duyệt của Agent về đúng chat
- [ ] Tắt Agent, gửi `#NEW` → bridge giữ trong `agent_queue`, bật lại Agent thì brief được chuyển
- [ ] Thêm custom connector trong claude.ai; Claude gọi `get_status` thấy bot, webhook, Agent đều ổn
- [ ] Claude gọi `send_message` và `send_file` (CSV 1 MB) → tin và file về đúng chat
- [ ] `send_approval` với 2 nút, bấm 1 nút → `list_button_presses` trả đúng `ref`, `button_id`; `mark_handled` xong thì không trả lại
- [ ] Gõ một câu tự do trên Telegram → xuất hiện trong `list_inbox`
- [ ] Gọi `/mcp` với token sai → `401`; tin từ tài khoản Telegram khác → bị bỏ qua, có log
- [ ] Scheduled task báo cáo ngày chạy thử một lần → báo cáo đủ 6 phần, số Shopify lấy đúng khung 07:00 → 07:00 UTC
