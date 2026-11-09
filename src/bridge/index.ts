// Điểm vào của bridge (pm2: tiến trình "bridge").

import { loadBridgeConfig } from './config.ts';
import { BridgeStore } from './db.ts';
import { TelegramApi } from '../shared/telegram.ts';
import { Outbox, RateLimiter } from './outbox.ts';
import { AgentForwarder } from './forwarder.ts';
import { buildBridgeApp, listen, type BridgeDeps } from './server.ts';
import { newPollingState, startBridgePolling } from './polling.ts';
import { JobStore } from './jobs/store.ts';
import { JobManager } from './jobs/manager.ts';
import { ClaudeCliRunner } from './jobs/runner.ts';
import { logger } from '../shared/log.ts';

const log = logger('bridge');

async function main(): Promise<void> {
  const cfg = loadBridgeConfig();
  const store = new BridgeStore(cfg.dbFile);
  const tg = new TelegramApi(cfg.tgBotToken);
  const limiter = new RateLimiter(cfg.sendPerMinute);
  const outbox = new Outbox(tg, cfg.ownerChatId, limiter);
  const forwarder = new AgentForwarder(cfg, store, (text) => outbox.sendText(text, { markdown: false }));

  let jobs: JobManager | undefined;
  if (cfg.briefHandler === 'claude' && cfg.jobs) {
    const localHost = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    jobs = new JobManager({
      cfg: cfg.jobs,
      ownerChatId: cfg.ownerChatId,
      jobs: new JobStore(store.db),
      tg,
      limiter,
      runner: new ClaudeCliRunner(cfg.jobs),
      mcpBase: () => `http://${localHost}:${cfg.port}`,
    });
  }

  const deps: BridgeDeps = { cfg, store, tg, outbox, forwarder, polling: cfg.polling ? newPollingState() : undefined, jobs };
  const app = buildBridgeApp(deps);
  const http = await listen(app, cfg.port, cfg.host);
  if (jobs) {
    jobs.start();
    log.info(`Bridge nghe http://${cfg.host}:${cfg.port} (/tg/webhook, /mcp, /job-mcp) · BRIEF_HANDLER=claude: brief chạy bằng \`${cfg.jobs!.bin} -p\` với connector claude.ai`);
  } else {
    forwarder.start();
    log.info(`Bridge nghe http://${cfg.host}:${cfg.port} (/tg/webhook, /mcp) · Agent ở ${forwarder.agentBase}`);
  }

  let stopPolling: (() => Promise<void>) | null = null;
  if (cfg.polling) {
    if (cfg.publicUrl) log.warn('BRIDGE_POLLING=1 nên bỏ qua setWebhook dù có BRIDGE_PUBLIC_URL');
    stopPolling = startBridgePolling(deps, deps.polling!);
  } else if (cfg.publicUrl) {
    const url = `${cfg.publicUrl}/tg/webhook`;
    try {
      const info = await tg.getWebhookInfo();
      if (info.url !== url) {
        await tg.setWebhook(url, cfg.tgWebhookSecret);
        log.info(`Đã setWebhook → ${url}`);
      } else log.info(`Webhook đã trỏ đúng ${url}`);
    } catch (err) {
      log.error('setWebhook thất bại — kiểm tra TG_BOT_TOKEN và BRIDGE_PUBLIC_URL', err);
    }
  } else {
    log.warn('Chưa có BRIDGE_PUBLIC_URL: bỏ qua setWebhook (chạy `npm run set-webhook` sau khi có tên miền)');
  }

  const shutdown = (sig: string) => {
    log.info(`Nhận ${sig}, dừng bridge…`);
    void stopPolling?.(); // không chờ: getUpdates đang treo tối đa 25s; offset chưa xác nhận sẽ được gửi lại, update trùng bị chặn
    forwarder.stop();
    jobs?.stop(); // dừng tiến trình claude đang chạy; lần khởi động sau báo "/retry"
    http.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('Bridge không khởi động được', err);
  process.exit(1);
});
