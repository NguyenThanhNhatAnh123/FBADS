# Bridge H3: media, thanh toán và luồng brief

Schema đầy đủ được xuất trực tiếp từ SDK, không viết lại bằng tay: [bridge-tool-schemas.json](bridge-tool-schemas.json). Xuất lại bằng `node scripts/export-mcp-tools.ts`.

## Tool mới: stage_drive_media

Input: `file_id` là chuỗi ID Drive 10–200 ký tự (chữ, số, `_`, `-`); `ttl_hours` là số > 0 và ≤ 24, mặc định 6.

Ví dụ output (URL minh hoạ, không phải link đang hoạt động):

```json
{
  "url": "https://ads.eagleglobal2023.com/media/<token-ngau-nhien>/raven-01.mp4",
  "expires_at": "2026-11-09T14:00:00.000Z",
  "file_name": "raven-01.mp4",
  "mime_type": "video/mp4",
  "size_bytes": 18234567,
  "kind": "video",
  "width": 1080,
  "height": 1920,
  "duration_sec": 14.8
}
```

Ảnh không có `duration_sec`. Metadata đo bằng ffprobe trên bytes đã tải, có xử lý rotation. Dữ liệu lưu trên đĩa, URL trực tiếp không redirect, GET/HEAD có Content-Length, Range trả 206. Link ngẫu nhiên 256 bit, DB chỉ lưu hash; token gắn đúng file/thời hạn. Không nhận URL tuỳ ý. File sai token/tên trả 404; hết hạn trả 410 trước cleanup hoặc 404 sau cleanup. Cleanup chạy mỗi phút, tự khôi phục từ DB sau restart.

Video tối đa **1.000.000.000 byte**, ảnh **30.000.000 byte**. Kiểm tra cả size khai báo lẫn bytes thực, magic bytes, định dạng ffprobe và đuôi file. Tối đa hai lượt tải đồng thời; cache mặc định 5 GB với dự phòng dung lượng cho lượt đang tải. Không công bố URL media trong báo cáo hoặc tin Telegram; chỉ chuyển cho Meta trong cùng lượt xử lý.

Các lỗi dạng MCP `isError: true`, text JSON `{ "error": "<mã>", "message": "<tiếng Việt>" }`: `not_found`, `no_access`, `unsupported_type`, `too_large`, `download_failed`; ngoài ra có `invalid_ttl`, `not_configured`, `busy`, `cache_full`. SDK có thể trả lỗi validation chuẩn nếu tham số sai schema.

`DRIVE_SERVICE_ACCOUNT_JSON` nhận đường dẫn JSON hoặc JSON một dòng; chỉ cấp scope `drive.readonly`. Chia sẻ Viewer cho email `client_email` trong file đó. Chưa cấu hình service account thì chỉ tải file đã mở “Bất kỳ ai có đường liên kết – Người xem”. Không tạo service account hoặc mở quyền Drive tự động. **Máy triển khai hiện chưa có service account, nên chưa có email để cung cấp.**

`BRIDGE_PUBLIC_URL` phải là HTTPS origin. `MEDIA_CACHE_DIR=data/staged-media`; `MEDIA_CACHE_MAX_BYTES=5000000000`; `FFPROBE_PATH` là đường dẫn ffprobe. Cloudflare Tunnel cần mở `/media/...` và `/robots.txt` như file mẫu trong deploy/. Robots cho phép `/media/`, kể cả facebookexternalhit và meta-externalagent theo nhóm `User-agent: *`.

Claude tự động trong bridge được cấp tool `adsjob.stage_drive_media` chỉ ở lượt create chạy thật. Prompt dùng link cache cho `ads_creative_upload_media`; không còn cấp quyền ghi Shopify để đưa media qua Shopify Files. Chế độ chạy thử không stage/public media từ lượt job, không tạo/bật/sửa quảng cáo. Tool staging công khai qua connector vẫn dùng được để kiểm tra khi chủ shop gọi trực tiếp.

## Tool sửa: get_billing_status

Input `{}`. Khi có `META_READ_TOKEN`, bridge dùng token đó cho đúng hai endpoint **GET** trên tài khoản H3 `25496622559924808`: ad account với các field thanh toán; `adspaymentcycle?fields=threshold_amount,updated_time`. Không dùng client ghi quảng cáo, không đưa token vào URL hoặc tiến trình Claude. `META_API_VERSION` mặc định `v26.0`.

Ví dụ output minh hoạ, không phải số dư thật của shop:

```json
{
  "account_id": "25496622559924808",
  "currency": "USD",
  "account_status": "ACTIVE",
  "disable_reason": 0,
  "balance_cents": 4210,
  "amount_spent_cents": 1234500,
  "spend_cap_cents": null,
  "threshold_cents": 50000,
  "percent_of_threshold": 8.4,
  "is_prepay": false,
  "funding_source": "Visa ••4417",
  "read_at": "2026-11-09T08:00:00.000Z"
}
```

Tiền giữ nguyên minor units do Graph API trả; không nhân 100 lần nữa. Spend cap 0 được hiểu là không giới hạn, trả null. Trạng thái số của Meta được đổi sang tên; chỉ lấy loại nguồn tiền và bốn số cuối, không trả object nguồn tiền thô. Thiếu field trả null. Field nguồn tiền bị từ chối thì đọc lại các field cơ bản và kèm `warnings`. Edge ngưỡng không được hỗ trợ/quyền không đủ thì `threshold_cents` và tỷ lệ là null, kèm cảnh báo; không suy đoán ngưỡng.

Các field ad account đã đối chiếu [SDK chính thức của Meta](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py). Edge `adspaymentcycle` phụ thuộc API/quyền và **chưa xác minh trực tiếp trên H3 vì chưa có META_READ_TOKEN**. Trong chế độ agent cũ, nếu chưa có token đọc riêng thì tool vẫn chuyển tới Agent như trước. Trong chế độ claude hiện tại, thiếu token trả `not_configured`, không trả số giả. Chưa bật cảnh báo thanh toán định kỳ (tuỳ chọn trong yêu cầu).

## Brief: dùng luồng hiện có, không tạo list_briefs

Ở `BRIEF_HANDLER=claude`: webhook/polling → kiểm chat và update trùng → router phân loại `#NEW/#ADD` → JobManager đọc và kiểm brief → lưu `jobs`/`job_runs` → Claude Code headless nhận nguyên văn brief trong prompt và `adsjob.get_job` → bridge kiểm bản nháp, gửi tin duyệt → chủ shop bấm nút → lượt activate/cancel tương ứng. Một brief chỉ có một luồng xử lý.

- `get_status.agent` là tình trạng **bộ xử lý Claude** (`mode: "claude"`), không phải yêu cầu chạy tiến trình Agent ở cổng 8788.
- `get_status.agent.open_briefs` là mảng `{id,type,status}` của các job còn mở: confirm, queued, running, choosing, pending_approval, activating, cancelling. Không có nghĩa là các tin đang chờ Claude web nhận lại.
- `agent_queue_pending` là số update trong hàng đợi chuyển sang **Agent dùng API key**. Trong chế độ claude bình thường là 0; không phải số brief mở.
- `list_inbox` chỉ trả tin tự do. `mark_handled` chỉ đánh dấu `m<id>` (inbox) và `b<id>` (lần bấm nút); **không nhận ID job/brief**, không dùng để hoàn tất job.

Theo nhánh cho phép trong tài liệu yêu cầu (“nếu đã có cơ chế khác … không cần làm list_briefs”), không thêm hàng đợi brief thứ hai và không mở mark_handled cho job. Claude web/Desktop dùng skill độc lập cần tránh đọc lại `open_briefs` để tạo quảng cáo thêm lần nữa; gửi brief qua bot sẽ được Claude Code trên bridge nhận tự động.

## Tool duyệt sẵn có

`send_approval` input:

```json
{
  "text": "Nội dung duyệt (1–4000 ký tự)",
  "ref": "brief-external-123",
  "buttons": [
    {"id":"approve","label":"Duyệt"},
    {"id":"v1","label":"Chỉ V1"},
    {"id":"v2","label":"Chỉ V2"},
    {"id":"cancel","label":"Huỷ"}
  ]
}
```

`ref`: 1–64 ký tự. Có 1–4 nút, mỗi `id` 1–32 ký tự và không trùng, mỗi `label` 1–64 ký tự. Output `{message_id,approval_id,ref}`. Bốn nhãn trên đều được hỗ trợ. Bridge tạo callback riêng `cl:...`, chủ shop chỉ chọn một lần; bấm xong gỡ nút. Không tự tác động quảng cáo.

`list_button_presses` input `{ "ref": "brief-external-123", "since_id": "b2" }` (cả hai tuỳ chọn; since_id có thể là số). Output ví dụ:

```json
{"items":[{"id":"b3","ref":"brief-external-123","button_id":"v1","label":"Chỉ V1","at":"2026-11-09T08:00:00.000Z"}]}
```

Claude xử lý lựa chọn rồi gọi `mark_handled({"ids":["b3"]})`; output `{ "marked": 1 }`. Các nút JobManager dùng cho brief tự động có chữ ký riêng và được bridge tự nhận ngay, không đi qua list_button_presses.

`record_campaigns` và `list_managed_campaigns` **không có trong MCP bridge hiện tại**; không thêm hai tool này trong bản nâng cấp. Skill bên ngoài tự đọc campaign qua connector Facebook Ads và tính trần $1.500/ngày. Bộ xử lý headless hiện vẫn có check_budget, giới hạn brief và kiểm duyệt riêng; báo cáo này không thay đổi các giới hạn đó.

## Nghiệm thu

| Mục | Kết quả và giới hạn |
| --- | --- |
| 1. MP4 từ Drive, URL HEAD 200 | Tải từ nguồn Drive giả lập → MP4 thật, ffprobe thật; HEAD/GET/Range đã đạt. Chưa có file Drive thật được cung cấp để thử toàn tuyến. |
| 2. PNG từ Drive | Nguồn giả lập → PNG thật, metadata và HTTP đã đạt. Cùng giới hạn file Drive thật ở mục 1. |
| 3. robots.txt | Có route cho phép /media/; kiểm thử HTTP đạt. Kiểm tra thêm trên tên miền sau deploy. |
| 4. Token sai/hết hạn | 404/410, Range không hợp lệ 416, xoá file hết hạn, giữ file còn hạn: đã đạt. |
| 5. Billing chế độ claude | MCP + Graph giả lập trả đủ field và che số thẻ: đạt. Thực tế sẽ báo not_configured do chủ shop chưa có META_READ_TOKEN. |
| 6. Brief thử | Webhook giả lập qua cùng router/job manager lưu và chuyển đúng; không thêm list_briefs theo nhánh cho phép. mark_handled không xử lý nhầm ID brief. Không gửi brief giả vào chat thật. |
| 7. get_status | Bot/webhook/handler Claude qua MCP đã kiểm thử. Kiểm tra lại trên production sau deploy. |
