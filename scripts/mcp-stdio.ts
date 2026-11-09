// Cầu nối stdio ↔ /mcp của bridge, cho Claude Desktop chạy CÙNG MÁY với bridge (không cần Cloudflare Tunnel).
// Claude Desktop chỉ chạy MCP server kiểu lệnh (stdio); script này chuyển nguyên từng tin JSON-RPC
// sang POST http://127.0.0.1:<BRIDGE_PORT>/mcp kèm Authorization: Bearer <MCP_TOKEN> đọc từ .env.bridge,
// nên token không phải ghi vào claude_desktop_config.json.
//
// Khai báo trong %APPDATA%\Claude\claude_desktop_config.json:
//   "mcpServers": { "telegram-bridge": { "command": "C:/Program Files/nodejs/node.exe",
//                                        "args": ["D:/ADS/scripts/mcp-stdio.ts"] } }
//
// stdout chỉ dành cho JSON-RPC; mọi log ghi ra stderr (Claude Desktop lưu ở logs\mcp-server-telegram-bridge.log).

import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const envFile = process.env.BRIDGE_ENV_FILE ?? fileURLToPath(new URL('../.env.bridge', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.MCP_TOKEN ?? '';
if (!token) {
  console.error(`[mcp-stdio] Thiếu MCP_TOKEN (đọc từ ${envFile})`);
  process.exit(1);
}
const host = !process.env.BRIDGE_HOST || process.env.BRIDGE_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.BRIDGE_HOST;
const url = process.env.BRIDGE_LOCAL_URL ?? `http://${host}:${process.env.BRIDGE_PORT ?? 8787}/mcp`;

type Id = string | number | null;
type Msg = { jsonrpc?: string; id?: Id; method?: string };

const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
const fail = (ids: Id[], message: string) => {
  for (const id of ids) write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bridge có thể khởi động sau Claude Desktop (cùng lúc đăng nhập Windows) → thử lại khi chưa kết nối được.
async function post(body: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== 'ECONNREFUSED' || attempt >= 6) throw err;
      await sleep(2_000);
    }
  }
}

async function forward(line: string): Promise<void> {
  let parsed: Msg | Msg[];
  try {
    parsed = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const ids = (Array.isArray(parsed) ? parsed : [parsed]).filter((m) => m.id !== undefined).map((m) => m.id as Id);

  let res: Response;
  try {
    res = await post(line);
  } catch (err) {
    console.error('[mcp-stdio] Không gọi được bridge', err);
    return fail(ids, `Không kết nối được bridge ở ${url}. Chạy "npm run bridge" (hoặc pm2) trong D:\\ADS rồi thử lại.`);
  }

  const text = await res.text();
  if (res.status === 401) return fail(ids, 'Bridge từ chối MCP_TOKEN (401). Kiểm tra MCP_TOKEN trong .env.bridge rồi khởi động lại bridge.');
  if (!text.trim()) {
    if (!res.ok) fail(ids, `Bridge trả HTTP ${res.status}`);
    return; // 202 cho notification
  }
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const l of text.split(/\r?\n/)) if (l.startsWith('data:')) process.stdout.write(l.slice(5).trim() + '\n');
    return;
  }
  try {
    const out = JSON.parse(text) as Msg | Msg[];
    // Lỗi HTTP của bridge mang id null → gắn lại id của request để Claude Desktop hiện được lỗi.
    if (!res.ok && !Array.isArray(out) && out.id == null) return fail(ids, `Bridge trả HTTP ${res.status}: ${text.slice(0, 300)}`);
    write(out);
  } catch {
    fail(ids, `Bridge trả HTTP ${res.status} không phải JSON: ${text.slice(0, 300)}`);
  }
}

const pending = new Set<Promise<void>>();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = forward(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
console.error(`[mcp-stdio] Chuyển tiếp stdio → ${url}`);
