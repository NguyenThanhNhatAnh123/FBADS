import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/** Mở file SQLite ở chế độ WAL, tạo thư mục nếu chưa có. `:memory:` dùng cho test. */
export function openDb(file: string, schema: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
