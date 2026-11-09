// HTTP của bridge. Cloudflare Tunnel mở webhook, MCP và OAuth ra Internet:
//   POST /tg/webhook   — Telegram đẩy update (kiểm tra X-Telegram-Bot-Api-Secret-Token)
//   POST /mcp          — Claude custom connector (Authorization: Bearer <MCP_TOKEN>)
// GET /healthz chỉ dùng nội bộ.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BridgeConfig } from './config.ts';
import type { BridgeStore } from './db.ts';
import type { Outbox } from './outbox.ts';
import type { AgentForwarder } from './forwarder.ts';
import type { PollingState } from './polling.ts';
import { TelegramError, type TelegramApi, type TgUpdate } from '../shared/telegram.ts';
import { chatIdOf, classify, inboxFields, kindOf } from './router.ts';
import { buildMcpServer } from './mcp.ts';
import type { JobManager } from './jobs/manager.ts';
import { buildJobMcpServer } from './jobs/tools.ts';
import { mountUi, type UiOptions } from './ui/routes.ts';
import { logger } from '../shared/log.ts';
import { mountOAuth } from './oauth.ts';
import { StagedMedia, mountMedia } from './media.ts';
import { ReadonlyBilling } from './billing.ts';

const log = logger('bridge-http');

export interface BridgeDeps {
  cfg: BridgeConfig;
  store: BridgeStore;
  tg: TelegramApi;
  outbox: Outbox;
  forwarder: AgentForwarder;
  polling?: PollingState; // chỉ có khi BRIDGE_POLLING=1
  jobs?: JobManager; // chỉ có khi BRIEF_HANDLER=claude
  ui?: UiOptions; // trang quản lý /ui (chỉ khi có jobs)
  media?: StagedMedia;
  billing?: ReadonlyBilling;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Xử lý một update đã qua kiểm tra secret. Tách riêng để test. */
export async function handleUpdate(d: BridgeDeps, u: TgUpdate): Promise<string> {
  const { store, cfg } = d;
  if (typeof u?.update_id !== 'number') return 'bad';
  const chatId = chatIdOf(u);
  if (!store.recordUpdate(u.update_id, kindOf(u), chatId)) return 'duplicate';
  if (chatId === null || !cfg.tgAllowedChatIds.includes(chatId)) {
    store.setRouted(u.update_id, 'ignored', `chat ${chatId} không được phép`);
    log.warn(`Bỏ qua update ${u.update_id} từ chat ${chatId} (không nằm trong TG_ALLOWED_CHAT_IDS)`, { from: u.message?.from?.id ?? u.callback_query?.from.id });
    return 'ignored';
  }
  const route = classify(u, (id) => store.isClaudeMessage(id), d.jobs ? { jobs: d.jobs } : {});
  switch (route.to) {
    case 'jobs': {
      const jobs = d.jobs!;
      store.setRouted(u.update_id, 'jobs', route.what);
      if (route.what === 'button') await jobs.onButton(u.callback_query!);
      else if (route.what === 'brief') await jobs.onBrief(u.message!);
      else if (route.what === 'command') await jobs.onCommand(u.message!);
      else if (!(await jobs.onReply(u.message!))) {
        const m = u.message!;
        store.addInbox({ message_id: m.message_id, chat_id: m.chat.id, ...inboxFields(m) });
        store.setRouted(u.update_id, 'inbox');
        return 'inbox';
      }
      return 'jobs';
    }
    case 'agent':
      d.forwarder.enqueue(u, route.endpoint, route.fallbackInbox);
      store.setRouted(u.update_id, 'agent', route.why);
      return 'agent';
    case 'buttons':
      store.setRouted(u.update_id, 'buttons');
      await handleClaudeButton(d, u);
      return 'buttons';
    case 'inbox': {
      const m = route.message;
      store.addInbox({ message_id: m.message_id, chat_id: m.chat.id, ...inboxFields(m) });
      store.setRouted(u.update_id, 'inbox');
      return 'inbox';
    }
    default:
      store.setRouted(u.update_id, 'ignored', route.why);
      return 'ignored';
  }
}

async function handleClaudeButton(d: BridgeDeps, u: TgUpdate): Promise<void> {
  const cq = u.callback_query!;
  const m = /^cl:(\d+):(\d)$/.exec(cq.data ?? '');
  const a = m ? d.store.getApproval(Number(m[1])) : undefined;
  const buttons = a ? (JSON.parse(a.buttons_json) as Array<{ id: string; label: string }>) : [];
  const b = m ? buttons[Number(m[2])] : undefined;
  if (!a || !b) {
    await d.tg.answerCallbackQuery(cq.id, 'Nút không hợp lệ');
    return;
  }
  const pressId = d.store.addPress(a, b.id, b.label, cq.message?.message_id ?? a.message_id);
  if (pressId === null) {
    await d.tg.answerCallbackQuery(cq.id, 'Tin này đã được trả lời rồi');
    return;
  }
  await d.tg.answerCallbackQuery(cq.id, 'Đã ghi nhận, Claude sẽ xử lý ở lượt chạy kế tiếp');
  // Gỡ nút và ghi lựa chọn vào cuối tin để không bấm hai lần.
  const msgId = cq.message?.message_id ?? a.message_id;
  if (!msgId) return;
  const chatId = cq.message?.chat.id ?? d.cfg.ownerChatId;
  const suffix = `\n\n✅ Đã chọn: ${b.label} — Claude sẽ xử lý ở lượt chạy kế tiếp`;
  try {
    if (a.text.length + suffix.length <= 4096) {
      await d.tg.editMessageText(chatId, msgId, cq.message?.text ? cq.message.text + suffix : a.text + suffix, {});
    } else {
      await d.tg.editMessageReplyMarkup(chatId, msgId);
    }
  } catch (err) {
    if (!(err instanceof TelegramError)) throw err;
    await d.tg.editMessageReplyMarkup(chatId, msgId).catch(() => {});
  }
}

export function buildBridgeApp(d: BridgeDeps) {
  const app = express();
  app.disable('x-powered-by');
  const oauth = mountOAuth(app, d.cfg, d.store.db);
  const media = d.media ?? new StagedMedia(d.cfg.media ?? { publicUrl: d.cfg.publicUrl, dir: 'data/staged-media', serviceAccountJson: '', ffprobePath: 'ffprobe', maxCacheBytes: 5_000_000_000 }, d.store.db);
  const billing = d.billing ?? new ReadonlyBilling(d.cfg.billing ?? { token: '', apiVersion: 'v26.0' });
  mountMedia(app, media);

  // ---- Telegram webhook ----
  app.post('/tg/webhook', express.json({ limit: '2mb' }), async (req, res) => {
    const secret = req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(secret, d.cfg.tgWebhookSecret)) {
      log.warn(`Từ chối webhook không có secret_token đúng từ ${req.ip}`);
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const r = await handleUpdate(d, req.body as TgUpdate);
      res.status(200).json({ ok: true, routed: r });
    } catch (err) {
      log.error('Xử lý webhook lỗi', err);
      // Vẫn trả 200: Telegram gửi lại sẽ bị chặn trùng update_id; lỗi đã được ghi log.
      res.status(200).json({ ok: false });
    }
  });

  // ---- MCP ----
  const bearerOk = async (req: express.Request): Promise<boolean> => {
    const h = req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const token = m[1].trim();
    if (safeEqual(token, d.cfg.mcpToken)) return true;
    if (!oauth) return false;
    try { await oauth.verifyAccessToken(token); return true; } catch { return false; }
  };
  const mcpHandler = async (req: express.Request, res: express.Response) => {
    const server = buildMcpServer({ ...d, media, billing });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP request lỗi', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  const deny = (res: express.Response) => {
    if (oauth) res.set('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', oauth.issuer).href}", scope="mcp"`);
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  };
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });

  app.post('/mcp', express.json({ limit: '16mb' }), async (req, res) => {
    if (!(await bearerOk(req))) {
      log.warn(`Từ chối /mcp: token sai hoặc thiếu (${req.ip})`);
      return deny(res);
    }
    void mcpHandler(req, res);
  });
  app.get('/mcp', async (req, res) => ((await bearerOk(req)) ? notAllowed(req, res) : deny(res)));
  app.delete('/mcp', async (req, res) => ((await bearerOk(req)) ? notAllowed(req, res) : deny(res)));

  if (d.cfg.mcpAllowPathToken) {
    // Dự phòng khi connector không gửi được header: https://<bridge>/mcp/<MCP_TOKEN>
    app.post('/mcp/:token', express.json({ limit: '16mb' }), (req, res) => {
      if (!safeEqual(String(req.params.token), d.cfg.mcpToken)) {
        log.warn(`Từ chối /mcp/:token sai (${req.ip})`);
        return deny(res);
      }
      void mcpHandler(req, res);
    });
  }

  // ---- MCP riêng của từng lượt `claude -p` (chỉ localhost, token một lần) ----
  if (d.jobs) {
    const jobs = d.jobs;
    app.post('/job-mcp/:token', express.json({ limit: '4mb' }), async (req, res) => {
      // Qua Cloudflare Tunnel thì có cf-connecting-ip / x-forwarded-for: từ chối, đường này chỉ cho tiến trình trên máy.
      const viaProxy = !!(req.header('cf-connecting-ip') || req.header('x-forwarded-for'));
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
      const active = !viaProxy && loopback ? jobs.runForToken(String(req.params.token)) : null;
      if (!active) {
        log.warn(`Từ chối /job-mcp (token sai, lượt đã xong hoặc không phải localhost) từ ${req.ip}`);
        return deny(res);
      }
      const server = buildJobMcpServer(jobs, active);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error('job-mcp request lỗi', err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
    app.get('/job-mcp/:token', (_req, res) => notAllowed(_req, res));
    app.delete('/job-mcp/:token', (_req, res) => notAllowed(_req, res));

    // ---- Trang quản lý cục bộ http://127.0.0.1:<port>/ui ----
    mountUi(app, d, d.ui);
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));
  app.use((_req, res) => res.status(404).json({ ok: false }));
  return app;
}

export function listen(app: ReturnType<typeof buildBridgeApp>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
}
