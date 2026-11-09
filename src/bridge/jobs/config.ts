// Cấu hình chế độ BRIEF_HANDLER=claude: bridge tự xử lý brief bằng `claude -p` (Claude Code headless)
// dùng các connector claude.ai sẵn có (Facebook Ads, Shopify, Google Drive) — không cần token Meta / Shopify /
// Google / Anthropic trên server. Chỉ cần máy đã đăng nhập Claude Code bằng tài khoản có các connector đó.

import path from 'node:path';
import type { EnvReader } from '../../shared/env.ts';

export interface JobAccount {
  name: string; // H3
  adAccountId: string; // số, không có act_
  pageId: string;
  pageName: string;
  pixelId: string;
  pixelName: string;
  timezone: string; // America/Dawson
  currency: string;
  shopDomain: string; // firstnationslegacy.com
  namePrefix: string; // Dân
}

export interface JobLimits {
  budgetConfirmUsd: number;
  totalBudgetUsd: number;
  capMinUsd: number;
  capMaxUsd: number;
  maxFiles: number;
  duplicateWindowMin: number;
  remindAfterH: number;
  autoCancelAfterH: number;
}

export interface ClaudeJobsConfig {
  bin: string; // CLAUDE_BIN (đường dẫn claude.exe)
  binArgs: string[]; // chỉ dùng cho test (chạy claude giả bằng node)
  model: string; // '' = model mặc định của tài khoản
  effort: string; // '' = mặc định
  timeoutMin: number;
  maxTurnsCreate: number;
  maxTurnsOther: number;
  runDir: string;
  callbackSecret: string;
  account: JobAccount;
  limits: JobLimits;
  /** CLAUDE_DRY_RUN=1: chạy thử, lượt claude chỉ có tool ĐỌC (Meta / Shopify / Drive); không tạo / sửa / bật gì trên Meta. */
  dryRun?: boolean;
}

export function defaultAccount(): JobAccount {
  return {
    name: 'H3',
    adAccountId: '25496622559924808',
    pageId: '101065259399535',
    pageName: 'Native Heritage Store',
    pixelId: '625569536048355',
    pixelName: 'Native Pixel',
    timezone: 'America/Dawson',
    currency: 'USD',
    shopDomain: 'firstnationslegacy.com',
    namePrefix: 'Dân',
  };
}

export function defaultLimits(): JobLimits {
  return {
    budgetConfirmUsd: 300,
    totalBudgetUsd: 1500,
    capMinUsd: 5,
    capMaxUsd: 150,
    maxFiles: 10,
    duplicateWindowMin: 10,
    remindAfterH: 24,
    autoCancelAfterH: 72,
  };
}

export function loadJobsConfig(e: EnvReader, callbackSecret: string): ClaudeJobsConfig {
  const acc = defaultAccount();
  const lim = defaultLimits();
  const cfg: ClaudeJobsConfig = {
    bin: e.opt('CLAUDE_BIN', 'claude'),
    binArgs: [],
    model: e.opt('CLAUDE_RUN_MODEL'),
    effort: e.opt('CLAUDE_RUN_EFFORT'),
    timeoutMin: e.num('CLAUDE_RUN_TIMEOUT_MIN', 40),
    maxTurnsCreate: e.num('CLAUDE_RUN_MAX_TURNS', 250),
    maxTurnsOther: e.num('CLAUDE_RUN_MAX_TURNS_OTHER', 100),
    runDir: path.resolve(e.opt('CLAUDE_RUN_DIR', 'data/claude-runs')),
    dryRun: e.bool('CLAUDE_DRY_RUN', false),
    callbackSecret,
    account: {
      name: e.opt('ACCOUNT_NAME', acc.name),
      adAccountId: e.opt('META_AD_ACCOUNT', acc.adAccountId).replace(/^act_/, ''),
      pageId: e.opt('META_PAGE_ID', acc.pageId),
      pageName: e.opt('META_PAGE_NAME', acc.pageName),
      pixelId: e.opt('META_PIXEL_ID', acc.pixelId),
      pixelName: e.opt('META_PIXEL_NAME', acc.pixelName),
      timezone: e.opt('ACCOUNT_TIMEZONE', acc.timezone),
      currency: e.opt('ACCOUNT_CURRENCY', acc.currency),
      shopDomain: e.opt('SHOP_PUBLIC_DOMAIN', acc.shopDomain),
      namePrefix: e.opt('NAME_PREFIX', acc.namePrefix),
    },
    limits: {
      budgetConfirmUsd: e.num('LIMIT_BUDGET_CONFIRM_USD', lim.budgetConfirmUsd),
      totalBudgetUsd: e.num('LIMIT_TOTAL_BUDGET_USD', lim.totalBudgetUsd),
      capMinUsd: e.num('LIMIT_CAP_MIN_USD', lim.capMinUsd),
      capMaxUsd: e.num('LIMIT_CAP_MAX_USD', lim.capMaxUsd),
      maxFiles: e.num('LIMIT_MAX_FILES', lim.maxFiles),
      duplicateWindowMin: e.num('DUPLICATE_WINDOW_MIN', lim.duplicateWindowMin),
      remindAfterH: e.num('APPROVAL_REMIND_AFTER_H', lim.remindAfterH),
      autoCancelAfterH: e.num('APPROVAL_AUTO_CANCEL_AFTER_H', lim.autoCancelAfterH),
    },
  };
  if (!/^\d{6,}$/.test(cfg.account.adAccountId)) e.invalid.push(`META_AD_ACCOUNT=${cfg.account.adAccountId} (cần số tài khoản quảng cáo)`);
  return cfg;
}
