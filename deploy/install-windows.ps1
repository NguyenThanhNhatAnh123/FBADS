<#
Cài bridge Telegram (BRIEF_HANDLER=claude, không dùng key Meta / Shopify / Google) lên một máy Windows.

Chạy trong PowerShell của CHÍNH user sẽ giữ bot (không dùng tài khoản SYSTEM, vì phiên đăng nhập Claude nằm trong profile user):
    cd <thư mục dự án>
    powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1

Tuỳ chọn:
    -AtStartup     tự chạy lúc bật máy kể cả khi chưa ai đăng nhập Windows (mở PowerShell bằng "Run as administrator",
                   script hỏi mật khẩu Windows của user này để Task Scheduler chạy thay)
    -NoAutostart   không cài tự khởi động

Việc của người cài: chép thư mục dự án sang (kèm .env.bridge của máy cũ nếu có), và đăng nhập Claude khi script nhắc.
TẮT bridge trên máy cũ trước (pm2 stop bridge): một bot Telegram chỉ được một máy nhận tin.
#>
param([switch]$AtStartup, [switch]$NoAutostart)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$envFile = Join-Path $root '.env.bridge'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "   OK  $t" -ForegroundColor Green }
function Find-Cmd($name) { $c = Get-Command $name -ErrorAction SilentlyContinue; if ($c) { return $c.Source } return $null }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function New-Secret {
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Get-EnvVal($key) {
  $l = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($l) { return ($l -split '=', 2)[1].Trim() } return ''
}
function Set-EnvVal($key, $val) {
  $lines = @(Get-Content $envFile -Encoding UTF8)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^$key=") { $lines[$i] = "$key=$val"; $found = $true } }
  if (-not $found) { $lines += "$key=$val" }
  [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------- 1. Node.js
Step '1. Node.js (>= 22.18)'
$node = Find-Cmd node
if (-not $node) {
  Write-Host '   Chưa có Node.js — cài bằng winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $node = Find-Cmd node
  if (-not $node) { throw 'Cài Node.js xong nhưng chưa thấy lệnh node — mở PowerShell mới rồi chạy lại script.' }
}
$v = (& node -v).TrimStart('v').Split('.')
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 18)) { throw "Node $(& node -v) quá cũ — cần >= 22.18 (winget upgrade OpenJS.NodeJS.LTS)." }
Ok "node $(& node -v)"

# ---------------------------------------------------------------- 2. Claude Code CLI
Step '2. Claude Code CLI'
$claude = Find-Cmd claude
$local = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (-not $claude -and (Test-Path $local)) { $claude = $local }
if (-not $claude) {
  Write-Host '   Chưa có Claude Code — cài bằng bộ cài chính thức...'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  if (Test-Path $local) { $claude = $local } else { Refresh-Path; $claude = Find-Cmd claude }
  if (-not $claude) { throw 'Chưa tìm thấy claude.exe sau khi cài — mở PowerShell mới rồi chạy lại script.' }
}
Ok "$(& $claude --version) ($claude)"

# ---------------------------------------------------------------- 3. Đăng nhập Claude + connector
Step '3. Đăng nhập Claude (tài khoản claude.ai có connector Facebook Ads / Shopify / Google Drive)'
function Test-Connectors {
  $out = (& $claude mcp list 2>&1 | Out-String)
  $miss = @()
  foreach ($n in 'Facebook Ads', 'Shopify', 'Google Drive') { if ($out -notmatch "claude\.ai $n.*Connected") { $miss += $n } }
  return , $miss
}
$miss = Test-Connectors
if ($miss.Count -gt 0) {
  Write-Host "   Chưa thấy connector: $($miss -join ', ')." -ForegroundColor Yellow
  Write-Host '   Sắp mở Claude Code: gõ /login, chọn đăng nhập bằng tài khoản claude.ai của shop (mở trình duyệt), xong gõ /exit để quay lại.' -ForegroundColor Yellow
  Read-Host '   Nhấn Enter để mở Claude Code'
  & $claude
  $miss = Test-Connectors
  if ($miss.Count -gt 0) { throw "Vẫn chưa thấy connector $($miss -join ', '). Kiểm tra tài khoản đã bật connector này trên claude.ai (Settings → Connectors) rồi chạy lại." }
}
Ok 'connector Facebook Ads, Shopify, Google Drive đã kết nối'

# ---------------------------------------------------------------- 4. Thư viện
Step '4. Thư viện'
# Máy đã có node_modules (chạy lại script / bridge đang chạy) thì npm install, không xoá sạch như npm ci (Windows khoá file đang dùng).
# better-sqlite3 13 ships native prebuilds. Skip npm's implicit node-gyp rebuild
# (which otherwise requires Python/Visual Studio even when a prebuild exists).
if (Test-Path (Join-Path $root 'node_modules')) { & npm install --ignore-scripts --no-audit --no-fund } else { & npm ci --ignore-scripts --no-audit --no-fund }
if ($LASTEXITCODE -ne 0) { throw 'Cài thư viện lỗi' }
& node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('SELECT 1').get();db.close();"
if ($LASTEXITCODE -ne 0) { throw 'Không tải được SQLite native prebuild — kiểm tra Node.js và kiến trúc máy.' }
Ok 'node_modules'

# ---------------------------------------------------------------- 5. .env.bridge
Step '5. Cấu hình .env.bridge'
$fresh = $false
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.bridge.example') $envFile
  $fresh = $true
  Write-Host '   Tạo .env.bridge mới từ .env.bridge.example (lần sau có thể chép file này từ máy cũ cho nhanh).'
}
foreach ($k in 'MCP_TOKEN', 'BRIDGE_KEY', 'TG_WEBHOOK_SECRET') { if (-not (Get-EnvVal $k)) { Set-EnvVal $k (New-Secret); Ok "tạo $k ngẫu nhiên" } }
$token = Get-EnvVal 'TG_BOT_TOKEN'
if (-not $token) {
  $token = (Read-Host '   Dán token bot Telegram (từ @BotFather)').Trim()
  Set-EnvVal 'TG_BOT_TOKEN' $token
}
$me = Invoke-RestMethod "https://api.telegram.org/bot$token/getMe"
Ok "bot @($me.result.username)"
if (-not (Get-EnvVal 'TG_ALLOWED_CHAT_IDS')) {
  Read-Host "   Mở Telegram, nhắn 'hi' cho @$($me.result.username) từ tài khoản chủ shop, rồi nhấn Enter"
  $u = Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates?timeout=0"
  $chat = $u.result | ForEach-Object { $_.message.chat } | Where-Object { $_ -and $_.type -eq 'private' } | Select-Object -Last 1
  if (-not $chat) { throw 'Không thấy tin nhắn riêng nào gửi tới bot (hoặc bot đang có webhook / máy khác đang nhận tin). Tắt bridge ở máy cũ rồi thử lại.' }
  Set-EnvVal 'TG_ALLOWED_CHAT_IDS' "$($chat.id)"
  Ok "chat_id $($chat.id)"
}
Set-EnvVal 'BRIEF_HANDLER' 'claude'
Set-EnvVal 'CLAUDE_BIN' ($claude -replace '\\', '/')
if ($fresh) {
  Set-EnvVal 'BRIDGE_POLLING' '1'          # nhận tin bằng getUpdates: không cần tunnel / mở cổng
  Set-EnvVal 'BRIDGE_PUBLIC_URL' ''
  Set-EnvVal 'CLAUDE_DRY_RUN' '1'          # an toàn: chạy thử, không đụng Meta cho tới khi chủ shop cho chạy thật
}
Ok "BRIEF_HANDLER=claude · BRIDGE_POLLING=$(Get-EnvVal 'BRIDGE_POLLING') · CLAUDE_DRY_RUN=$(Get-EnvVal 'CLAUDE_DRY_RUN')"

# ---------------------------------------------------------------- 6. Kiểm tra
Step '6. Kiểm tra (npm run doctor)'
& npm run --silent doctor
if ($LASTEXITCODE -ne 0) { throw 'doctor báo còn mục cần sửa (xem ở trên).' }

# ---------------------------------------------------------------- 7. pm2
Step '7. Chạy nền bằng pm2'
$pm2 = Find-Cmd pm2
if (-not $pm2) {
  & npm install -g pm2
  if ($LASTEXITCODE -ne 0) { throw 'Cài pm2 lỗi' }
  $pm2 = Join-Path $env:APPDATA 'npm\pm2.cmd'
}
& $pm2 startOrRestart ecosystem.config.cjs --only bridge
& $pm2 save
Ok 'bridge đang chạy (pm2 ls / pm2 logs bridge)'

# ---------------------------------------------------------------- 8. Tự khởi động
Step '8. Tự khởi động'
if ($NoAutostart) {
  Write-Host '   Bỏ qua (-NoAutostart). Sau khi khởi động lại máy, chạy: pm2 resurrect'
} elseif ($AtStartup) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw '-AtStartup cần mở PowerShell bằng "Run as administrator".' }
  $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Mật khẩu Windows của user này (để bridge chạy cả khi chưa ai đăng nhập)'
  $action = New-ScheduledTaskAction -Execute $pm2 -Argument 'resurrect' -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'ADS bridge (pm2 resurrect)' -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -Force | Out-Null
  Ok 'Task Scheduler: "ADS bridge (pm2 resurrect)" chạy lúc bật máy, kể cả khi chưa ai đăng nhập'
} else {
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\ads-bridge-pm2.cmd'
  Set-Content -Path $startup -Encoding ASCII -Value "@`"$pm2`" resurrect"
  Ok "chạy khi user $env:USERNAME đăng nhập Windows ($startup). Muốn chạy cả khi chưa đăng nhập: chạy lại script với -AtStartup (quyền Admin)."
}

$port = Get-EnvVal 'BRIDGE_PORT'; if (-not $port) { $port = '8787' }
$ui = "http://127.0.0.1:$port/ui"
Write-Host "`nXONG. Trang quản lý: $ui  ·  Gõ /status cho bot trên Telegram để kiểm tra. Đổi cấu hình: sửa .env.bridge rồi chạy  pm2 restart bridge" -ForegroundColor Green
Start-Sleep -Seconds 3
Start-Process $ui
if ((Get-EnvVal 'CLAUDE_DRY_RUN') -eq '1') { Write-Host 'Đang CHẠY THỬ (CLAUDE_DRY_RUN=1): không tạo / bật gì trên Meta. Chạy thật: đặt CLAUDE_DRY_RUN=0 rồi pm2 restart bridge.' -ForegroundColor Yellow }
