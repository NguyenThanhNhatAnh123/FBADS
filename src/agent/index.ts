// Điểm vào của Agent (pm2: tiến trình "agent").

import { loadAgentConfig } from './config.ts';
import { AgentStore } from './db.ts';
import { TelegramApi } from '../shared/telegram.ts';
import { MetaClient } from './meta/graph.ts';
import { MetaAds } from './meta/ads.ts';
import { GoogleDrive } from './drive.ts';
import { Shopify } from './shopify.ts';
import { ClaudeCopyWriter } from './copy/writer.ts';
import * as media from './media.ts';
import { Runner } from './pipeline/runner.ts';
import { AgentApp } from './app.ts';
import { buildAgentServer, listen } from './server.ts';
import { startScheduler } from './scheduler.ts';
import { resumeUnfinished } from './resume.ts';
import { startPolling } from './polling.ts';
import type { Deps } from './pipeline/types.ts';
import { logger } from '../shared/log.ts';

const log = logger('agent');

async function main(): Promise<void> {
  const cfg = loadAgentConfig();
  const ff = await media.checkFfmpeg();
  if (ff) throw new Error(ff);

  const store = new AgentStore(cfg.dbFile);
  store.upsertAccountFromConfig(cfg);

  const deps: Deps = {
    cfg,
    store,
    tg: new TelegramApi(cfg.tgBotToken),
    meta: new MetaAds(
      new MetaClient({ token: cfg.meta.token, version: cfg.meta.apiVersion, graphBase: cfg.meta.graphBase, videoBase: cfg.meta.videoBase }),
      { adAccount: cfg.meta.adAccount, pageId: cfg.meta.pageId, pixelId: cfg.meta.pixelId },
    ),
    drive: new GoogleDrive(cfg.google.serviceAccountJson),
    shopify: new Shopify({
      domain: cfg.shopify.domain,
      apiVersion: cfg.shopify.apiVersion,
      token: cfg.shopify.token || undefined,
      clientId: cfg.shopify.clientId || undefined,
      clientSecret: cfg.shopify.clientSecret || undefined,
    }),
    copy: new ClaudeCopyWriter({
      apiKey: cfg.claude.apiKey,
      model: cfg.claude.model,
      fallbacks: cfg.claude.fallbacks,
      effort: (process.env.CLAUDE_EFFORT as 'low' | 'medium' | 'high' | undefined) || undefined,
    }),
    media,
  };

  const runner = new Runner(deps);
  const app = new AgentApp(deps, runner);
  const http = await listen(buildAgentServer(app, deps), cfg.port);
  log.info(`Agent nghe http://127.0.0.1:${cfg.port} · tài khoản ${cfg.account.name} (${cfg.meta.adAccount}) · Graph ${cfg.meta.apiVersion} · Claude ${cfg.claude.model}`);

  // Server khởi động lại giữa chừng → chạy tiếp các brief dở từ `step` đã ghi.
  resumeUnfinished(store, runner);

  const stopScheduler = startScheduler(deps);
  const stopPolling = process.env.TG_POLLING === '1' ? startPolling(deps.tg, app) : () => {};

  const shutdown = async (sig: string) => {
    log.info(`Nhận ${sig}, dừng Agent…`);
    stopPolling();
    stopScheduler();
    http.close();
    await Promise.race([runner.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('Agent không khởi động được', err);
  process.exit(1);
});
