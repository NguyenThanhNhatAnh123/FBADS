// HTTP nội bộ của Agent, chỉ nghe 127.0.0.1 — bridge chuyển brief và lần bấm nút vào đây.
//   POST /brief     (Telegram update dạng message: #NEW/#ADD, lệnh, trả lời tin)
//   POST /callback  (Telegram update dạng callback_query, callback_data bắt đầu bằng ag:)
//   GET  /health
//   GET  /billing   (số dư / ngưỡng thanh toán — bridge bọc thành tool get_billing_status)
// Mọi request phải có header X-Bridge-Key đúng.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AgentApp } from './app.ts';
import type { Deps } from './pipeline/types.ts';
import type { TgUpdate } from '../shared/telegram.ts';
import { errText } from './approval.ts';
import { logger } from '../shared/log.ts';

const log = logger('agent-http');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildAgentServer(app: AgentApp, deps: Deps) {
  const server = express();
  server.disable('x-powered-by');
  server.use(express.json({ limit: '2mb' }));

  server.use((req, res, next) => {
    const key = req.header('x-bridge-key') ?? '';
    if (!safeEqual(key, deps.cfg.bridgeKey)) {
      log.warn(`Từ chối ${req.method} ${req.path}: sai X-Bridge-Key`);
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  });

  const handle = async (req: express.Request, res: express.Response) => {
    const update = req.body as TgUpdate;
    if (!update || typeof update !== 'object') {
      res.status(400).json({ ok: false, error: 'body phải là Telegram update' });
      return;
    }
    try {
      const r = await app.handleUpdate(update);
      res.json({ ok: true, handled: r.handled });
    } catch (err) {
      log.error('Xử lý update lỗi', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  };
  server.post('/brief', handle);
  server.post('/callback', handle);

  server.get('/health', (_req, res) => {
    res.json({ ok: true, halted: app.runner.halted ? true : false, queue: app.runner.queueSize, at: new Date().toISOString() });
  });

  server.get('/billing', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await deps.meta.billingStatus()) });
    } catch (err) {
      res.status(502).json({ ok: false, error: errText(err) });
    }
  });

  return server;
}

export function listen(app: ReturnType<typeof buildAgentServer>, port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
}
