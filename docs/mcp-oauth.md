# OAuth cho connector ADS trên claude.ai

Đặt `BRIDGE_PUBLIC_URL=https://ads.eagleglobal2023.com`, restart bridge. OAuth dùng DB bridge hiện có (`data/bridge.db`), giữ đăng ký client và token qua lần restart. Khi chuyển tên miền, cần kết nối lại connector.

## Thêm connector

Dùng URL `https://ads.eagleglobal2023.com/mcp`, chọn OAuth. Để trống Client ID / Client Secret để Claude tự đăng ký hoặc dùng CIMD. Khi trình duyệt mở trang **Cho phép Claude kết nối ADS** trên đúng tên miền, nhập `MCP_TOKEN` từ `.env.bridge` rồi bấm Cho phép. Mã này không được gửi qua URL, đưa vào Git hay log server.

Đăng ký client không tự cấp quyền. Callback chỉ được là `https://claude.ai/api/mcp/auth_callback` hoặc `https://claude.com/api/mcp/auth_callback` (so khớp toàn bộ URI). Authorization yêu cầu PKCE S256 và xác nhận chủ shop. Access token có hạn một giờ, refresh token 30 ngày và xoay mỗi lần dùng; phát hiện dùng lại refresh token cũ sẽ thu hồi cả phiên. Mã authorization có hạn 5 phút, dùng một lần. Token chỉ hợp lệ với resource `/mcp` của server này.

## Discovery và DCR

`GET /.well-known/oauth-authorization-server` trả metadata có `registration_endpoint`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]` và `client_id_metadata_document_supported: true`.

`GET /.well-known/oauth-protected-resource/mcp` (và đường không có `/mcp`) trả resource cùng authorization server. Request MCP chưa có token nhận `401` với `WWW-Authenticate` trỏ tới metadata này.

`POST /register` nhận JSON RFC 7591, trả `201` và `client_id`. Hỗ trợ `token_endpoint_auth_method` là `none`, `client_secret_post` hoặc `client_secret_basic`; client có secret nhận thêm `client_secret`. Chỉ hỗ trợ grant authorization code / refresh token. Không cấp access token ở bước đăng ký.

Ví dụ đăng ký public client (chưa cấp quyền):

```json
{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

## CIMD

Trust policy giới hạn tải metadata từ bốn URL chính thức trên host `claude.ai` / `claude.com`, đường `/oauth/mcp-oauth-client-metadata` hoặc `/api/oauth/mcp-oauth-client-metadata`. Chặn redirect HTTP, timeout 10 giây, giới hạn 32 KiB; kiểm tra `client_id` khớp URL, tên client, callback, auth method `none`. Cache tối đa 5 phút và tuân thủ `no-store`, `no-cache`, `max-age`. Không tải URL do client tuỳ ý cung cấp. Endpoint Claude hiện có thể chặn một số đường bằng WAF; khi CIMD lỗi, xem log hoặc dùng DCR.

## Log và chẩn đoán

`pm2 logs bridge` hoặc `data/pm2/logs/bridge-out.log` (PM2_HOME riêng của máy deploy) có sự kiện `[oauth] OAuth request`: request ID, method, path, HTTP status, mã lỗi OAuth, tên trường sai định dạng, IP nguồn và user-agent. Không ghi body, Authorization header, owner token, code hay token trả về. Khi Claude gọi `/register`, thành công có `Client registered` và `POST /register` status `201`; lỗi callback có cảnh báo riêng và `invalid_client_metadata`.

Tunnel phải chuyển các đường discovery, `/register`, `/authorize`, `/token`, `/revoke`, `/oauth/approve` tới cổng 8787; file mẫu `deploy/cloudflared-config.example.yml` đã gồm các đường này. `/ui` và `/job-mcp` tiếp tục chỉ cho localhost.

Rate limit áp dụng chung cho các request đi qua tunnel của bridge một chủ sở hữu: DCR 20/giờ; authorize/revoke 100/15 phút; token 50/15 phút. Sau khi sửa server, chọn Connect/Reconnect trên Claude và đối chiếu request ID/giờ trong log. Log trước khi có OAuth không thể truy lại request 404 nếu chưa bật access log.
