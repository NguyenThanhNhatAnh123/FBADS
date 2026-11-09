// SQLite riêng của bridge: update đã nhận, hộp thư cho Claude, lần bấm nút cl:, hàng đợi chuyển Agent, log tool.

import { openDb, nowIso, type DB } from '../shared/sqlite.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS updates (
  update_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- message | callback_query | edited_message | other
  chat_id INTEGER,
  routed_to TEXT,                     -- agent | inbox | buttons | ignored
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  text TEXT,
  file_id TEXT,
  file_kind TEXT,
  file_name TEXT,
  reply_to INTEGER,
  reply_to_text TEXT,
  at TEXT NOT NULL,
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  parse_mode TEXT,
  buttons_json TEXT NOT NULL,
  message_id INTEGER,
  at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS button_presses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  ref TEXT NOT NULL,
  button_id TEXT NOT NULL,
  label TEXT,
  message_id INTEGER,
  at TEXT NOT NULL,
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER,
  endpoint TEXT NOT NULL,             -- /brief | /callback
  payload TEXT NOT NULL,
  fallback_inbox INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  next_at TEXT NOT NULL,
  notified_at TEXT,
  delivered_at TEXT,
  failed_at TEXT
);

CREATE TABLE IF NOT EXISTS bridge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  bytes INTEGER,
  message_id INTEGER,
  error TEXT
);

-- Khoá chống gửi lặp cho send_message (ví dụ cảnh báo thanh toán chạy mỗi giờ, mỗi mốc chỉ báo một lần).
CREATE TABLE IF NOT EXISTS dedupe (
  key TEXT PRIMARY KEY,
  message_id INTEGER,
  at TEXT NOT NULL
);

-- Tin do Claude gửi qua bridge: trả lời vào các tin này thì vào hộp thư Claude, không chuyển Agent.
CREATE TABLE IF NOT EXISTS outgoing (
  message_id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

export interface InboxRow {
  id: number;
  message_id: number;
  chat_id: number;
  text: string | null;
  file_id: string | null;
  file_kind: string | null;
  file_name: string | null;
  reply_to: number | null;
  reply_to_text: string | null;
  at: string;
  handled_at: string | null;
}

export interface ApprovalRow {
  id: number;
  ref: string;
  text: string;
  parse_mode: string | null;
  buttons_json: string;
  message_id: number | null;
  at: string;
  answered_at: string | null;
}

export interface PressRow {
  id: number;
  approval_id: number;
  ref: string;
  button_id: string;
  label: string | null;
  message_id: number | null;
  at: string;
  handled_at: string | null;
}

export interface QueueRow {
  id: number;
  update_id: number | null;
  endpoint: string;
  payload: string;
  fallback_inbox: number;
  tries: number;
  last_error: string | null;
  created_at: string;
  next_at: string;
  notified_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

export class BridgeStore {
  readonly db: DB;

  constructor(file: string) {
    this.db = openDb(file, SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** false nếu update_id đã nhận trước đó (Telegram gửi lại). */
  recordUpdate(updateId: number, kind: string, chatId: number | null): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO updates (update_id, kind, chat_id, at) VALUES (?, ?, ?, ?)`).run(updateId, kind, chatId, nowIso()).changes === 1;
  }

  setRouted(updateId: number, routedTo: string, note?: string): void {
    this.db.prepare(`UPDATE updates SET routed_to=?, note=? WHERE update_id=?`).run(routedTo, note ?? null, updateId);
  }

  // ---- inbox ----
  addInbox(r: Omit<InboxRow, 'id' | 'at' | 'handled_at'>): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO inbox (message_id, chat_id, text, file_id, file_kind, file_name, reply_to, reply_to_text, at)
           VALUES (@message_id, @chat_id, @text, @file_id, @file_kind, @file_name, @reply_to, @reply_to_text, @at)`,
        )
        .run({ ...r, at: nowIso() }).lastInsertRowid,
    );
  }

  listInbox(sinceId: number, limit: number): InboxRow[] {
    return this.db.prepare(`SELECT * FROM inbox WHERE handled_at IS NULL AND id > ? ORDER BY id LIMIT ?`).all(sinceId, limit) as InboxRow[];
  }

  countUnhandledInbox(): number {
    return (this.db.prepare(`SELECT count(*) n FROM inbox WHERE handled_at IS NULL`).get() as { n: number }).n;
  }

  // ---- approvals / presses ----
  addApproval(ref: string, text: string, parseMode: string | null, buttons: Array<{ id: string; label: string }>): number {
    return Number(
      this.db
        .prepare(`INSERT INTO approvals (ref, text, parse_mode, buttons_json, at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref, text, parseMode, JSON.stringify(buttons), nowIso()).lastInsertRowid,
    );
  }

  setApprovalMessage(id: number, messageId: number, parseMode: string | null): void {
    this.db.prepare(`UPDATE approvals SET message_id=?, parse_mode=? WHERE id=?`).run(messageId, parseMode, id);
  }

  getApproval(id: number): ApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id) as ApprovalRow | undefined;
  }

  /** Ghi lần bấm đầu tiên của một tin; trả về null nếu tin đã được trả lời. */
  addPress(a: ApprovalRow, buttonId: string, label: string, messageId: number | null): number | null {
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare(`UPDATE approvals SET answered_at=? WHERE id=? AND answered_at IS NULL`).run(nowIso(), a.id);
      if (upd.changes !== 1) return null;
      return Number(
        this.db
          .prepare(`INSERT INTO button_presses (approval_id, ref, button_id, label, message_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(a.id, a.ref, buttonId, label, messageId, nowIso()).lastInsertRowid,
      );
    });
    return tx();
  }

  listPresses(ref: string | null, sinceId: number): PressRow[] {
    if (ref) return this.db.prepare(`SELECT * FROM button_presses WHERE handled_at IS NULL AND ref=? AND id > ? ORDER BY id`).all(ref, sinceId) as PressRow[];
    return this.db.prepare(`SELECT * FROM button_presses WHERE handled_at IS NULL AND id > ? ORDER BY id`).all(sinceId) as PressRow[];
  }

  countUnhandledPresses(): number {
    return (this.db.prepare(`SELECT count(*) n FROM button_presses WHERE handled_at IS NULL`).get() as { n: number }).n;
  }

  markHandled(inboxIds: number[], pressIds: number[]): number {
    const at = nowIso();
    let n = 0;
    const tx = this.db.transaction(() => {
      const a = this.db.prepare(`UPDATE inbox SET handled_at=? WHERE id=? AND handled_at IS NULL`);
      const b = this.db.prepare(`UPDATE button_presses SET handled_at=? WHERE id=? AND handled_at IS NULL`);
      for (const id of inboxIds) n += a.run(at, id).changes;
      for (const id of pressIds) n += b.run(at, id).changes;
    });
    tx();
    return n;
  }

  // ---- agent queue ----
  enqueueAgent(updateId: number | null, endpoint: string, payload: unknown, fallbackInbox: boolean, at = nowIso()): number {
    return Number(
      this.db
        .prepare(`INSERT INTO agent_queue (update_id, endpoint, payload, fallback_inbox, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(updateId, endpoint, JSON.stringify(payload), fallbackInbox ? 1 : 0, at, at).lastInsertRowid,
    );
  }

  /** Mục cũ nhất chưa chuyển xong (giữ đúng thứ tự). */
  headOfQueue(): QueueRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_queue WHERE delivered_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT 1`).get() as QueueRow | undefined;
  }

  updateQueue(id: number, patch: Partial<Omit<QueueRow, 'id'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE agent_queue SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@__id`).run({ ...patch, __id: id });
  }

  pendingQueueCount(): number {
    return (this.db.prepare(`SELECT count(*) n FROM agent_queue WHERE delivered_at IS NULL AND failed_at IS NULL`).get() as { n: number }).n;
  }

  // ---- log + outgoing ----
  log(tool: string, bytes: number, messageId: number | null, error?: string): void {
    this.db.prepare(`INSERT INTO bridge_log (at, tool, bytes, message_id, error) VALUES (?, ?, ?, ?, ?)`).run(nowIso(), tool, bytes, messageId, error ?? null);
  }

  addOutgoing(messageIds: number[], tool: string): void {
    const st = this.db.prepare(`INSERT OR IGNORE INTO outgoing (message_id, tool, at) VALUES (?, ?, ?)`);
    for (const id of messageIds) st.run(id, tool, nowIso());
  }

  /** Tin cùng khoá đã gửi trong `hours` giờ gần đây → trả về dòng đó. */
  findDedupe(key: string, hours: number): { message_id: number | null; at: string } | undefined {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return this.db.prepare(`SELECT message_id, at FROM dedupe WHERE key=? AND at >= ?`).get(key, since) as { message_id: number | null; at: string } | undefined;
  }

  saveDedupe(key: string, messageId: number): void {
    this.db.prepare(`INSERT INTO dedupe (key, message_id, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET message_id=excluded.message_id, at=excluded.at`).run(key, messageId, nowIso());
  }

  isClaudeMessage(messageId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM outgoing WHERE message_id=?`).get(messageId);
  }
}
