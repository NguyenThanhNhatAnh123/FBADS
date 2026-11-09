// Google Drive bằng service account: đọc file / thư mục creative, tải về thư mục tạm,
// và (tuỳ chọn) đẩy bản sao lưu SQLite lên Drive mỗi ngày.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { drive as driveApi, auth as gauth, type drive_v3 } from '@googleapis/drive';
import type { DriveRef } from './brief/parse.ts';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  kind: 'video' | 'image' | 'other';
}

export class DriveAccessError extends Error {
  readonly fileId: string;
  constructor(fileId: string, msg: string) {
    super(msg);
    this.fileId = fileId;
  }
}

export interface DriveService {
  readonly serviceAccountEmail: string;
  /** File → [file]; thư mục → các file video/ảnh sắp theo tên. */
  listCreatives(ref: DriveRef): Promise<DriveFile[]>;
  download(file: DriveFile, destDir: string): Promise<string>;
  uploadBackup?(filePath: string, folderId: string): Promise<string>;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export function kindOf(mime: string, name: string): DriveFile['kind'] {
  if (mime.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(name)) return 'video';
  if (mime.startsWith('image/') || /\.(jpe?g|png)$/i.test(name)) return 'image';
  return 'other';
}

export class GoogleDrive implements DriveService {
  readonly serviceAccountEmail: string;
  private readonly client: drive_v3.Drive;

  constructor(serviceAccountJson: string) {
    const raw = serviceAccountJson.trim().startsWith('{') ? serviceAccountJson : fs.readFileSync(serviceAccountJson, 'utf8');
    const creds = JSON.parse(raw) as { client_email: string; private_key: string };
    this.serviceAccountEmail = creds.client_email;
    const authClient = new gauth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    });
    this.client = driveApi({ version: 'v3', auth: authClient });
  }

  private async meta(fileId: string): Promise<drive_v3.Schema$File> {
    try {
      const r = await this.client.files.get({
        fileId,
        fields: 'id,name,mimeType,size,trashed,shortcutDetails',
        supportsAllDrives: true,
      });
      return r.data;
    } catch (err) {
      throw this.wrap(err, fileId);
    }
  }

  private wrap(err: unknown, fileId: string): Error {
    const code = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    if (code === 404 || code === 403 || code === 401) {
      return new DriveAccessError(fileId, `Không truy cập được Drive (${code})`);
    }
    return err as Error;
  }

  async listCreatives(ref: DriveRef): Promise<DriveFile[]> {
    let m = await this.meta(ref.id);
    if (m.mimeType === SHORTCUT_MIME && m.shortcutDetails?.targetId) m = await this.meta(m.shortcutDetails.targetId);
    if (m.trashed) throw new DriveAccessError(ref.id, 'File/thư mục đã nằm trong thùng rác');
    if (m.mimeType !== FOLDER_MIME) return [toFile(m)];

    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const r = await this.client.files.list({
          q: `'${m.id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id,name,mimeType,size,shortcutDetails)',
          orderBy: 'name',
          pageSize: 200,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const f of r.data.files ?? []) {
          let file = f;
          if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId) file = await this.meta(f.shortcutDetails.targetId);
          const df = toFile(file);
          if (df.kind !== 'other') out.push(df);
        }
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      throw this.wrap(err, ref.id);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  async download(file: DriveFile, destDir: string): Promise<string> {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${file.id}${path.extname(file.name) || ''}`);
    try {
      const r = await this.client.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
      await pipeline(r.data as unknown as Readable, fs.createWriteStream(dest));
    } catch (err) {
      throw this.wrap(err, file.id);
    }
    return dest;
  }

  /**
   * Lưu ý: service account không có dung lượng riêng trên My Drive — thư mục đích phải nằm trong
   * Shared Drive (Drive dùng chung) mà service account là thành viên, nếu không Drive báo storageQuotaExceeded.
   */
  async uploadBackup(filePath: string, folderId: string): Promise<string> {
    const r = await this.client.files.create({
      requestBody: { name: path.basename(filePath), parents: [folderId] },
      media: { mimeType: 'application/x-sqlite3', body: fs.createReadStream(filePath) },
      fields: 'id',
      supportsAllDrives: true,
    });
    return r.data.id ?? '';
  }
}

function toFile(m: drive_v3.Schema$File): DriveFile {
  const mime = m.mimeType ?? '';
  const name = m.name ?? m.id ?? 'file';
  return { id: m.id!, name, mimeType: mime, size: m.size ? Number(m.size) : null, kind: kindOf(mime, name) };
}
