# Sửa tunnel: chuyển ads.eagleglobal2023.com sang tunnel riêng chạy trên máy ADMIN

Bạn là Claude in Chrome, đang thao tác trong trình duyệt của chủ shop. Trả lời chủ shop bằng tiếng Việt.

## Vì sao phải sửa

Lần trước, route `ads.eagleglobal2023.com → http://127.0.0.1:8787` được thêm vào tunnel **office-qa** (ID `085f6c8a-fb50-4468-8c04-e861e18d800a`). Nhưng connector của office-qa chạy trên **một máy khác**, không phải máy đang chạy bridge. Vì vậy `127.0.0.1` lại là chính máy kia.

Claude Code đã kiểm tra trên máy chạy bridge:

- Máy chạy bridge tên **ADMIN**, IP LAN `192.168.1.11`. Máy này không có tiến trình hay dịch vụ `cloudflared` nào (chỉ có Cloudflare WARP).
- Bridge chạy trên máy ADMIN trả `http://127.0.0.1:8787/healthz` → 200. Cùng lúc đó `https://ads.eagleglobal2023.com/healthz` vẫn báo **502**.

Cách sửa: tạo tunnel riêng tên `ads-bridge`, cài connector của nó trên máy ADMIN, rồi chuyển route `ads` sang tunnel này.

## Quy tắc an toàn (bắt buộc)

- **Không đụng vào các route qa / ul / mz** và mọi thứ khác của tunnel office-qa. Chỉ gỡ đúng route `ads.eagleglobal2023.com`.
- **Tuyệt đối không cài connector của office-qa lên máy ADMIN.** Một tunnel có connector ở hai máy sẽ chia request của qa/ul/mz sang máy ADMIN và làm các trang đó lỗi chập chờn. Lệnh cài cho chủ shop phải lấy từ trang của tunnel **ads-bridge**.
- Chỉ xoá đúng một bản ghi DNS: `CNAME ads` có nội dung `085f6c8a-fb50-4468-8c04-e861e18d800a.cfargotunnel.com`. Nội dung khác thì không xoá, dừng lại và hỏi chủ shop.
- Token tunnel (chuỗi bắt đầu bằng `eyJ`) là bí mật. Không chép lại trong chat, không dán vào trang khác. Chủ shop tự bấm copy.
- Không gõ mật khẩu hay mã 2FA. Không sửa SSL/TLS, WAF, Access hay tên miền khác.
- Gặp tình huống ngoài hướng dẫn thì dừng lại, mô tả màn hình và hỏi chủ shop.
- Giao diện có thể đổi tên mục (*Networks* ↔ *Networking*, *Public Hostname* ↔ *Published application routes* ↔ *Routes*). Hãy tìm mục có ý nghĩa tương đương.

## Các bước

### 1. Ghi lại connector của office-qa (chỉ xem, không sửa)

1. Vào https://dash.cloudflare.com, rồi **Zero Trust → Networks → Tunnels → office-qa**.
2. Xem mục **Connectors** và ghi lại *Origin IP* / hostname / platform của connector để báo cáo.
3. Nếu connector đó lại là máy **ADMIN** hoặc IP `192.168.1.11`, điều này mâu thuẫn với kết quả kiểm tra ở trên. Khi đó **dừng lại và báo chủ shop**, không làm tiếp.

### 2. Gỡ route ads khỏi office-qa

1. Trong office-qa, mở tab **Routes** (hoặc *Public Hostname*).
2. Xoá **chỉ** dòng `ads.eagleglobal2023.com`. Các dòng qa / ul / mz giữ nguyên.
3. Nếu hộp xác nhận hỏi có xoá luôn bản ghi DNS không, chọn **có**.

### 3. Xoá bản ghi DNS cũ (nếu vẫn còn)

1. Vào **Websites → eagleglobal2023.com → DNS → Records**.
2. Tìm bản ghi `CNAME` tên `ads`. Chỉ xoá nếu nội dung đúng là `085f6c8a-fb50-4468-8c04-e861e18d800a.cfargotunnel.com`.

### 4. Tạo tunnel ads-bridge

1. Vào **Tunnels → Create a tunnel → Cloudflared**.
2. Đặt tên `ads-bridge`, rồi bấm **Save tunnel**.
3. Chọn **Windows**, **64-bit**. Không tải file cài vì máy ADMIN đã có `cloudflared` 2026.10.0.
4. Nhắn chủ shop nguyên văn đoạn sau, không chèn token:

   > Trên **máy ADMIN** (máy có thư mục D:\ADS), anh/chị bấm nút copy ở ô lệnh trên trang. Ô này nằm dưới chữ *"If you already have cloudflared installed on your machine"*, lệnh có dạng `cloudflared.exe service install eyJ...`.
   > Mở **PowerShell bằng quyền Administrator** và chạy theo đúng dạng:
   > `& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install eyJ...`
   > Thấy báo cài dịch vụ thành công thì nhắn tôi "xong".

5. Khi chủ shop nhắn "xong", đợi mục **Connectors** hiện một connector **Connected / Healthy**, làm mới trang nếu cần. Kiểm tra *Origin IP* / hostname của connector này phải là máy ADMIN, khác với connector của office-qa ở bước 1.
   - Sau khoảng 2 phút vẫn không lên: máy ADMIN đang bật Cloudflare WARP, có thể WARP chặn kết nối của cloudflared. Báo chủ shop thử tắt WARP (Disconnect), đợi 1 phút rồi xem lại. Vẫn không được thì dừng lại và báo.
6. Bấm **Next**.

### 5. Thêm route cho ads-bridge

| Ô | Giá trị |
| --- | --- |
| Subdomain | `ads` |
| Domain | `eagleglobal2023.com` |
| Path | *để trống* |
| Service Type | `HTTP` |
| URL | `127.0.0.1:8787` |

- Không bật tuỳ chọn thêm nào, rồi bấm **Save**.
- Nếu báo bản ghi DNS `ads` đã tồn tại thì quay lại bước 3 kiểm tra. Không xoá bản ghi nào khác.

### 6. Kiểm tra

1. Mục **DNS → Records** phải có `CNAME ads` → `<ID của ads-bridge>.cfargotunnel.com`, **Proxied**.
2. Tunnel `ads-bridge` phải **Healthy**. Tunnel `office-qa` vẫn **Healthy**, các route qa / ul / mz còn nguyên.
3. Mở https://ads.eagleglobal2023.com/healthz rồi ghi lại kết quả. Hiện bridge có thể đang tắt, nên **502 vẫn là bình thường** ở bước này. Claude Code sẽ bật bridge và kiểm tra lại.

## Báo cáo cuối cùng cho chủ shop (không kèm token)

- Connector của office-qa nằm ở máy nào (Origin IP / hostname).
- Đã gỡ route `ads` khỏi office-qa chưa. qa / ul / mz còn nguyên không.
- Tunnel `ads-bridge`: ID, trạng thái, Origin IP / hostname của connector.
- Route `ads.eagleglobal2023.com → http://127.0.0.1:8787` và bản ghi DNS mới.
- Kết quả `/healthz`.

Kết thúc bằng câu: **"Đã chuyển ads sang tunnel ads-bridge trên máy ADMIN. Quay lại Claude Code để kiểm tra."**
