// Giới hạn an toàn (sửa được trong .env):
// - Budget/ngày một brief > $300 → bắt buộc bấm xác nhận lần 2 trước khi tạo.
// - Tổng budget/ngày các camp Agent đang quản lý > $1.500 → từ chối brief mới.
// - Mức cap < $5 hoặc > $150 → hỏi lại (nhiều khả năng gõ nhầm).
// - Brief giống hệt một brief trong 10 phút → hỏi lại.

import type { AgentConfig } from './config.ts';
import type { AgentStore, RequestRow } from './db.ts';
import type { MetaAds } from './meta/ads.ts';
import type { NewBrief } from './brief/parse.ts';
import { briefFingerprint } from './brief/parse.ts';

export interface SafetyVerdict {
  reject: string | null; // lý do từ chối hẳn
  confirm: string[]; // lý do cần xác nhận lần 2
}

/** Tổng daily_budget (USD) các campaign Agent tạo, đang chạy hoặc đang chờ duyệt. */
export async function managedDailyBudgetUsd(store: AgentStore, meta: MetaAds, accountName: string, excludeRequestId?: number): Promise<number> {
  const rows = store.managedCampaigns(accountName).filter((r) => r.request_id !== excludeRequestId);
  if (!rows.length) return 0;
  const live = await meta.campaignBudgets(rows.map((r) => r.meta_id));
  let cents = 0;
  for (const r of rows) {
    const info = live[r.meta_id];
    if (!info) continue;
    const st = info.effective_status ?? '';
    const counting = st === 'ACTIVE' || st === 'IN_PROCESS' || st === 'WITH_ISSUES' || ['pending_approval', 'created', 'activating', 'editing'].includes(r.request_status);
    if (counting && !['DELETED', 'ARCHIVED'].includes(st)) cents += Number(info.daily_budget ?? 0);
  }
  return cents / 100;
}

export async function checkNewBrief(
  cfg: AgentConfig,
  store: AgentStore,
  meta: MetaAds,
  brief: NewBrief,
  req: RequestRow,
): Promise<SafetyVerdict> {
  const L = cfg.limits;
  const confirm: string[] = [];

  const current = await managedDailyBudgetUsd(store, meta, brief.account, req.id);
  if (current + brief.budgetUsd > L.totalBudgetUsd) {
    return {
      reject: `Tổng budget/ngày các camp Agent đang quản lý trên ${brief.account} là $${fmt(current)}; thêm $${fmt(brief.budgetUsd)} sẽ vượt giới hạn $${fmt(L.totalBudgetUsd)}. Brief bị từ chối.`,
      confirm,
    };
  }
  if (brief.budgetUsd > L.budgetConfirmUsd) confirm.push(`Budget $${fmt(brief.budgetUsd)}/ngày lớn hơn $${fmt(L.budgetConfirmUsd)}`);
  if (brief.capUsd !== null && (brief.capUsd < L.capMinUsd || brief.capUsd > L.capMaxUsd)) {
    confirm.push(`Mức cap $${fmt(brief.capUsd)} nằm ngoài khung $${fmt(L.capMinUsd)}–$${fmt(L.capMaxUsd)} — có gõ nhầm không?`);
  }
  const dup = findDuplicate(cfg, store, req);
  if (dup) confirm.push(`Brief này giống brief #${dup.id} gửi lúc ${dup.created_at.slice(11, 16)} UTC`);
  return { reject: null, confirm };
}

export function findDuplicate(cfg: AgentConfig, store: AgentStore, req: RequestRow): RequestRow | null {
  const since = new Date(Date.now() - cfg.limits.duplicateWindowMin * 60_000).toISOString();
  const fp = briefFingerprint(req.raw_text);
  return store.recentRequests(since).find((r) => r.id !== req.id && r.status !== 'failed' && briefFingerprint(r.raw_text) === fp) ?? null;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
