// Lưu trữ của Agent: một file SQLite. Mỗi brief = một dòng `requests`; mọi object Meta,
// bài Page, phương án copy, file creative và hành động đều được ghi lại để chạy tiếp được
// sau khi server khởi động lại mà không tạo trùng.

import { openDb, nowIso, type DB } from '../shared/sqlite.ts';
import type { AgentConfig } from './config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY,
  ad_account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT,
  pixel_id TEXT NOT NULL,
  pixel_name TEXT,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL,
  shop_domain TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- NEW | ADD
  raw_text TEXT NOT NULL,
  parsed_json TEXT,
  account TEXT,
  status TEXT NOT NULL,               -- received → validated → media_ready → copy_ready → created → pending_approval → active / cancelled / failed (+ waiting, editing, activating)
  step TEXT,                          -- bước kế tiếp cần chạy
  error TEXT,
  product_key TEXT,                   -- handle sản phẩm, để Giai đoạn 3 nối với bảng ROAS
  chat_id INTEGER,
  brief_message_id INTEGER,
  approval_message_id INTEGER,
  approval_version INTEGER NOT NULL DEFAULT 0,
  approval_sent_at TEXT,
  reminded_at TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- video | image
  mime TEXT,
  width INTEGER,
  height INTEGER,
  ratio TEXT,                         -- 9:16 | 4:5 | 1:1 | khác (w:h)
  duration_s REAL,
  bytes INTEGER,
  sha256 TEXT,                        -- khoá nhận diện file (dùng cho posts.media_id)
  local_path TEXT,
  meta_video_id TEXT,
  image_hash TEXT,
  thumbnail_url TEXT,
  warning TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_req ON media(request_id);

CREATE TABLE IF NOT EXISTS copy_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  variant INTEGER NOT NULL,           -- 1, 2, 3
  version INTEGER NOT NULL DEFAULT 1, -- tăng mỗi lần "Sửa copy"
  style TEXT NOT NULL,
  headline TEXT NOT NULL,
  primary_text TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,
  variant_key TEXT NOT NULL,          -- hash nội dung copy + link (posts.variant_id)
  chosen INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copy_req ON copy_variants(request_id);

CREATE TABLE IF NOT EXISTS posts (
  post_id TEXT PRIMARY KEY,           -- {page_id}_{post_id}
  media_id TEXT NOT NULL,             -- media.sha256
  variant_id TEXT NOT NULL,           -- copy_variants.variant_key
  creative_id TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  product_handle TEXT,
  first_request_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (media_id, variant_id)
);

CREATE TABLE IF NOT EXISTS meta_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  level TEXT NOT NULL,                -- campaign | adset | creative | ad
  meta_id TEXT NOT NULL,
  name TEXT,
  post_id TEXT,
  variant INTEGER,
  media_row_id INTEGER,
  creative_id TEXT,
  owned INTEGER NOT NULL DEFAULT 1,   -- 1 = do brief này tạo; 0 = object có sẵn (camp/adset đang chạy của #ADD)
  status TEXT NOT NULL,               -- paused | active | deleted | error
  preview_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_req ON meta_objects(request_id);
CREATE INDEX IF NOT EXISTS idx_meta_id ON meta_objects(meta_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                -- agent | owner | system | unknown
  action TEXT NOT NULL,
  request_id INTEGER,
  target_meta_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS callback_uses (
  data TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

-- update_id Telegram đã xử lý (bridge có thể gửi lại khi hết thời gian chờ) — không xử lý hai lần.
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id INTEGER PRIMARY KEY,
  at TEXT NOT NULL
);
`;

// ---- Kiểu dòng ----
export type RequestStatus =
  | 'received'
  | 'validated'
  | 'waiting'
  | 'media_ready'
  | 'copy_ready'
  | 'created'
  | 'pending_approval'
  | 'editing'
  | 'activating'
  | 'active'
  | 'cancelled'
  | 'failed';

export const TERMINAL: RequestStatus[] = ['active', 'cancelled', 'failed'];

export interface RequestRow {
  id: number;
  type: 'NEW' | 'ADD';
  raw_text: string;
  parsed_json: string | null;
  account: string | null;
  status: RequestStatus;
  step: string | null;
  error: string | null;
  product_key: string | null;
  chat_id: number | null;
  brief_message_id: number | null;
  approval_message_id: number | null;
  approval_version: number;
  approval_sent_at: string | null;
  reminded_at: string | null;
  context_json: string;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  name: string;
  ad_account_id: string;
  page_id: string;
  page_name: string | null;
  pixel_id: string;
  pixel_name: string | null;
  timezone: string;
  currency: string;
  shop_domain: string | null;
  active: number;
}

export interface MediaRow {
  id: number;
  request_id: number;
  drive_file_id: string;
  name: string;
  kind: 'video' | 'image';
  mime: string | null;
  width: number | null;
  height: number | null;
  ratio: string | null;
  duration_s: number | null;
  bytes: number | null;
  sha256: string | null;
  local_path: string | null;
  meta_video_id: string | null;
  image_hash: string | null;
  thumbnail_url: string | null;
  warning: string | null;
}

export interface CopyVariantRow {
  id: number;
  request_id: number;
  variant: number;
  version: number;
  style: string;
  headline: string;
  primary_text: string;
  description: string;
  reason: string | null;
  variant_key: string;
  chosen: number;
  active: number;
}

export interface PostRow {
  post_id: string;
  media_id: string;
  variant_id: string;
  creative_id: string;
  ad_account_id: string;
  product_handle: string | null;
  first_request_id: number | null;
}

export interface MetaObjectRow {
  id: number;
  request_id: number;
  level: 'campaign' | 'adset' | 'creative' | 'ad';
  meta_id: string;
  name: string | null;
  post_id: string | null;
  variant: number | null;
  media_row_id: number | null;
  creative_id: string | null;
  owned: number;
  status: 'paused' | 'active' | 'deleted' | 'error';
  preview_json: string | null;
}

export class AgentStore {
  readonly db: DB;

  constructor(file: string) {
    this.db = openDb(file, SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- accounts ----
  upsertAccountFromConfig(cfg: AgentConfig): void {
    this.db
      .prepare(
        `INSERT INTO accounts (name, ad_account_id, page_id, page_name, pixel_id, pixel_name, timezone, currency, shop_domain, active, updated_at)
         VALUES (@name, @ad, @page, @pageName, @pixel, @pixelName, @tz, @cur, @shop, 1, @at)
         ON CONFLICT(name) DO UPDATE SET ad_account_id=@ad, page_id=@page, page_name=@pageName, pixel_id=@pixel,
           pixel_name=@pixelName, timezone=@tz, currency=@cur, shop_domain=@shop, updated_at=@at`,
      )
      .run({
        name: cfg.account.name,
        ad: cfg.meta.adAccount,
        page: cfg.meta.pageId,
        pageName: cfg.account.pageName,
        pixel: cfg.meta.pixelId,
        pixelName: cfg.account.pixelName,
        tz: cfg.account.timezone,
        cur: cfg.account.currency,
        shop: cfg.shopify.publicDomain,
        at: nowIso(),
      });
  }

  getAccount(name: string): AccountRow | undefined {
    return this.db.prepare(`SELECT * FROM accounts WHERE upper(name)=upper(?) AND active=1`).get(name) as AccountRow | undefined;
  }

  listAccountNames(): string[] {
    return (this.db.prepare(`SELECT name FROM accounts WHERE active=1 ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  }

  // ---- requests ----
  createRequest(r: { type: 'NEW' | 'ADD'; raw_text: string; chat_id: number; brief_message_id?: number }): RequestRow {
    const at = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO requests (type, raw_text, status, step, chat_id, brief_message_id, created_at, updated_at)
         VALUES (?, ?, 'received', NULL, ?, ?, ?, ?)`,
      )
      .run(r.type, r.raw_text, r.chat_id, r.brief_message_id ?? null, at, at);
    return this.getRequest(Number(info.lastInsertRowid))!;
  }

  getRequest(id: number): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE id=?`).get(id) as RequestRow | undefined;
  }

  updateRequest(id: number, patch: Partial<Omit<RequestRow, 'id' | 'created_at'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k}=@${k}`).join(', ');
    this.db.prepare(`UPDATE requests SET ${sets}, updated_at=@__at WHERE id=@__id`).run({ ...patch, __at: nowIso(), __id: id });
  }

  getContext<T extends object = Record<string, unknown>>(id: number): T {
    const row = this.getRequest(id);
    return row ? (JSON.parse(row.context_json || '{}') as T) : ({} as T);
  }

  /** Gộp thêm trường vào context_json (ghi đè từng khoá). */
  patchContext(id: number, patch: Record<string, unknown>): void {
    const tx = this.db.transaction(() => {
      const ctx = this.getContext<Record<string, unknown>>(id);
      Object.assign(ctx, patch);
      this.db.prepare(`UPDATE requests SET context_json=?, updated_at=? WHERE id=?`).run(JSON.stringify(ctx), nowIso(), id);
    });
    tx();
  }

  listRequestsByStatus(statuses: RequestStatus[]): RequestRow[] {
    const qs = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM requests WHERE status IN (${qs}) ORDER BY id`).all(...statuses) as RequestRow[];
  }

  recentRequests(sinceIso: string): RequestRow[] {
    return this.db.prepare(`SELECT * FROM requests WHERE created_at >= ? ORDER BY id DESC`).all(sinceIso) as RequestRow[];
  }

  findRequestByApprovalMessage(messageId: number): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE approval_message_id=?`).get(messageId) as RequestRow | undefined;
  }

  findRequestByContextMessage(key: string, messageId: number): RequestRow | undefined {
    return this.db
      .prepare(`SELECT * FROM requests WHERE json_extract(context_json, '$.' || ?) = ? ORDER BY id DESC LIMIT 1`)
      .get(key, messageId) as RequestRow | undefined;
  }

  // ---- media ----
  insertMedia(m: Omit<MediaRow, 'id' | 'meta_video_id' | 'image_hash' | 'thumbnail_url'>): MediaRow {
    const info = this.db
      .prepare(
        `INSERT INTO media (request_id, drive_file_id, name, kind, mime, width, height, ratio, duration_s, bytes, sha256, local_path, warning, created_at)
         VALUES (@request_id, @drive_file_id, @name, @kind, @mime, @width, @height, @ratio, @duration_s, @bytes, @sha256, @local_path, @warning, @at)`,
      )
      .run({ ...m, at: nowIso() });
    return this.db.prepare(`SELECT * FROM media WHERE id=?`).get(info.lastInsertRowid) as MediaRow;
  }

  listMedia(requestId: number): MediaRow[] {
    return this.db.prepare(`SELECT * FROM media WHERE request_id=? ORDER BY id`).all(requestId) as MediaRow[];
  }

  deleteMediaOfRequest(requestId: number): void {
    this.db.prepare(`DELETE FROM media WHERE request_id=?`).run(requestId);
  }

  updateMedia(id: number, patch: Partial<MediaRow>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE media SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@__id`).run({ ...patch, __id: id });
  }

  /** Media cùng nội dung đã tải lên cùng ad account ở brief trước → dùng lại video_id / image_hash. */
  findUploadedMedia(sha256: string, adAccount: string): MediaRow | undefined {
    return this.db
      .prepare(
        `SELECT m.* FROM media m JOIN requests r ON r.id=m.request_id JOIN accounts a ON upper(a.name)=upper(r.account)
         WHERE m.sha256=? AND a.ad_account_id=? AND (m.meta_video_id IS NOT NULL OR m.image_hash IS NOT NULL)
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(sha256, adAccount) as MediaRow | undefined;
  }

  // ---- copy variants ----
  insertVariants(
    requestId: number,
    version: number,
    rows: Array<{ variant: number; style: string; headline: string; primary_text: string; description: string; reason: string; variant_key: string }>,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE copy_variants SET active=0 WHERE request_id=?`).run(requestId);
      const st = this.db.prepare(
        `INSERT INTO copy_variants (request_id, variant, version, style, headline, primary_text, description, reason, variant_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) st.run(requestId, r.variant, version, r.style, r.headline, r.primary_text, r.description, r.reason, r.variant_key, nowIso());
    });
    tx();
  }

  activeVariants(requestId: number): CopyVariantRow[] {
    return this.db.prepare(`SELECT * FROM copy_variants WHERE request_id=? AND active=1 ORDER BY variant`).all(requestId) as CopyVariantRow[];
  }

  maxVariantVersion(requestId: number): number {
    const r = this.db.prepare(`SELECT max(version) v FROM copy_variants WHERE request_id=?`).get(requestId) as { v: number | null };
    return r.v ?? 0;
  }

  markChosen(requestId: number, variants: number[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE copy_variants SET chosen=0 WHERE request_id=? AND active=1`).run(requestId);
      const st = this.db.prepare(`UPDATE copy_variants SET chosen=1 WHERE request_id=? AND active=1 AND variant=?`);
      for (const v of variants) st.run(requestId, v);
    });
    tx();
  }

  // ---- posts ----
  findPost(mediaKey: string, variantKey: string): PostRow | undefined {
    return this.db.prepare(`SELECT * FROM posts WHERE media_id=? AND variant_id=?`).get(mediaKey, variantKey) as PostRow | undefined;
  }

  findPostById(postId: string): PostRow | undefined {
    return this.db.prepare(`SELECT * FROM posts WHERE post_id=?`).get(postId) as PostRow | undefined;
  }

  insertPost(p: PostRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO posts (post_id, media_id, variant_id, creative_id, ad_account_id, product_handle, first_request_id, created_at)
         VALUES (@post_id, @media_id, @variant_id, @creative_id, @ad_account_id, @product_handle, @first_request_id, @at)`,
      )
      .run({ ...p, at: nowIso() });
  }

  // ---- meta objects ----
  insertMetaObject(o: {
    request_id: number;
    level: MetaObjectRow['level'];
    meta_id: string;
    name?: string | null;
    post_id?: string | null;
    variant?: number | null;
    media_row_id?: number | null;
    creative_id?: string | null;
    owned?: number;
    status?: MetaObjectRow['status'];
  }): MetaObjectRow {
    const at = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO meta_objects (request_id, level, meta_id, name, post_id, variant, media_row_id, creative_id, owned, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.request_id,
        o.level,
        o.meta_id,
        o.name ?? null,
        o.post_id ?? null,
        o.variant ?? null,
        o.media_row_id ?? null,
        o.creative_id ?? null,
        o.owned ?? 1,
        o.status ?? 'paused',
        at,
        at,
      );
    return this.db.prepare(`SELECT * FROM meta_objects WHERE id=?`).get(info.lastInsertRowid) as MetaObjectRow;
  }

  listMetaObjects(requestId: number, level?: MetaObjectRow['level'], includeDeleted = false): MetaObjectRow[] {
    const conds = ['request_id=?'];
    const args: unknown[] = [requestId];
    if (level) {
      conds.push('level=?');
      args.push(level);
    }
    if (!includeDeleted) conds.push(`status!='deleted'`);
    return this.db.prepare(`SELECT * FROM meta_objects WHERE ${conds.join(' AND ')} ORDER BY id`).all(...args) as MetaObjectRow[];
  }

  updateMetaObject(id: number, patch: Partial<Pick<MetaObjectRow, 'status' | 'preview_json' | 'creative_id' | 'post_id' | 'name'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE meta_objects SET ${keys.map((k) => `${k}=@${k}`).join(', ')}, updated_at=@__at WHERE id=@__id`)
      .run({ ...patch, __at: nowIso(), __id: id });
  }

  /** Các campaign do Agent tạo, chưa xoá — để tính tổng budget đang quản lý. */
  managedCampaigns(adAccountName: string): Array<{ meta_id: string; request_id: number; request_status: RequestStatus }> {
    return this.db
      .prepare(
        `SELECT o.meta_id, o.request_id, r.status AS request_status FROM meta_objects o JOIN requests r ON r.id=o.request_id
         WHERE o.level='campaign' AND o.owned=1 AND o.status!='deleted' AND upper(r.account)=upper(?)`,
      )
      .all(adAccountName) as Array<{ meta_id: string; request_id: number; request_status: RequestStatus }>;
  }

  /** Object Meta có do Agent tạo hay không (Giai đoạn 1 không đụng vào object khác). */
  isOwnedByAgent(metaId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM meta_objects WHERE meta_id=? AND owned=1`).get(metaId);
  }

  // ---- audit + callbacks ----
  audit(actor: string, action: string, opts: { requestId?: number | null; target?: string | null; detail?: unknown } = {}): void {
    this.db
      .prepare(`INSERT INTO audit_log (at, actor, action, request_id, target_meta_id, detail) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        nowIso(),
        actor,
        action,
        opts.requestId ?? null,
        opts.target ?? null,
        opts.detail === undefined ? null : typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail),
      );
  }

  /** true nếu callback_data này chưa dùng (và đánh dấu đã dùng). */
  claimCallback(data: string): boolean {
    const info = this.db.prepare(`INSERT OR IGNORE INTO callback_uses (data, at) VALUES (?, ?)`).run(data, nowIso());
    return info.changes === 1;
  }

  releaseCallback(data: string): void {
    this.db.prepare(`DELETE FROM callback_uses WHERE data=?`).run(data);
  }

  /** true nếu update_id này chưa gặp (và ghi nhận). */
  claimUpdate(updateId: number): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO seen_updates (update_id, at) VALUES (?, ?)`).run(updateId, nowIso()).changes === 1;
  }

  releaseUpdate(updateId: number): void {
    this.db.prepare(`DELETE FROM seen_updates WHERE update_id=?`).run(updateId);
  }
}
