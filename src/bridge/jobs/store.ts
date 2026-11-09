// Bảng của chế độ BRIEF_HANDLER=claude, nằm chung file SQLite của bridge.
//   jobs       — một brief (#NEW / #ADD) và trạng thái duyệt
//   job_runs   — một lượt `claude -p` (create / edit / activate / cancel)
//   job_events — nhật ký mọi hành động (ai làm, làm gì, lúc nào)

import { nowIso, type DB } from '../../shared/sqlite.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                  -- NEW | ADD
  raw_text TEXT NOT NULL,
  brief_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  budget_usd REAL,
  status TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,                    -- payload submit_drafts được chấp nhận gần nhất
  activation_json TEXT,
  status_message_id INTEGER,
  approval_message_id INTEGER,
  approval_text TEXT,
  button_version INTEGER NOT NULL DEFAULT 0,
  edit_prompt_message_id INTEGER,
  approval_sent_at TEXT,
  reminded_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,                  -- create | edit | activate | cancel
  args_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,                -- queued | running | done | failed
  outcome TEXT,                        -- drafts | activated | cancelled | choice | failure | rejected | no_report | timeout | interrupted
  session_id TEXT,
  cost_usd REAL,
  num_turns INTEGER,
  denials_json TEXT,
  error TEXT,
  log_file TEXT,
  audit_json TEXT,                    -- kết quả audit.ts: các lần ghi dữ liệu + bất thường
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- owner | bridge | claude
  action TEXT NOT NULL,
  detail TEXT
);
`;

export type JobStatus =
  | 'confirm' // chờ chủ shop xác nhận lần 2 (budget lớn, cap lạ, brief trùng)
  | 'queued' // chờ lượt create / edit
  | 'running' // lượt create / edit đang chạy
  | 'choosing' // chờ chủ shop chọn campaign (#ADD khớp nhiều camp)
  | 'pending_approval' // tin duyệt đã gửi
  | 'activating' // chờ / đang chạy lượt bật
  | 'active'
  | 'cancelling'
  | 'cancelled'
  | 'failed' // lỗi, /retry được
  | 'rejected'; // brief bị từ chối, không tạo gì

export type RunKind = 'create' | 'edit' | 'activate' | 'cancel';

export const OPEN_STATUSES: JobStatus[] = ['confirm', 'queued', 'running', 'choosing', 'pending_approval', 'activating', 'cancelling'];

export interface JobRow {
  id: number;
  type: 'NEW' | 'ADD';
  raw_text: string;
  brief_json: string | null;
  warnings_json: string;
  budget_usd: number | null;
  status: JobStatus;
  extra_json: string;
  result_json: string | null;
  activation_json: string | null;
  status_message_id: number | null;
  approval_message_id: number | null;
  approval_text: string | null;
  button_version: number;
  edit_prompt_message_id: number | null;
  approval_sent_at: string | null;
  reminded_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: number;
  job_id: number;
  kind: RunKind;
  args_json: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  outcome: string | null;
  session_id: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  denials_json: string | null;
  error: string | null;
  log_file: string | null;
  audit_json: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class JobStore {
  readonly db: DB;

  constructor(db: DB) {
    this.db = db;
    db.exec(SCHEMA);
    // Migration cho DB tạo trước khi có cột audit_json.
    const cols = (db.prepare('PRAGMA table_info(job_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('audit_json')) db.exec('ALTER TABLE job_runs ADD COLUMN audit_json TEXT');
  }

  createJob(r: { type: 'NEW' | 'ADD'; raw_text: string; brief_json: string | null; warnings: string[]; budget_usd: number | null; status: JobStatus; error?: string }): number {
    const at = nowIso();
    return Number(
      this.db
        .prepare(
          `INSERT INTO jobs (type, raw_text, brief_json, warnings_json, budget_usd, status, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.type, r.raw_text, r.brief_json, JSON.stringify(r.warnings), r.budget_usd, r.status, r.error ?? null, at, at).lastInsertRowid,
    );
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
  }

  updateJob(id: number, patch: Partial<Omit<JobRow, 'id' | 'created_at'>>): void {
    const p = { ...patch, updated_at: nowIso() };
    const keys = Object.keys(p);
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@__id`).run({ ...p, __id: id });
  }

  /** Đổi trạng thái nguyên tử: chỉ đổi khi trạng thái hiện tại nằm trong `from` (chống bấm hai lần). */
  transition(id: number, from: JobStatus[], to: JobStatus, patch: Partial<Omit<JobRow, 'id' | 'created_at' | 'status'>> = {}): boolean {
    const p: Record<string, unknown> = { ...patch, status: to, updated_at: nowIso() };
    const keys = Object.keys(p);
    const sql = `UPDATE jobs SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@__id AND status IN (${from.map((_, i) => `@__f${i}`).join(', ')})`;
    const params: Record<string, unknown> = { ...p, __id: id };
    from.forEach((f, i) => (params[`__f${i}`] = f));
    return this.db.prepare(sql).run(params).changes === 1;
  }

  jobsByStatus(statuses: JobStatus[]): JobRow[] {
    if (!statuses.length) return [];
    return this.db.prepare(`SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id`).all(...statuses) as JobRow[];
  }

  recentJobs(sinceIso: string): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE created_at >= ? ORDER BY id DESC`).all(sinceIso) as JobRow[];
  }

  lastJobs(limit: number): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as JobRow[];
  }

  jobByEditPrompt(messageId: number): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE edit_prompt_message_id=? ORDER BY id DESC LIMIT 1`).get(messageId) as JobRow | undefined;
  }

  // ---- runs ----
  queueRun(jobId: number, kind: RunKind, args: Record<string, unknown> = {}): number {
    return Number(
      this.db.prepare(`INSERT INTO job_runs (job_id, kind, args_json, status, queued_at) VALUES (?, ?, ?, 'queued', ?)`).run(jobId, kind, JSON.stringify(args), nowIso()).lastInsertRowid,
    );
  }

  nextQueuedRun(): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM job_runs WHERE status='queued' ORDER BY id LIMIT 1`).get() as RunRow | undefined;
  }

  getRun(id: number): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM job_runs WHERE id=?`).get(id) as RunRow | undefined;
  }

  updateRun(id: number, patch: Partial<Omit<RunRow, 'id' | 'job_id' | 'kind' | 'queued_at'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE job_runs SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@__id`).run({ ...patch, __id: id });
  }

  runsForJob(jobId: number): RunRow[] {
    return this.db.prepare(`SELECT * FROM job_runs WHERE job_id=? ORDER BY id`).all(jobId) as RunRow[];
  }

  runningRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM job_runs WHERE status='running' ORDER BY id`).all() as RunRow[];
  }

  queuedCount(): number {
    return (this.db.prepare(`SELECT count(*) n FROM job_runs WHERE status='queued'`).get() as { n: number }).n;
  }

  // ---- audit ----
  event(jobId: number | null, actor: 'owner' | 'bridge' | 'claude', action: string, detail?: unknown): void {
    this.db
      .prepare(`INSERT INTO job_events (job_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(jobId, nowIso(), actor, action, detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  events(jobId: number): Array<{ at: string; actor: string; action: string; detail: string | null }> {
    return this.db.prepare(`SELECT at, actor, action, detail FROM job_events WHERE job_id=? ORDER BY id`).all(jobId) as Array<{ at: string; actor: string; action: string; detail: string | null }>;
  }
}
