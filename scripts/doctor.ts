// Kiểm tra máy đã sẵn sàng chạy bridge ở chế độ BRIEF_HANDLER=claude chưa (dùng khi cài lên máy mới).
// Chỉ đọc: không gửi tin Telegram, không tạo gì trên Meta / Shopify / Drive.
//
//   npm run doctor            kiểm tra nhanh
//   npm run doctor -- --live  thêm một lượt `claude -p` chỉ đọc: connector Facebook Ads có thấy tài khoản quảng cáo không

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBridgeConfig, type BridgeConfig } from '../src/bridge/config.ts';

type Check = { name: string; ok: boolean | 'warn'; detail: string; fix?: string };
const checks: Check[] = [];
const add = (c: Check) => {
  checks.push(c);
  const icon = c.ok === true ? '✅' : c.ok === 'warn' ? '⚠️ ' : '❌';
  console.log(`${icon} ${c.name}: ${c.detail}${c.ok !== true && c.fix ? `\n     → ${c.fix}` : ''}`);
};
const live = process.argv.includes('--live');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. Node
const [maj, min] = process.versions.node.split('.').map(Number);
add({ name: 'Node.js', ok: maj > 22 || (maj === 22 && min >= 18), detail: process.versions.node, fix: 'Cài Node.js LTS ≥ 22.18 (winget install OpenJS.NodeJS.LTS)' });

// 2. node_modules
add({ name: 'Thư viện (npm ci)', ok: fs.existsSync(path.join(root, 'node_modules', 'better-sqlite3')), detail: fs.existsSync(path.join(root, 'node_modules')) ? 'có node_modules' : 'chưa có node_modules', fix: 'Chạy npm ci trong thư mục dự án' });

// 3. .env.bridge
const envFile = path.join(root, '.env.bridge');
let cfg: BridgeConfig | null = null;
if (!fs.existsSync(envFile)) {
  add({ name: '.env.bridge', ok: false, detail: 'không có file', fix: 'Chép .env.bridge từ máy cũ (cách nhanh nhất) hoặc chạy deploy/install-windows.ps1 để tạo' });
} else {
  try {
    cfg = loadBridgeConfig(process.env);
    add({ name: '.env.bridge', ok: true, detail: `đủ khoá · chat ${cfg.tgAllowedChatIds.join(', ')}` });
  } catch (err) {
    add({ name: '.env.bridge', ok: false, detail: (err as Error).message, fix: 'Điền các biến còn thiếu (xem .env.bridge.example)' });
  }
}

if (cfg) {
  add({
    name: 'Chế độ xử lý brief',
    ok: cfg.briefHandler === 'claude' ? true : 'warn',
    detail: cfg.briefHandler === 'claude' ? `claude${cfg.jobs?.dryRun ? ' · CHẠY THỬ (CLAUDE_DRY_RUN=1, không đụng Meta)' : ' · CHẠY THẬT'}` : 'agent (cần key trong .env.agent)',
    fix: 'Đặt BRIEF_HANDLER=claude trong .env.bridge',
  });
  add({ name: 'Nhận tin Telegram', ok: true, detail: cfg.polling ? 'polling (không cần tunnel / mở cổng)' : `webhook ${cfg.publicUrl || '(chưa có BRIDGE_PUBLIC_URL)'}` });
}

// 4. Claude Code CLI + đăng nhập + connector
const bin = cfg?.jobs?.bin ?? process.env.CLAUDE_BIN ?? 'claude';
const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
const hasCli = ver.status === 0;
add({ name: 'Claude Code CLI', ok: hasCli, detail: hasCli ? `${ver.stdout.trim()} (${bin})` : `không chạy được "${bin}"`, fix: 'Cài: irm https://claude.ai/install.ps1 | iex — rồi đặt CLAUDE_BIN=<đường dẫn claude.exe> trong .env.bridge' });
if (hasCli) {
  const mcp = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const out = `${mcp.stdout}\n${mcp.stderr}`;
  for (const name of ['Facebook Ads', 'Shopify', 'Google Drive']) {
    const line = out.split(/\r?\n/).find((l) => l.includes(`claude.ai ${name}`));
    const ok = !!line && /Connected/i.test(line);
    add({
      name: `Connector ${name}`,
      ok,
      detail: line ? line.replace(/^.*?claude\.ai /, '').trim() : 'không thấy (chưa đăng nhập Claude, hoặc tài khoản chưa bật connector)',
      fix: 'Chạy `claude`, gõ /login bằng tài khoản claude.ai đã bật connector này, rồi chạy lại doctor',
    });
  }
}
if (process.env.ANTHROPIC_API_KEY) add({ name: 'ANTHROPIC_API_KEY', ok: 'warn', detail: 'có trong môi trường — bridge tự bỏ khi gọi claude -p, nhưng nên xoá để khỏi nhầm sang tính tiền API' });

// 5. Telegram
if (cfg) {
  try {
    const base = `https://api.telegram.org/bot${cfg.tgBotToken}`;
    const me = (await (await fetch(`${base}/getMe`, { signal: AbortSignal.timeout(20_000) })).json()) as { ok: boolean; result?: { username: string } };
    add({ name: 'Bot Telegram', ok: me.ok, detail: me.ok ? `@${me.result!.username}` : 'token sai', fix: 'Kiểm tra TG_BOT_TOKEN' });
    const wh = (await (await fetch(`${base}/getWebhookInfo`, { signal: AbortSignal.timeout(20_000) })).json()) as { result?: { url: string } };
    if (cfg.polling && wh.result?.url) add({ name: 'Webhook', ok: 'warn', detail: `bot đang có webhook ${wh.result.url} — bridge polling sẽ tự gỡ khi chạy` });
  } catch (err) {
    add({ name: 'Bot Telegram', ok: false, detail: `không gọi được Telegram: ${(err as Error).message}`, fix: 'Kiểm tra mạng ra Internet' });
  }

  // 6. Cổng / bridge đang chạy
  const running = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (running) add({ name: `Cổng ${cfg.port}`, ok: true, detail: 'bridge đang chạy trên máy này' });
  else {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
      s.listen(cfg!.port, '127.0.0.1');
    });
    add({ name: `Cổng ${cfg.port}`, ok: free, detail: free ? 'trống, sẵn sàng' : 'đang bị chương trình khác dùng', fix: 'Đổi BRIDGE_PORT hoặc tắt chương trình đang dùng cổng' });
  }
}

// Optional bridge extensions: lack of billing credentials must not block the bot.
if (cfg?.media) {
  const probe = spawnSync(cfg.media.ffprobePath, ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  add({ name: 'Media ffprobe', ok: probe.status === 0 ? true : 'warn', detail: probe.status === 0 ? probe.stdout.split(/\r?\n/)[0] : 'chưa chạy được ffprobe; stage_drive_media chưa sẵn sàng', fix: 'Cài FFmpeg và đặt FFPROBE_PATH trong .env.bridge' });
  add({ name: 'Drive staging', ok: true, detail: cfg.media.serviceAccountJson ? 'đã cấu hình service account readonly (cần Viewer trên thư mục)' : 'chỉ file công khai; chưa có service account / email để chia sẻ' });
}
if (cfg?.billing) add({ name: 'Billing H3', ok: cfg.billing.token ? true : 'warn', detail: cfg.billing.token ? 'đã có META_READ_TOKEN (chưa xác minh quyền)' : 'chưa có META_READ_TOKEN; tool sẽ báo not_configured' });

// 7. pm2
const pm2 = spawnSync('pm2', ['-v'], { encoding: 'utf8', timeout: 60_000, shell: true, windowsHide: true });
add({ name: 'pm2', ok: pm2.status === 0 ? true : 'warn', detail: pm2.status === 0 ? pm2.stdout.trim().split(/\r?\n/).pop()! : 'chưa cài', fix: 'npm install -g pm2 (deploy/install-windows.ps1 tự cài)' });

// 8. --live: một lượt claude -p chỉ đọc qua connector
if (live && hasCli && cfg?.jobs) {
  const acc = cfg.jobs.account.adAccountId;
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'TG_BOT_TOKEN', 'MCP_TOKEN', 'BRIDGE_KEY', 'TG_WEBHOOK_SECRET', 'META_READ_TOKEN', 'DRIVE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SA_JSON']) delete env[k];
  const r = spawnSync(
    bin,
    ['-p', '--restricted', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Facebook_Ads__ads_get_ad_accounts', '--max-turns', '6', '--output-format', 'json'],
    { input: `Gọi mcp__claude_ai_Facebook_Ads__ads_get_ad_accounts. Trả lời đúng một dòng JSON {"found": <true nếu có tài khoản id ${acc}>, "name": "<tên>", "status": "<account_status>", "mcp_enabled": <is_ads_mcp_enabled>}. Không gọi tool nào khác.`, encoding: 'utf8', timeout: 300_000, env, windowsHide: true },
  );
  let detail = 'không đọc được kết quả';
  let ok = false;
  try {
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
    const ans = JSON.parse(String(j.result).match(/\{.*\}/s)![0]);
    ok = ans.found === true && /ACTIVE/i.test(ans.status) && ans.mcp_enabled !== false;
    detail = `${ans.name ?? '?'} · ${ans.status ?? '?'} · mcp ${ans.mcp_enabled}`;
  } catch {
    detail = (r.stdout || r.stderr || '').slice(-300);
  }
  add({ name: `claude -p thấy tài khoản ${acc}`, ok, detail, fix: 'Kiểm tra đăng nhập Claude và quyền của tài khoản trên connector Facebook Ads' });
}

const bad = checks.filter((c) => c.ok === false).length;
console.log(bad ? `\n❌ Còn ${bad} mục cần sửa.` : `\n✅ Máy sẵn sàng${live ? '' : ' (chạy thêm --live để thử một lượt claude -p chỉ đọc)'}.`);
process.exit(bad ? 1 : 0);
