// Kiểm tra trước khi chạy thật: npm run preflight
// Không tạo gì trên Meta (lệnh tạo campaign dùng execution_options=validate_only).

import { loadAgentConfig } from '../src/agent/config.ts';
import { MetaClient, MetaApiError } from '../src/agent/meta/graph.ts';
import { Shopify } from '../src/agent/shopify.ts';
import { GoogleDrive } from '../src/agent/drive.ts';
import { checkFfmpeg } from '../src/agent/media.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import Anthropic from '@anthropic-ai/sdk';

const cfg = loadAgentConfig();
const meta = new MetaClient({ token: cfg.meta.token, version: cfg.meta.apiVersion, graphBase: cfg.meta.graphBase });
let failed = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`✓ ${name}: ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}: ${err instanceof MetaApiError ? err.ownerText.replace(/\n/g, ' · ') : (err as Error).message}`);
  }
}

await check('ffmpeg / ffprobe', async () => {
  const e = await checkFfmpeg();
  if (e) throw new Error(e);
  return 'có trong PATH';
});
await check('Telegram bot', async () => `@${(await new TelegramApi(cfg.tgBotToken).getMe()).username}`);
await check('Meta token', async () => {
  const me = await meta.get<{ id: string; name: string }>('me', { fields: 'id,name' });
  return `${me.name} (${me.id}) · Graph ${cfg.meta.apiVersion}`;
});
await check(`Ad account ${cfg.meta.adAccount}`, async () => {
  const a = await meta.get<{ name: string; account_status: number; currency: string; timezone_name: string }>(cfg.meta.adAccount, {
    fields: 'name,account_status,currency,timezone_name',
  });
  if (a.timezone_name !== cfg.account.timezone) throw new Error(`múi giờ ${a.timezone_name} khác cấu hình ${cfg.account.timezone}`);
  return `${a.name} · status ${a.account_status} · ${a.currency} · ${a.timezone_name}`;
});
await check(`Page ${cfg.meta.pageId}`, async () => (await meta.get<{ name: string }>(cfg.meta.pageId, { fields: 'name' })).name);
await check(`Pixel ${cfg.meta.pixelId}`, async () => (await meta.get<{ name: string }>(cfg.meta.pixelId, { fields: 'name' })).name);
await check('Quyền tạo campaign (validate_only, không tạo thật)', async () => {
  await meta.post(`${cfg.meta.adAccount}/campaigns`, {
    name: 'preflight validate only',
    objective: 'OUTCOME_SALES',
    status: 'PAUSED',
    special_ad_categories: [],
    daily_budget: 500,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    execution_options: ['validate_only'],
  });
  return 'Meta chấp nhận tham số campaign';
});
await check('Shopify Admin API', async () => {
  const s = new Shopify({
    domain: cfg.shopify.domain,
    apiVersion: cfg.shopify.apiVersion,
    token: cfg.shopify.token || undefined,
    clientId: cfg.shopify.clientId || undefined,
    clientSecret: cfg.shopify.clientSecret || undefined,
  });
  const handle = process.argv[2];
  if (!handle) return 'bỏ qua đọc sản phẩm (truyền handle: npm run preflight -- <handle>)';
  const p = await s.getProduct(handle, `https://${cfg.shopify.publicDomain}/products/${handle}`);
  return `${p.title} · ${p.status} · ${p.priceRange}`;
});
await check('Google service account', async () => `share creative cho: ${new GoogleDrive(cfg.google.serviceAccountJson).serviceAccountEmail}`);
await check(`Claude API (${cfg.claude.model})`, async () => {
  const m = await new Anthropic({ apiKey: cfg.claude.apiKey }).models.retrieve(cfg.claude.model);
  return `${m.display_name}`;
});

console.log(failed ? `\n${failed} mục chưa đạt.` : '\nTất cả đạt.');
process.exit(failed ? 1 : 0);
