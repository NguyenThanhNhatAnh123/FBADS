# Meta Ads AI Agent (Giai đoạn 1) + MCP Telegram bridge

Hai tiến trình Node.js/TypeScript chạy trên server Windows văn phòng, theo hai đặc tả `Tab 1.md` và `MCP Telegram bridge.md`:

| Tiến trình | Việc | Mở ra Internet |
| --- | --- | --- |
| **bridge** (`src/bridge`) | Giữ bot Telegram (webhook), chuyển brief / nút `ag:` sang Agent ngay lập tức, lưu tin tự do + nút `cl:` cho Claude, mở 8 tool MCP cho custom connector claude.ai | Có — đúng 2 đường `/tg/webhook`, `/mcp` qua Cloudflare Tunnel |
| **agent** (`src/agent`) | Nhận brief `#NEW` / `#ADD`, dựng creative → Post ID → campaign → adset → ad ở trạng thái **PAUSED** trên H3, gửi tin duyệt, chỉ bật khi chủ shop bấm **Duyệt & chạy** | Không — chỉ nghe `127.0.0.1` |

```
Telegram ──webhook──► bridge ──localhost /brief, /callback──► agent ──► Meta · Drive · Shopify · Claude API
   ▲                    │  ▲                                     │
   │                    │  └── claude.ai (custom connector /mcp) │
   └──── Bot API (agent gửi tin duyệt / kết quả trực tiếp) ◄─────┘
```

## Chế độ không dùng key: `BRIEF_HANDLER=claude`

Server không giữ token Meta, Shopify, Google hay Claude API. Bridge tự xử lý brief bằng **Claude Code chạy headless** (`claude -p`) trên chính máy này, đăng nhập bằng tài khoản claude.ai đã có connector **Facebook Ads**, **Shopify**, **Google Drive**. Không chạy tiến trình agent. Trên server chỉ còn token bot Telegram, `MCP_TOKEN`, `BRIDGE_KEY` và phiên đăng nhập Claude Code.

```
Telegram ──► bridge: đọc brief + giới hạn an toàn (code) ──► claude -p (lượt create: chỉ tạo NHÁP)
                                                               │ connector Facebook Ads / Shopify / Drive
             ◄── tin duyệt (bridge soát tên, budget, bid, copy) ◄┘ submit_drafts qua MCP "adsjob" (localhost)
bấm Duyệt ──► claude -p (lượt activate: lượt DUY NHẤT có ads_activate_entity) ──► 🟢 ĐANG CHẠY
```

**Rào chắn nằm ở code, không nằm ở prompt**

- Mỗi lượt chạy với `--restricted --permission-mode dontAsk`: không có Bash / PowerShell / WebFetch, không đọc settings của user, tool ngoài danh sách bị từ chối ngay (`src/bridge/jobs/prompts.ts` → `allowedToolsFor`).
- Connector Facebook Ads đang ở **draft mode**: `ads_create_*` chỉ tạo bản nháp trong Ads Manager, không tiêu tiền. Lượt create / sửa copy / huỷ **không được cấp** `ads_activate_entity`, nên không thể làm quảng cáo chạy. Chỉ khi chủ shop bấm **Duyệt & chạy / Chỉ V1 / Chỉ V2** bridge mới mở lượt activate có tool đó.
- Bridge (code) đọc brief, chặn budget > $300 (xác nhận lần 2), mức cap ngoài $5–150, brief trùng trong 10 phút, tổng budget > $1.500 (cộng brief đang chờ; camp đang chạy thì Claude đọc live rồi gửi `check_budget`, bridge tự cộng).
- `submit_drafts` bị trả về nếu tên camp / adset, `daily_budget` (cent), `bid_strategy`, quốc gia lệch giá trị bridge tính sẵn, object mới đang ACTIVE, hoặc copy vi phạm `src/agent/copy/rules.ts`. Tin duyệt chỉ được gửi khi mọi thứ khớp.
- Nút ký HMAC + số phiên bản, đổi trạng thái nguyên tử → bấm hai lần không chạy hai lần. Tiến trình claude nói chuyện với bridge qua `/job-mcp/<token một lần>`, chỉ nhận từ localhost; request qua tunnel bị 401.
- Biến bí mật (`TG_BOT_TOKEN`, `MCP_TOKEN`, `BRIDGE_KEY`, `ANTHROPIC_API_KEY`…) bị xoá khỏi env của tiến trình con. Thư mục làm việc của mỗi lượt là thư mục rỗng.
- `graphql_mutation` của Shopify chỉ cấp cho lượt create (để đưa media qua Shopify Files). Sau **mỗi** lượt, `src/bridge/jobs/audit.ts` đọc nhật ký phiên (`~/.claude/projects/<thư mục lượt>/<session_id>.jsonl`) và liệt kê mọi lần ghi dữ liệu vào `job_runs.audit_json`; mutation Shopify ngoài `fileCreate` / `fileDelete`, xoá file không do lượt đó tạo, `ads_update_entity` đổi budget / bid / target / DELETED trên object ngoài brief, bật object ngoài danh sách duyệt → báo 🔴 và **khoá brief** (gỡ nút duyệt).

**Cài**

1. Đăng nhập Claude Code trên máy này một lần (`claude`, rồi `/login` bằng tài khoản có connector). Kiểm tra: `claude mcp list` phải thấy `claude.ai Facebook Ads`, `claude.ai Shopify`, `claude.ai Google Drive` đều ✔ Connected.
2. `.env.bridge`: `BRIEF_HANDLER=claude`, `CLAUDE_BIN=C:/Users/Admin/.local/bin/claude.exe` (xem `.env.bridge.example`). Không cần `.env.agent`.
3. Chạy `npm run bridge` (test local: `BRIDGE_POLLING=1`) hoặc `pm2 start ecosystem.config.cjs --only bridge`.
4. Thư mục / file creative trên Drive: **Chia sẻ → Bất kỳ ai có đường liên kết – Người xem** (Drive báo `visibility: UNLISTED`). File riêng tư thì Claude dừng và báo cần mở quyền.
5. Media đi **Drive → Shopify Files → Meta**: Meta không tải được link Drive (robots.txt của `drive.usercontent.google.com` là `Disallow: /`), nên lượt create gọi Shopify `fileCreate` với link tải Drive, chờ READY, đưa URL `cdn.shopify.com` cho `ads_creative_upload_media`, rồi `fileDelete` file trung gian. Shopify trả luôn width / height / duration để soát tỷ lệ khung. Đã thử 09/11/2026: Shopify kéo được file Drive UNLISTED, URL CDN trả đúng ảnh (kể cả với user-agent `facebookexternalhit`). Chưa thử bước Meta tải từ CDN (chưa được phép ghi lên H3).

**Chạy thử không đụng Meta** (`CLAUDE_DRY_RUN=1`): lượt claude chỉ được cấp tool đọc (Shopify, Drive, Facebook Ads), vẫn đọc sản phẩm, kiểm tra quyền Drive, viết + soát copy, rồi nộp bản nháp với ID giả. Tin duyệt gắn 🧪 CHẠY THỬ; Sửa copy chạy lượt sửa thật (chỉ đọc); Duyệt / Huỷ chỉ giả lập và ghi rõ khi chạy thật sẽ publish những gì. Job chạy thử không tính vào trần ngân sách.

**Cài lên máy khác (chỉ cần đăng nhập Claude)**

Trên máy chỉ có: token bot Telegram + `MCP_TOKEN` / `BRIDGE_KEY` / `TG_WEBHOOK_SECRET` (trong `.env.bridge`) và phiên đăng nhập Claude Code. Không cần key Meta / Shopify / Google / Claude API, không cần Claude Desktop, không cần tunnel (polling).

1. Máy cũ: `pm2 stop bridge` — một bot Telegram chỉ được một máy nhận tin (hai máy cùng polling → lỗi 409).
2. Chép thư mục dự án sang máy mới, **kèm `.env.bridge`** (và `data/` nếu muốn giữ lịch sử brief), bỏ `node_modules`:
   `robocopy D:\ADS \\MAY-MOI\D$\ADS /E /XD node_modules .git .claude tmp`
   (không có `.env.bridge` cũng được: script tự tạo mã nội bộ, hỏi token bot và tự lấy `chat_id`).
3. Trên máy mới, đăng nhập Windows bằng **user sẽ giữ bot**, rồi **bấm đúp `deploy\Setup-24h.cmd`** (chạy 24/24 kể cả khi chưa ai đăng nhập — Windows hỏi quyền Admin) hoặc `deploy\Setup.cmd` (chạy khi user này đăng nhập). Hai file này gọi script dưới đây; muốn chạy tay thì mở PowerShell của user đó:
   ```powershell
   cd D:\ADS
   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1            # tự chạy khi user này đăng nhập
   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -AtStartup # (Run as administrator) chạy lúc bật máy, kể cả chưa ai đăng nhập
   ```
   Script: cài Node / Claude Code nếu thiếu → nhắc `/login` Claude (một lần) → kiểm connector Facebook Ads / Shopify / Google Drive → `npm ci` → hoàn thiện `.env.bridge` (`BRIEF_HANDLER=claude`, `CLAUDE_BIN`, giữ `CLAUDE_DRY_RUN` của máy cũ, file mới thì mặc định chạy thử) → `npm run doctor` → pm2 → tự khởi động.
4. Kiểm tra: gõ `/status` cho bot; `npm run doctor -- --live` (thêm một lượt `claude -p` chỉ đọc xem connector có thấy tài khoản quảng cáo).

`npm run doctor` dùng được bất cứ lúc nào: báo thiếu gì (Node, thư viện, `.env.bridge`, Claude CLI, đăng nhập + 3 connector, bot Telegram, cổng, pm2) và cách sửa. Phiên Claude hết hạn / bị đăng xuất → bot báo 🔴 khi có brief; chạy `claude` → `/login`. Không dùng được token `claude setup-token` (không lấy được connector claude.ai).

**Trang quản lý** — `http://127.0.0.1:8787/ui` (chỉ mở được trên chính máy chạy bridge; script cài tự mở): tình trạng bot / nhận tin / Claude + 3 connector / lượt đang chạy, danh sách brief (bấm vào xem brief, tin duyệt, từng lượt Claude: số bước, chi phí quy đổi, kết quả soát nhật ký, log, lệnh `claude --resume`), nút chạy lại brief lỗi, chạy `doctor`, và chuyển CHẠY THỬ ↔ CHẠY THẬT (phải gõ "CHẠY THẬT"; ghi vào `.env.bridge`, báo lên Telegram). Bảo vệ: chỉ loopback, từ chối request qua tunnel / proxy và Host lạ, mọi API cần token phiên nhúng trong trang, POST kiểm Origin.

**Dùng**: gửi brief như cũ. Bot trả "📥 Đã nhận brief #N", dòng trạng thái được cập nhật theo từng bước, rồi gửi tin duyệt có nút **Duyệt & chạy / Chỉ V1 / Chỉ V2 / Sửa copy / Huỷ**. `/status` xem brief đang xử lý, `/retry N` chạy lại brief lỗi. Chưa duyệt sau 24 giờ thì nhắc, sau 72 giờ tự huỷ bản nháp.

**Log và chi phí**: mỗi lượt ghi `data/claude-runs/run-<id>.log` (prompt, stderr, JSON kết quả). Bảng `job_runs` trong `data/bridge.db` lưu `session_id` (mở lại bằng `claude --resume <id>`), số lượt, tool bị chặn. Lượt chạy dùng hạn mức gói Claude của tài khoản, không tính tiền API.

**Kết quả chạy thật ở local (09/11/2026, bot thật, `claude -p` thật, `CLAUDE_DRY_RUN=1`)**: brief → đọc Shopify + quyền Drive → viết + soát copy → tin duyệt 🧪 (≈ 80 giây, ≈ 15 lượt) · Sửa copy → tin duyệt mới · Chỉ V1 (giả lập) · bấm lại nút cũ bị chặn · brief sai → một tin lỗi · $400 → xác nhận lần 2 · Huỷ (giả lập) · `/retry` · `/status`. Không tool ghi Meta nào được cấp, H3 không có gì mới.

**Còn phải kiểm khi được phép ghi lên H3**:

- Meta tải ảnh / video từ `cdn.shopify.com` (bước cuối của đường media; link Drive thì Meta từ chối: `Image Wasn't Downloaded … robots.txt`, subcode 3858258).
- Connector chưa đọc được bản nháp trên H3 (`object_state=draft`: "tool is new and is being gradually rolled out") — prompt bật / huỷ đang dựa vào việc đọc nháp, cần thử lại khi Meta mở.
- `ads_get_ig_accounts` trả về rỗng: Page chưa gắn tài khoản Instagram cho quảng cáo → ad chỉ chạy bằng danh tính Page.

**Khác với Agent dùng key** (cần lưu ý khi nghiệm thu):

- Một brief mất vài phút (Claude gọi connector từng bước), chạy lần lượt từng brief.
- Không có `ffprobe`: thời lượng / tỷ lệ video lấy từ metadata Drive và Meta; không đo được thì để trống và không đoán.
- Copy viết từ dữ liệu Shopify + tên file + Ghi chú copy; Claude không xem được khung hình video.
- Chưa có bảng `posts` để tự dùng lại Post ID cũ cho cùng video + copy (dùng trường `Post ID` của `#ADD`).
- `get_billing_status` không dùng được (không có Agent): scheduled task cảnh báo thanh toán đọc bằng connector Facebook Ads.

## Cài đặt trên server Windows

1. **Phần mềm**: Node.js LTS ≥ 22.18 (chạy thẳng file `.ts`, không cần build), `ffmpeg` + `ffprobe` trong PATH, `pm2` (`npm i -g pm2`), `cloudflared` (đã có).
2. **Mã nguồn**: `npm ci --ignore-scripts`. Các thư viện hiện tại không cần install script; `better-sqlite3` 13 đã kèm native prebuild. Cờ này tránh npm tự gọi `node-gyp` và yêu cầu Python / Visual Studio không cần thiết. Kiểm tra SQLite: `node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('SELECT 1').get();db.close();"`.
3. **Cấu hình**: copy `.env.agent.example` → `.env.agent`, `.env.bridge.example` → `.env.bridge`, điền khoá (mục *Tài khoản, token và quyền* trong `Tab 1.md`). `BRIDGE_KEY` hai file phải giống nhau. Tìm `chat_id` của chủ shop: điền `TG_BOT_TOKEN`, nhắn "hi" cho bot, chạy `npm run chat-id`. Tạo chuỗi ngẫu nhiên:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
4. **Kiểm tra khoá trước khi chạy** (không tạo gì trên Meta — dùng `validate_only`):
   ```powershell
   npm run preflight -- raven-spirit-3d-hoodie   # handle một sản phẩm đang bán để thử Shopify
   ```
5. **Cloudflare Tunnel**: trỏ hostname bridge vào `http://127.0.0.1:8787`, không trỏ vào Agent (8788).
   - Cách dễ trên Windows: Cloudflare Zero Trust → *Networks → Tunnels* → **Create a tunnel** (Cloudflared) → chạy lệnh `cloudflared.exe service install <token>` mà trang đưa ra (PowerShell quyền Admin) → *Public Hostname*: `bridge.<tên-miền>` → `HTTP` `127.0.0.1:8787`.
   - Cách dùng file cấu hình: xem `deploy/cloudflared-config.example.yml`. File này mở đúng `/tg/webhook` và `/mcp`, còn lại trả 404. Bridge cũng tự trả 404 cho mọi đường khác.
6. **Chạy nền**:
   ```powershell
   pm2 start ecosystem.config.cjs
   pm2 save
   ```
   pm2 không tự khởi động cùng Windows: cài thêm `pm2-installer` (chạy pm2 như Windows service) hoặc dùng NSSM bọc lệnh `pm2 resurrect`.
7. **Webhook**: bridge tự gọi `setWebhook` khi khởi động nếu có `BRIDGE_PUBLIC_URL`. Có thể chạy tay và tự thử request giả: `npm run set-webhook`.
8. **Custom connector trên claude.ai**: *Customize → Connectors* (https://claude.ai/customize/connectors) → **+ Add** → **Add custom connector**. Gói Team/Enterprise: Owner thêm ở *Organization settings → Connectors* trước. Ở mục Authentication, chọn **No sign in**.
   - Nếu thấy mục **Request headers**: header `authorization`, giá trị `Bearer <MCP_TOKEN>` (phải tự gõ chữ `Bearer `). URL là `https://<tên-miền-bridge>/mcp`.
   - Nếu không thấy mục đó (Request headers đang beta, chỉ một số tổ chức có): đặt `MCP_ALLOW_PATH_TOKEN=1` trong `.env.bridge`, khởi động lại bridge, rồi dùng URL `https://<tên-miền-bridge>/mcp/<MCP_TOKEN>`. URL này là mật khẩu, đừng dán ở đâu khác.
   - Thiết lập xác thực không sửa được sau khi thêm. Muốn đổi token: sửa `MCP_TOKEN`, xoá connector rồi thêm lại.
   - Trong một chat: nút **+** → *Connectors* → bật connector, rồi bảo Claude "gọi get_status".
   - **Claude Desktop trên chính server này** không cần tunnel: `scripts/mcp-stdio.ts` chuyển stdio → `http://127.0.0.1:8787/mcp` và tự đọc `MCP_TOKEN` từ `.env.bridge`. Khai báo trong `%APPDATA%\Claude\claude_desktop_config.json`:
     ```json
     "mcpServers": { "telegram-bridge": { "command": "C:/Program Files/nodejs/node.exe", "args": ["D:/ADS/scripts/mcp-stdio.ts"] } }
     ```
     Thoát hẳn Claude Desktop (khay hệ thống → Quit) rồi mở lại. Log ở `%APPDATA%\Claude\logs\mcp-server-telegram-bridge.log`. Server này chỉ dùng được trong Claude Desktop trên máy này. Connector trên claude.ai (bản web, điện thoại, scheduled task trên cloud) vẫn cần tunnel như ở trên.
9. **Scheduled task**: dán 3 prompt trong `docs/scheduled-tasks.md`.

**Test local cả hệ thống, chưa cần tunnel** (nên làm trước khi dựng Cloudflare Tunnel):

- Đặt `BRIDGE_POLLING=1` trong `.env.bridge` (Agent để `TG_POLLING=0`), rồi chạy `npm run bridge` và `npm run agent`. Bridge tự nhận tin bằng `getUpdates` và xử lý bằng đúng code của `/tg/webhook`: brief và nút `ag:` đi sang Agent, câu tự do và nút `cl:` vào hộp thư Claude. Claude Desktop trên máy này nối qua `scripts/mcp-stdio.ts` (mục 8).
- Lúc bật, bridge tự gỡ webhook nếu có (tin đang chờ vẫn giữ) và không gọi `setWebhook`. `get_status` báo `webhook.mode: "polling"`.
- Chỉ một tiến trình được `getUpdates` trên một bot. Nếu Agent cũng bật `TG_POLLING=1`, Telegram trả 409. Khi đó bridge ghi log, thử lại liên tục và `get_status` báo lỗi.
- Chuyển sang chạy thật qua tunnel: `BRIDGE_POLLING=0`, điền `BRIDGE_PUBLIC_URL`, khởi động lại bridge (bridge tự `setWebhook`).

**Chỉ chạy Agent, không có bridge**: đặt `TG_POLLING=1` trong `.env.agent` và chỉ chạy `npm run agent`. Agent tự long polling như Tab 1 mô tả ban đầu.

## Dùng hằng ngày

Gửi brief cho bot (mẫu đầy đủ trong `Tab 1.md`):

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

Agent trả lời "📥 Đã nhận brief #id", rồi gửi creative + tin **🟡 CHỜ DUYỆT** có Post ID, link preview, nút **Duyệt & chạy / Chỉ V1 / Chỉ V2 / Sửa copy / Huỷ**. Lệnh: `/status`, `/retry {id}`, `/help`. Thư mục creative trên Drive phải share quyền *Người xem* cho email service account (`npm run preflight` in ra email này).

## Kiểm thử

```powershell
npm run typecheck
npm test
```

87 test, chạy với Telegram / Meta Graph API / Messages API giả lập trong bộ nhớ (ffmpeg thật), phủ hai checklist nghiệm thu và chế độ `BRIEF_HANDLER=claude`:

| Checklist | Test |
| --- | --- |
| Agent — 12 mục Giai đoạn 1 | `test/agent.e2e.test.ts` (#NEW 1 video, thư mục 3 file → 6 ad, #ADD adset mới, #ADD Post ID, duyệt, huỷ, sửa copy, brief lỗi, budget $400, chat lạ, quy tắc copy ở `test/rules.test.ts`) + lỗi Meta → dọn object, token hỏng, Drive chưa share, khởi động lại giữa chừng, nhắc 24h / huỷ 72h |
| Chế độ claude (không dùng key) | `test/bridge.claude.test.ts` với `claude` giả (`test/helpers/fakeClaude.ts`, chạy như tiến trình con thật, gọi MCP "adsjob" thật): brief lỗi → một tin, #NEW → nháp → tin duyệt (lượt create không có `ads_activate_entity`, `--restricted --permission-mode dontAsk`, không lộ `TG_BOT_TOKEN` / `ANTHROPIC_API_KEY`), Duyệt → 🟢 + bấm lại bị chặn, Sửa copy, Huỷ, budget $400, copy vi phạm bị trả về, Claude dừng không báo → /retry, report_failure, #ADD khớp nhiều camp → chọn, trần $1.500, nhắc 24h / huỷ 72h, /job-mcp 401 |
| Bridge — 9 mục | `test/bridge.e2e.test.ts` (MCP client thật qua HTTP: webhook 401, chuyển Agent < 2s, Agent tắt → giữ hàng đợi → chuyển khi bật lại, get_status, send_message/send_file CSV 1 MB, send_approval + bấm nút + mark_handled, list_inbox, token sai 401, chat lạ có log) · `test/bridge.polling.test.ts` (BRIDGE_POLLING: tự gỡ webhook, brief → Agent, câu tự do → hộp thư, khởi động lại không xử lý trùng, 409 thì thử lại) |

Mục "Copy của 10 brief thử không chứa từ cấm" và "Scheduled task chạy thử một lần" chỉ nghiệm thu được với API thật.

## Quyết định thiết kế đáng chú ý

- **Theo tab bridge, không theo long polling của Tab 1**: bot do bridge giữ; Agent nhận `POST /brief` (tin nhắn: brief, lệnh, trả lời tin) và `POST /callback` (nút `ag:`) trên localhost, kèm `X-Bridge-Key`; vẫn gửi tin bằng Bot API trực tiếp. Long polling giữ lại làm chế độ chạy thử (`TG_POLLING=1`).
- **Trả lời "Sửa gì?"**: tin trả lời (reply) vào tin của bot mà không phải tin Claude gửi được chuyển sang Agent; Agent trả `handled:false` nếu không dùng → bridge đưa vào hộp thư Claude. Trả lời thẳng vào tin duyệt cũng được hiểu là yêu cầu sửa copy.
- **Không tạo bài trùng**: bảng `posts` khoá theo (hash nội dung file, hash copy + link). Cùng video + cùng copy luôn dùng lại Post ID cũ, kể cả khi `/retry` hoặc brief sau.
- **Lỗi giữa chừng**: dừng brief, xoá campaign / adset / ad của brief (creative + bài Page giữ lại để dùng lại), báo nguyên văn `error.message` + `error_user_msg`. `/retry {id}` chạy lại từ bước hỏng.
- **Agent và bridge đều chặn update trùng** (`update_id`), để bridge gửi lại khi timeout không tạo brief hai lần.
- **Bổ sung ngoài đặc tả**: tool `send_message` có `dedupe_key` (cảnh báo thanh toán mỗi giờ, mỗi mốc chỉ báo một lần); `get_billing_status` đã làm sẵn (bridge → `GET /billing` của Agent).
- **Claude API**: model `claude-sonnet-5-5` (theo đặc tả, đổi bằng `CLAUDE_MODEL`), structured output JSON, ảnh banner hoặc 3 khung hình video, bật server-side fallback khi bị từ chối (`CLAUDE_FALLBACKS=0` để tắt). Copy vi phạm quy tắc được gửi lại viết tối đa 2 lần; vẫn sai thì brief dừng, không gửi copy xấu đi duyệt.

## Cần kiểm tra với tài khoản thật

- **Graph API `v26.0`** (mới nhất lúc viết, 29/07/2026) — đổi bằng `META_API_VERSION`. Lần gọi đầu: kiểm tra trường bắt buộc về Advantage+ audience (`META_ADVANTAGE_AUDIENCE`), quyền Page / Pixel (pixel thuộc BM khác BM của H3).
- **`GET /billing`** đọc `balance`, `amount_spent`, `spend_cap` của ad account và edge `adspaymentcycle` cho ngưỡng thanh toán — tên trường ngưỡng cần đối chiếu tài liệu Marketing API trước khi bật task cảnh báo.
- **Shopify**: từ 01/01/2026 không tạo được custom app kiểu cũ trong admin; app mới ở Dev Dashboard dùng client credentials (token 24 giờ) — Agent hỗ trợ cả hai cách.
- **Sao lưu DB lên Drive**: service account không có dung lượng My Drive → thư mục đích phải nằm trong Shared Drive. Bản sao lưu trên máy (`data/backups`, giữ 14 ngày) luôn chạy.
- Custom connector claude.ai: mục *Request headers* đang beta, chỉ một số tổ chức có. Nếu không có, dùng `MCP_ALLOW_PATH_TOKEN`. Scheduled task có gọi được custom connector hay không thì tài liệu chưa nói, cần chạy thử một lần.

## Cấu trúc

```
src/shared/    telegram (Bot API), sqlite, env, log, time (Dawson ↔ VN ↔ PST)
src/agent/     index · app (điều phối) · server (HTTP nội bộ) · approval (tin duyệt, nút) · safety (giới hạn)
               brief/parse · meta/graph (lỗi, rate limit, token) · meta/ads · drive · shopify · media (ffmpeg)
               copy/rules (từ cấm, cấu trúc) · copy/writer (Claude API) · pipeline/steps + runner (11 bước)
               scheduler (nhắc 24h, huỷ 72h, sao lưu) · resume (chạy tiếp sau khởi động lại) · polling
src/bridge/    index · server (webhook, /mcp) · polling (BRIDGE_POLLING, test local) · router · forwarder (hàng đợi Agent) · outbox (30 tin/phút) · mcp (tool) · db
scripts/       preflight · set-webhook · chat-id · mcp-stdio (Claude Desktop cùng máy → /mcp)
docs/          scheduled-tasks.md (3 prompt cho claude.ai)
deploy/        cloudflared-config.example.yml
```
