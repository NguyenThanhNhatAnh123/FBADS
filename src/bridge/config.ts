import { EnvReader } from '../shared/env.ts';
import { loadJobsConfig, type ClaudeJobsConfig } from './jobs/config.ts';

export interface BridgeConfig {
  /** agent (mặc định): chuyển brief sang Agent dùng key; claude: bridge tự chạy `claude -p` với connector claude.ai. */
  briefHandler?: 'agent' | 'claude';
  jobs?: ClaudeJobsConfig; // có khi briefHandler = 'claude'
  port: number;
  host: string;
  publicUrl: string; // https://<tên-miền-bridge>, dùng cho setWebhook
  dbFile: string;
  tgBotToken: string;
  tgWebhookSecret: string;
  tgAllowedChatIds: number[];
  ownerChatId: number;
  mcpToken: string;
  mcpAllowPathToken: boolean;
  polling: boolean; // BRIDGE_POLLING=1: nhận tin bằng getUpdates thay webhook (test local)
  agentPort: number;
  agentHost: string;
  bridgeKey: string;
  sendPerMinute: number;
  agentRetryEveryS: number;
  agentNotifyAfterMin: number;
  agentGiveUpAfterH: number;
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const e = new EnvReader(env);
  const allowed = e.list('TG_ALLOWED_CHAT_IDS').map(Number).filter(Number.isFinite);
  const cfg: BridgeConfig = {
    port: e.num('BRIDGE_PORT', 8787),
    host: e.opt('BRIDGE_HOST', '127.0.0.1'),
    publicUrl: e.opt('BRIDGE_PUBLIC_URL').replace(/\/$/, ''),
    dbFile: e.opt('BRIDGE_DB', 'data/bridge.db'),
    tgBotToken: e.str('TG_BOT_TOKEN'),
    tgWebhookSecret: e.str('TG_WEBHOOK_SECRET'),
    tgAllowedChatIds: allowed,
    ownerChatId: e.num('TG_OWNER_CHAT_ID', allowed[0] ?? 0),
    mcpToken: e.str('MCP_TOKEN'),
    mcpAllowPathToken: e.bool('MCP_ALLOW_PATH_TOKEN', false),
    polling: e.bool('BRIDGE_POLLING', false),
    agentPort: e.num('AGENT_PORT', 8788),
    agentHost: e.opt('AGENT_HOST', '127.0.0.1'),
    bridgeKey: e.str('BRIDGE_KEY'),
    sendPerMinute: e.num('BRIDGE_SEND_PER_MIN', 30),
    agentRetryEveryS: e.num('AGENT_RETRY_EVERY_S', 30),
    agentNotifyAfterMin: e.num('AGENT_NOTIFY_AFTER_MIN', 10),
    agentGiveUpAfterH: e.num('AGENT_GIVE_UP_AFTER_H', 24),
  };
  const handler = e.opt('BRIEF_HANDLER', 'agent').toLowerCase();
  if (handler === 'claude') {
    cfg.briefHandler = 'claude';
    cfg.jobs = loadJobsConfig(e, cfg.bridgeKey);
  } else if (handler !== 'agent') e.invalid.push(`BRIEF_HANDLER=${handler} (chỉ nhận agent hoặc claude)`);
  if (cfg.mcpToken && cfg.mcpToken.length < 32) e.invalid.push('MCP_TOKEN phải dài tối thiểu 32 ký tự ngẫu nhiên');
  if (cfg.tgWebhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(cfg.tgWebhookSecret)) {
    e.invalid.push('TG_WEBHOOK_SECRET phải dài 16–256 ký tự, chỉ gồm A-Z a-z 0-9 _ -');
  }
  if (cfg.bridgeKey && cfg.bridgeKey.length < 24) e.invalid.push('BRIDGE_KEY phải dài tối thiểu 24 ký tự');
  if (cfg.ownerChatId && !allowed.includes(cfg.ownerChatId)) e.invalid.push('TG_OWNER_CHAT_ID phải nằm trong TG_ALLOWED_CHAT_IDS');
  e.assertOk('bridge');
  return cfg;
}
