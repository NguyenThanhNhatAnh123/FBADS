# Việc cần làm: tạo Cloudflare Tunnel cho bridge Telegram

Bạn là Claude in Chrome, đang thao tác trong trình duyệt của chủ shop. Hãy tạo một Cloudflare Tunnel trên trang quản trị Cloudflare để tên miền `ads.eagleglobal2023.com` trỏ vào bridge đang chạy trên server Windows văn phòng. Trả lời chủ shop bằng tiếng Việt.

## Thông tin cố định

| Mục | Giá trị |
| --- | --- |
| Tên miền (đã nằm trên Cloudflare, nameserver `carioca` / `eugene.ns.cloudflare.com`) | `eagleglobal2023.com` |
| Hostname cần tạo | `ads.eagleglobal2023.com` |
| Tên tunnel | `ads-bridge` |
| Dịch vụ phía sau | `HTTP` → `127.0.0.1:8787` |
| Hệ điều hành server | Windows 64-bit, `cloudflared` 2026.10.0 đã cài ở `C:\Program Files (x86)\cloudflared\cloudflared.exe` |

## Quy tắc an toàn (bắt buộc)

- Chỉ làm đúng các bước dưới đây. Không xoá, không sửa tunnel khác, bản ghi DNS khác, cài đặt SSL/TLS, WAF, Access hay bất kỳ tên miền nào khác.
- Không gõ mật khẩu hay mã 2FA. Nếu chưa đăng nhập Cloudflare thì dừng lại và nhờ chủ shop tự đăng nhập.
- **Token của tunnel** (chuỗi dài bắt đầu bằng `eyJ`) là bí mật. Không chép lại token trong chat, không dán vào trang nào khác, không lưu ở đâu. Chủ shop tự bấm nút copy trên trang.
- Chỉ trỏ vào cổng **8787**. Tuyệt đối không trỏ vào cổng 8788 (Agent nội bộ).
- Gặp tình huống không có trong hướng dẫn (có nhiều tài khoản Cloudflare, tunnel `ads-bridge` đã có nhưng đang lỗi, bản ghi DNS `ads` đã tồn tại, trang yêu cầu nâng gói trả phí…) thì **dừng lại, mô tả những gì thấy trên màn hình và hỏi chủ shop**. Không tự đoán.
- Giao diện Cloudflare hay đổi tên mục. Ví dụ *Networks* ↔ *Networking*, *Public Hostname* ↔ *Published application routes* ↔ *Routes*. Hãy tìm mục có ý nghĩa tương đương.

## Các bước

### 1. Mở đúng tài khoản

1. Mở https://dash.cloudflare.com.
2. Nếu có nhiều tài khoản, chọn tài khoản có tên miền `eagleglobal2023.com` trong danh sách website. Không chắc chắn thì hỏi chủ shop.

### 2. Kiểm tra tunnel đã có chưa

1. Vào **Zero Trust → Networks → Tunnels**. Trang có thể ghi là **Networking → Tunnels**.
2. Nếu lần đầu vào Zero Trust mà trang bắt chọn team name hoặc gói, chọn gói **Free** ($0). Nếu trang đòi thẻ thanh toán thì dừng lại và hỏi chủ shop.
3. Nếu đã có tunnel tên `ads-bridge`:
   - Trạng thái **Healthy**: bỏ qua bước 3–4, sang bước 5.
   - Trạng thái khác (Inactive, Down…): dừng lại và hỏi chủ shop.

### 3. Tạo tunnel

1. Bấm **Create a tunnel**, chọn loại **Cloudflared**.
2. Đặt tên `ads-bridge`, rồi bấm **Save tunnel**.

### 4. Cài connector (chủ shop làm trên server)

1. Chọn môi trường **Windows**, kiến trúc **64-bit**. **Không bấm tải file cài đặt** vì máy đã có `cloudflared`.
2. Nhắn chủ shop nguyên văn đoạn sau. Không chèn token vào tin nhắn.

   > Anh/chị bấm nút copy ở ô lệnh trên trang. Ô này nằm dưới chữ *"If you already have cloudflared installed on your machine"*, lệnh có dạng `cloudflared.exe service install eyJ...`.
   > Sau đó mở **PowerShell bằng quyền Administrator** (chuột phải → *Run as administrator*), gõ `& "C:\Program Files (x86)\cloudflared\` rồi dán lệnh vừa copy. Sửa cho thành đúng dạng:
   > `& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install eyJ...`
   > Bấm Enter. Thấy báo cài dịch vụ thành công thì nhắn lại cho tôi "xong".

3. Đợi chủ shop nhắn "xong". Sau đó xem mục **Connectors** cuối trang, làm mới trang nếu cần, đến khi thấy một connector trạng thái **Connected / Healthy**.
   - Nếu sau khoảng 2 phút vẫn không thấy, báo chủ shop và hỏi họ có thấy lỗi gì trong PowerShell không.
4. Bấm **Next**.

### 5. Thêm route trỏ tên miền vào bridge

Ở màn hình route (hoặc tab **Routes** của tunnel `ads-bridge` → **Add route** → **Published application**), điền:

| Ô | Giá trị |
| --- | --- |
| Subdomain | `ads` |
| Domain | `eagleglobal2023.com` |
| Path | *để trống* |
| Service Type | `HTTP` |
| URL | `127.0.0.1:8787` |

- Không bật thêm tuỳ chọn nào trong *Additional application settings*.
- Bấm **Save**.
- Nếu báo lỗi bản ghi DNS đã tồn tại thì dừng lại và hỏi chủ shop. **Không xoá bản ghi cũ.**

### 6. Kiểm tra

1. Vào **Websites → eagleglobal2023.com → DNS → Records**. Phải có bản ghi `CNAME` tên `ads`, nội dung `<id-tunnel>.cfargotunnel.com`, trạng thái **Proxied** (đám mây cam).
2. Quay lại danh sách Tunnels. `ads-bridge` phải ở trạng thái **Healthy**.
3. Mở tab mới vào https://ads.eagleglobal2023.com/healthz rồi đọc kết quả, không sửa gì:
   - `{"ok":true,...}`: bridge đã chạy và nhận được qua tunnel.
   - Lỗi 502 / 1033 / "Bad gateway": tunnel đã thông nhưng bridge chưa chạy. Đây không phải lỗi của bạn, chỉ cần ghi lại.
   - Lỗi DNS (không tìm thấy trang): đợi 1–2 phút rồi thử lại một lần.

## Báo cáo cuối cùng cho chủ shop

Trả lời ngắn gọn, **không kèm token**:

- Tên tunnel, Tunnel ID, trạng thái connector.
- Route đã tạo: `ads.eagleglobal2023.com` → `http://127.0.0.1:8787`.
- Bản ghi DNS `ads` (CNAME, Proxied hay không).
- Kết quả mở `/healthz`.
- Những bước đã bỏ qua hoặc phải dừng lại hỏi (nếu có).

Kết thúc bằng câu: **"Tunnel đã xong. Quay lại Claude Code để chạy `npm run set-webhook` và kiểm tra `get_status`."**
