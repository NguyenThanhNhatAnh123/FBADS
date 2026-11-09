import fs from 'node:fs';
import { EnvReader } from '../shared/env.ts';

export interface AgentConfig {
  port: number;
  bridgeKey: string;
  callbackSecret: string;
  dbFile: string;
  tmpDir: string;
  backupDir: string;
  driveBackupFolderId: string;

  tgBotToken: string;
  tgAllowedChatIds: number[];

  meta: {
    token: string;
    apiVersion: string;
    graphBase: string;
    videoBase: string;
    adAccount: string; // act_...
    pixelId: string;
    pageId: string;
    advantageAudience: 0 | 1;
  };

  account: {
    name: string; // H3
    pixelName: string;
    pageName: string;
    timezone: string;
    currency: string;
  };

  shopify: {
    domain: string; // xxx.myshopify.com
    publicDomain: string; // firstnationslegacy.com
    token: string;
    clientId: string;
    clientSecret: string;
    apiVersion: string;
  };

  google: {
    serviceAccountJson: string; // đường dẫn file hoặc JSON
    roasSheetId: string;
  };

  claude: {
    apiKey: string;
    model: string;
    fallbacks: boolean;
  };

  naming: { ownerPrefix: string };

  limits: {
    budgetConfirmUsd: number;
    totalBudgetUsd: number;
    capMinUsd: number;
    capMaxUsd: number;
    maxFilesPerBrief: number;
    duplicateWindowMin: number;
    remindAfterH: number;
    autoCancelAfterH: number;
  };
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const e = new EnvReader(env);
  const apiVersion = e.opt('META_API_VERSION', 'v26.0');
  let adAccount = e.str('META_AD_ACCOUNT');
  if (adAccount && !adAccount.startsWith('act_')) adAccount = `act_${adAccount}`;
  const bridgeKey = e.str('BRIDGE_KEY');

  const shopToken = e.opt('SHOPIFY_TOKEN');
  const shopClientId = e.opt('SHOPIFY_CLIENT_ID');
  const shopClientSecret = e.opt('SHOPIFY_CLIENT_SECRET');
  if (!shopToken && !(shopClientId && shopClientSecret)) {
    e.missing.push('SHOPIFY_TOKEN (hoặc SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)');
  }

  const cfg: AgentConfig = {
    port: e.num('AGENT_PORT', 8788),
    bridgeKey,
    callbackSecret: e.opt('CALLBACK_SECRET', bridgeKey),
    dbFile: e.opt('AGENT_DB', 'data/agent.db'),
    tmpDir: e.opt('AGENT_TMP_DIR', 'tmp'),
    backupDir: e.opt('AGENT_BACKUP_DIR', 'data/backups'),
    driveBackupFolderId: e.opt('DRIVE_BACKUP_FOLDER_ID'),

    tgBotToken: e.str('TG_BOT_TOKEN'),
    tgAllowedChatIds: e.list('TG_ALLOWED_CHAT_IDS').map(Number).filter(Number.isFinite),

    meta: {
      token: e.str('META_TOKEN'),
      apiVersion,
      graphBase: e.opt('META_GRAPH_BASE', 'https://graph.facebook.com'),
      videoBase: e.opt('META_GRAPH_VIDEO_BASE', 'https://graph-video.facebook.com'),
      adAccount,
      pixelId: e.str('META_PIXEL_ID'),
      pageId: e.str('META_PAGE_ID'),
      advantageAudience: e.bool('META_ADVANTAGE_AUDIENCE', true) ? 1 : 0,
    },

    account: {
      name: e.opt('ACCOUNT_NAME', 'H3'),
      pixelName: e.opt('META_PIXEL_NAME', 'Native Pixel'),
      pageName: e.opt('META_PAGE_NAME', 'Native Heritage Store'),
      timezone: e.opt('ACCOUNT_TIMEZONE', 'America/Dawson'),
      currency: e.opt('ACCOUNT_CURRENCY', 'USD'),
    },

    shopify: {
      domain: e.str('SHOPIFY_DOMAIN'),
      publicDomain: e.opt('SHOP_PUBLIC_DOMAIN', 'firstnationslegacy.com'),
      token: shopToken,
      clientId: shopClientId,
      clientSecret: shopClientSecret,
      apiVersion: e.opt('SHOPIFY_API_VERSION', '2026-10'),
    },

    google: {
      serviceAccountJson: e.str('GOOGLE_SA_JSON'),
      roasSheetId: e.opt('ROAS_SHEET_ID'),
    },

    claude: {
      apiKey: e.str('ANTHROPIC_API_KEY'),
      model: e.opt('CLAUDE_MODEL', 'claude-sonnet-5-5'),
      fallbacks: e.bool('CLAUDE_FALLBACKS', true),
    },

    naming: { ownerPrefix: e.opt('NAME_PREFIX', 'Dân') },

    limits: {
      budgetConfirmUsd: e.num('LIMIT_BUDGET_CONFIRM_USD', 300),
      totalBudgetUsd: e.num('LIMIT_TOTAL_BUDGET_USD', 1500),
      capMinUsd: e.num('LIMIT_CAP_MIN_USD', 5),
      capMaxUsd: e.num('LIMIT_CAP_MAX_USD', 150),
      maxFilesPerBrief: e.num('LIMIT_MAX_FILES', 10),
      duplicateWindowMin: e.num('DUPLICATE_WINDOW_MIN', 10),
      remindAfterH: e.num('APPROVAL_REMIND_AFTER_H', 24),
      autoCancelAfterH: e.num('APPROVAL_AUTO_CANCEL_AFTER_H', 72),
    },
  };

  if (bridgeKey && bridgeKey.length < 24) e.invalid.push('BRIDGE_KEY phải dài tối thiểu 24 ký tự');
  if (cfg.google.serviceAccountJson && !cfg.google.serviceAccountJson.trim().startsWith('{') && !fs.existsSync(cfg.google.serviceAccountJson)) {
    e.invalid.push(`GOOGLE_SA_JSON: không thấy file ${cfg.google.serviceAccountJson}`);
  }
  e.assertOk('agent');
  return cfg;
}
