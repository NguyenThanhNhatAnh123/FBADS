// Server khởi động lại giữa chừng → đọc `requests` có trạng thái dở, chạy tiếp từ `step` đã ghi.

import type { AgentStore } from './db.ts';
import type { Runner } from './pipeline/runner.ts';
import { logger } from '../shared/log.ts';

const log = logger('resume');

export function resumeUnfinished(store: AgentStore, runner: Runner): number[] {
  const resumed: number[] = [];
  for (const r of store.listRequestsByStatus(['validated', 'media_ready', 'copy_ready', 'created', 'editing', 'received'])) {
    if (r.status === 'received') {
      store.updateRequest(r.id, { status: 'failed', error: 'Server khởi động lại trước khi đọc xong brief — gửi lại brief' });
      continue;
    }
    if (r.status === 'editing') {
      const ctx = store.getContext<{ editFeedback?: string | null }>(r.id);
      if (!ctx.editFeedback) continue; // đang chờ chủ shop trả lời "Sửa gì?"
    }
    log.info(`Chạy tiếp brief #${r.id} (${r.status}, bước ${r.step})`);
    store.audit('system', 'resume_after_restart', { requestId: r.id, detail: { status: r.status, step: r.step } });
    void runner.enqueue(r.id, { resumed: true });
    resumed.push(r.id);
  }
  // Đang bật dở khi tắt máy → đưa về chờ duyệt để bấm lại.
  for (const r of store.listRequestsByStatus(['activating'])) store.updateRequest(r.id, { status: 'pending_approval' });
  return resumed;
}
