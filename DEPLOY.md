# Cài lên máy mới (Windows 10 / 11, 64-bit)

Gói này là bridge Telegram + trang quản lý + skill `meta-ads-h3`. Máy mới chỉ cần đăng nhập Claude (tài khoản claude.ai đã bật connector Facebook Ads, Shopify, Google Drive). Không cần key Meta / Shopify / Google / Claude API, không cần mở cổng.

## Các bước

1. **Giải nén** vào một thư mục cố định, ví dụ `D:\ADS`.
2. **Cấu hình** — chọn một trong hai:
   - Chép file `.env.bridge` từ máy cũ (`D:\ADS\.env.bridge`) vào thư mục vừa giải nén: giữ nguyên token bot, chat_id và chế độ chạy thử / chạy thật. Đây là cách nhanh nhất.
   - Không chép: script cài sẽ hỏi token bot (từ @BotFather), tự tạo mã nội bộ và tự lấy chat_id khi bạn nhắn "hi" cho bot.
3. **Máy cũ**: tắt bridge trước khi bật máy mới — một bot Telegram chỉ được một máy nhận tin:
   ```powershell
   pm2 stop bridge
   pm2 save
   ```
4. **Máy mới**: đăng nhập Windows bằng user sẽ giữ bot, rồi bấm đúp
   - `deploy\Setup-24h.cmd` — chạy 24/24, kể cả khi chưa ai đăng nhập (Windows hỏi quyền Admin, script hỏi mật khẩu Windows của user này), hoặc
   - `deploy\Setup.cmd` — chạy khi user này đăng nhập.

   Script cài Node.js, Claude Code, pm2 nếu thiếu → mở Claude Code để bạn gõ `/login` (một lần) → kiểm 3 connector → cài thư viện → hoàn thiện `.env.bridge` → `npm run doctor` → chạy bridge bằng pm2 → cài tự khởi động → mở trang quản lý.
5. **Kiểm tra**: gõ `/status` cho bot trên Telegram · mở http://127.0.0.1:8787/ui · `npm run doctor -- --live`.

## Chạy thử / chạy thật

`.env.bridge` mới tạo mặc định **chạy thử** (`CLAUDE_DRY_RUN=1`): không tạo / bật gì trên Meta. Khi đã sẵn sàng chạy thật: trang quản lý → "Chuyển sang CHẠY THẬT" (gõ xác nhận), hoặc đặt `CLAUDE_DRY_RUN=0` trong `.env.bridge` rồi `pm2 restart bridge`.

## Tuỳ chọn

- **Skill trong Claude**: skill `meta-ads-h3` đã cài trong tài khoản claude.ai. File `meta-ads-h3.skill` kèm trong gói để cài lại (claude.ai → Customize → Skills → Add → Upload skill).
- **Claude Desktop trên máy mới** gửi báo cáo lên Telegram: thêm vào `%APPDATA%\Claude\claude_desktop_config.json`
  ```json
  "mcpServers": { "telegram-bridge": { "command": "C:/Program Files/nodejs/node.exe", "args": ["D:/ADS/scripts/mcp-stdio.ts"] } }
  ```
  (đổi `D:/ADS` theo thư mục cài, dùng dấu `/`), thoát hẳn Claude Desktop rồi mở lại.
- **Tên miền công khai** (webhook Telegram, connector Telegram bridge trên claude.ai web / điện thoại). Tunnel `office-qa` đã có route `ads.eagleglobal2023.com → http://127.0.0.1:8787`, và connector của tunnel đó đang chạy trên máy văn phòng tên "Admin" (máy dùng tunnel này). **Cài bridge lên đúng máy đó thì route chạy luôn** — không cần tạo tunnel mới, không cần sửa route:
  1. Cài xong (mặc định nhận tin bằng polling), mở https://ads.eagleglobal2023.com/healthz từ điện thoại hoặc máy khác → phải trả `{"ok":true,…}` (trước đây trả 502 vì bridge chưa chạy trên máy đó).
  2. Trong `.env.bridge` đặt `BRIDGE_POLLING=0` và `BRIDGE_PUBLIC_URL=https://ads.eagleglobal2023.com`, rồi `pm2 restart bridge` — bridge tự `setWebhook`. Kiểm tra: gõ `/status` cho bot.
  3. Connector trên claude.ai: Customize → Connectors → Add custom connector, URL `https://ads.eagleglobal2023.com/mcp`, header `Authorization: Bearer <MCP_TOKEN trong .env.bridge>`. Màn hình không có mục Request headers thì đặt `MCP_ALLOW_PATH_TOKEN=1`, `pm2 restart bridge`, và dùng URL `https://ads.eagleglobal2023.com/mcp/<MCP_TOKEN>` (URL này là mật khẩu).

  Không cài thêm connector `office-qa` ở máy thứ hai: một tunnel có connector ở hai máy sẽ chia request (qa / ul / mz / ads) sang cả hai. Trang `/ui` và đường `/job-mcp` tự từ chối request đi qua tunnel, chỉ mở được trên chính máy đó.

## Lệnh hằng ngày

`pm2 ls` · `pm2 logs bridge` · `pm2 restart bridge` (sau khi sửa `.env.bridge`) · `npm run doctor`. Phiên Claude hết hạn: chạy `claude` → `/login`.

Chi tiết kỹ thuật: `README.md`.
