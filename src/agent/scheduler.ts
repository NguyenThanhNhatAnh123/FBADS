// Việc định kỳ của Agent:
// - Brief chưa duyệt sau 24 giờ → nhắc một lần; sau 72 giờ → tự huỷ, xoá object PAUSED.
// - Brief chờ xác nhận / chọn camp quá 72 giờ → huỷ (chưa có gì trên Meta).
// - Sao lưu SQLite mỗi ngày (thư mục data/backups, và Drive nếu có DRIVE_BACKUP_FOLDER_ID).

import fs from 'node:fs';
import path from 'node:path';
import type { Deps, RequestContext } from './pipeline/types.ts';
import { cancel } from './approval.ts';
import { escapeHtml } from '../shared/telegram.ts';
import { calendarDate, TZ_VN } from '../shared/time.ts';
import { logger } from '../shared/log.ts';

const log = logger('scheduler');

export async function approvalSweep(deps: Deps, now = new Date()): Promise<void> {
  const { store, cfg, tg } = deps;
  const H = 3600_000;
  for (const r of store.listRequestsByStatus(['pending_approval', 'editing'])) {
    if (!r.approval_sent_at) continue;
    const age = now.getTime() - new Date(r.approval_sent_at).getTime();
    if (age >= cfg.limits.autoCancelAfterH * H) {
      log.info(`Brief #${r.id} quá ${cfg.limits.autoCancelAfterH}h chưa duyệt → tự huỷ`);
      await cancel(deps, r.id, 'timeout').catch((e) => log.error(`Tự huỷ brief #${r.id} lỗi`, e));
    } else if (age >= cfg.limits.remindAfterH * H && !r.reminded_at) {
      store.updateRequest(r.id, { reminded_at: now.toISOString() });
      const ctx = store.getContext<RequestContext>(r.id);
      await tg
        .sendMessage(
          r.chat_id!,
          `⏰ Brief #${r.id} (${escapeHtml(ctx.campaign?.name ?? '')}) chờ duyệt đã ${Math.floor(age / H)} giờ. ` +
            `Sau ${cfg.limits.autoCancelAfterH} giờ Agent sẽ tự huỷ và xoá các object PAUSED.`,
          { parse_mode: 'HTML', reply_to_message_id: r.approval_message_id ?? undefined },
        )
        .catch((e) => log.warn('Gửi nhắc duyệt lỗi', e));
    }
  }
  for (const r of store.listRequestsByStatus(['waiting'])) {
    const ctx = store.getContext<RequestContext>(r.id);
    if (ctx.waitingReason !== 'confirm' && ctx.waitingReason !== 'campaign_choice') continue;
    if (now.getTime() - new Date(r.updated_at).getTime() >= cfg.limits.autoCancelAfterH * H) {
      await cancel(deps, r.id, 'system', 'quá hạn chờ xác nhận').catch((e) => log.error(`Huỷ brief #${r.id} lỗi`, e));
    }
  }
}

export async function backupDb(deps: Deps, now = new Date()): Promise<string> {
  const { store, cfg } = deps;
  const { y, m, d } = calendarDate(TZ_VN, now);
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const file = path.join(cfg.backupDir, `agent-${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}.db`);
  await store.db.backup(file);
  // Giữ 14 bản gần nhất trên máy.
  const all = fs.readdirSync(cfg.backupDir).filter((f) => /^agent-\d{8}\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(cfg.backupDir, old), { force: true });
  if (cfg.driveBackupFolderId && deps.drive.uploadBackup) {
    try {
      await deps.drive.uploadBackup(file, cfg.driveBackupFolderId);
    } catch (err) {
      log.warn('Đẩy bản sao lưu lên Drive lỗi (thư mục phải nằm trong Shared Drive)', err);
    }
  }
  return file;
}

export function startScheduler(deps: Deps): () => void {
  let lastBackupDay = '';
  const tick = async () => {
    try {
      await approvalSweep(deps);
      const { y, m, d } = calendarDate(TZ_VN);
      const hourVn = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ_VN, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
      const day = `${y}-${m}-${d}`;
      if (hourVn >= 3 && lastBackupDay !== day) {
        lastBackupDay = day;
        const f = await backupDb(deps);
        log.info(`Đã sao lưu DB: ${f}`);
      }
    } catch (err) {
      log.error('Việc định kỳ lỗi', err);
    }
  };
  const timer = setInterval(tick, 10 * 60_000);
  void tick();
  return () => clearInterval(timer);
}
