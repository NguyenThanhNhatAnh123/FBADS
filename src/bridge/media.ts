import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { drive as driveApi, auth as gauth } from '@googleapis/drive';
import type { DB } from '../shared/sqlite.ts';
import { logger } from '../shared/log.ts';

const log = logger('media');
const run = promisify(execFile);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const VIDEO_MAX_BYTES = 1_000_000_000;
export const IMAGE_MAX_BYTES = 30_000_000;
const EXT: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'image/jpeg': '.jpg', 'image/png': '.png' };
export interface MediaConfig { publicUrl: string; dir: string; serviceAccountJson: string; ffprobePath: string; maxCacheBytes: number }
export class MediaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface SourceFile { fileName: string; mimeType: string; size: number | null; stream: Readable }
export interface MediaSource { readonly email?: string; open(fileId: string): Promise<SourceFile> }
export interface StagedFile {
  url: string; expires_at: string; file_name: string; mime_type: string; size_bytes: number;
  kind: 'video' | 'image'; width: number; height: number; duration_sec?: number;
}
type CachedFile = Omit<StagedFile, 'url' | 'expires_at'> & { token_hash: string; cache_name: string; file_id: string; expires: number; created: number };

/** No arbitrary URL input and no private-address redirects. Public requests carry no credentials. */
export class PublicDriveSource implements MediaSource {
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) { this.request = request; }
  async open(fileId: string): Promise<SourceFile> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new MediaError('not_found', 'ID file Drive không hợp lệ.');
    let url = new URL('https://drive.usercontent.google.com/download');
    url.search = new URLSearchParams({ id: fileId, export: 'download', confirm: 't' }).toString();
    for (let redirects = 0; redirects < 6; redirects++) {
      let response: Response;
      try { response = await this.request(url, { redirect: 'manual', signal: AbortSignal.timeout(20 * 60_000) }); }
      catch { throw new MediaError('download_failed', 'Không tải được file công khai từ Drive.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) break;
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || next.port || !(/(^|\.)googleusercontent\.com$/.test(next.hostname) || ['drive.google.com', 'drive.usercontent.google.com'].includes(next.hostname))) {
          throw new MediaError('download_failed', 'Drive chuyển hướng tới địa chỉ không được phép.');
        }
        url = next; continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MediaError(response.status === 404 ? 'not_found' : [401, 403].includes(response.status) ? 'no_access' : 'download_failed', `Drive không cho tải file (HTTP ${response.status}).`);
      }
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
      if (mime === 'text/html' || !response.body) {
        await response.body?.cancel();
        throw new MediaError('no_access', 'Drive trả trang HTML thay cho media. Mở quyền Bất kỳ ai có đường liên kết – Người xem hoặc cấu hình service account.');
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let name = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)?.slice(1).find(Boolean) ?? fileId;
      if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* use plain filename */ } }
      const rawSize = response.headers.get('content-length');
      const size = rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : null;
      return { fileName: name, mimeType: mime, size, stream: Readable.fromWeb(response.body) };
    }
    throw new MediaError('download_failed', 'Drive chuyển hướng quá nhiều lần.');
  }
}

class ServiceAccountSource implements MediaSource {
  readonly email: string;
  private readonly client;
  constructor(json: string) {
    const creds = JSON.parse(json.trim().startsWith('{') ? json : fs.readFileSync(json, 'utf8')) as { client_email: string; private_key: string };
    if (!creds.client_email || !creds.private_key) throw new MediaError('invalid_config', 'File service account thiếu client_email hoặc private_key.');
    this.email = creds.client_email;
    this.client = driveApi({ version: 'v3', auth: new gauth.JWT({ email: this.email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }) });
  }
  async open(fileId: string): Promise<SourceFile> {
    try {
      const { data: meta } = await this.client.files.get({ fileId, fields: 'name,mimeType,size,trashed', supportsAllDrives: true }, { timeout: 30_000 });
      if (meta.trashed) throw new MediaError('not_found', 'File đã nằm trong thùng rác.');
      if (!EXT[meta.mimeType ?? '']) throw new MediaError('unsupported_type', 'Chỉ hỗ trợ MP4, MOV, JPG và PNG.');
      const max = meta.mimeType!.startsWith('image/') ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
      if (Number(meta.size) > max) throw new MediaError('too_large', 'Video tối đa 1 GB; ảnh tối đa 30 MB.');
      const response = await this.client.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream', timeout: 20 * 60_000 });
      return { fileName: meta.name ?? fileId, mimeType: meta.mimeType!, size: meta.size ? Number(meta.size) : null, stream: response.data as unknown as Readable };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      const status = Number((error as { code?: number }).code);
      throw new MediaError(status === 404 ? 'not_found' : [401, 403].includes(status) ? 'no_access' : 'download_failed', 'Service account không tải được file. Kiểm tra quyền Viewer trên thư mục creative.');
    }
  }
}

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(bytes.subarray(4, 8).toString('ascii'))) return bytes.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  return null;
}

export class StagedMedia {
  readonly serviceAccountEmail: string | null;
  private readonly cfg: MediaConfig;
  private readonly db: DB;
  private readonly publicSource: MediaSource;
  private readonly privateSource?: MediaSource;
  private timer?: NodeJS.Timeout;
  private active = 0;
  private readonly activeFiles = new Set<string>();
  constructor(cfg: MediaConfig, db: DB, sources: { public?: MediaSource; private?: MediaSource } = {}) {
    this.cfg = { ...cfg, dir: path.resolve(cfg.dir) };
    this.db = db;
    this.publicSource = sources.public ?? new PublicDriveSource();
    this.privateSource = sources.private ?? (cfg.serviceAccountJson ? new ServiceAccountSource(cfg.serviceAccountJson) : undefined);
    this.serviceAccountEmail = this.privateSource?.email ?? null;
    db.exec(`CREATE TABLE IF NOT EXISTS staged_media (token_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS staged_media_expiry ON staged_media(expires);`);
  }
  start(): void {
    void this.cleanup().catch(() => log.warn('Media cleanup failed'));
    this.timer = setInterval(() => { void this.cleanup().catch(() => log.warn('Media cleanup failed')); }, 60_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }
  filePath(name: string): string {
    if (!/^[a-f0-9-]{36}\.(part|mp4|mov|jpg|png)$/.test(name)) throw new MediaError('not_found', 'File cache không hợp lệ.');
    const target = path.resolve(this.cfg.dir, name);
    if (path.dirname(target) !== this.cfg.dir) throw new MediaError('not_found', 'File cache không hợp lệ.');
    return target;
  }
  lookup(token: string): CachedFile | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare('SELECT data FROM staged_media WHERE token_hash=?').get(digest(token)) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as CachedFile : undefined;
  }
  async cleanup(): Promise<void> {
    const expired = this.db.prepare('SELECT token_hash,data FROM staged_media WHERE expires<=?').all(Date.now()) as Array<{ token_hash: string; data: string }>;
    for (const row of expired) {
      const file = JSON.parse(row.data) as CachedFile;
      await fsp.rm(this.filePath(file.cache_name), { force: true });
      this.db.prepare('DELETE FROM staged_media WHERE token_hash=?').run(row.token_hash);
    }
    // Remove abandoned downloads only from this cache directory; never recurse.
    const entries = await fsp.readdir(this.cfg.dir, { withFileTypes: true }).catch(() => []);
    const live = new Set((this.db.prepare('SELECT data FROM staged_media').all() as Array<{ data: string }>).map(r => (JSON.parse(r.data) as CachedFile).cache_name));
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.(part|mp4|mov|jpg|png)$/.test(entry.name) || live.has(entry.name) || this.activeFiles.has(entry.name)) continue;
      const full = this.filePath(entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 3600_000) await fsp.rm(full, { force: true });
    }
  }
  async stage(fileId: string, ttlHours = 6): Promise<StagedFile> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new MediaError('not_found', 'ID file Drive không hợp lệ.');
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24) throw new MediaError('invalid_ttl', 'ttl_hours phải lớn hơn 0 và tối đa 24.');
    let origin: URL;
    try { origin = new URL(this.cfg.publicUrl); if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') throw new Error(); }
    catch { throw new MediaError('not_configured', 'Cần BRIDGE_PUBLIC_URL là HTTPS origin để phục vụ media.'); }
    if (this.active >= 2) throw new MediaError('busy', 'Đang tải hai file khác; vui lòng thử lại sau.');
    this.active++;
    let temporary: string | undefined, finalName: string | undefined, source: SourceFile | undefined;
    try {
      await this.cleanup();
      const cachedBytes = (this.db.prepare("SELECT COALESCE(SUM(json_extract(data,'$.size_bytes')),0) AS n FROM staged_media").get() as { n: number }).n;
      if (cachedBytes + this.active * VIDEO_MAX_BYTES > this.cfg.maxCacheBytes) throw new MediaError('cache_full', 'Cache media đã đầy; chờ link cũ hết hạn rồi thử lại.');
      try { source = await (this.privateSource ?? this.publicSource).open(fileId); }
      catch (error) {
        if (!this.privateSource || !(error instanceof MediaError) || !['not_found', 'no_access'].includes(error.code)) throw error;
        source = await this.publicSource.open(fileId);
      }
      if (source.mimeType && !EXT[source.mimeType] && source.mimeType !== 'application/octet-stream') throw new MediaError('unsupported_type', 'Chỉ hỗ trợ MP4, MOV, JPG và PNG.');
      let maximum = source.mimeType.startsWith('image/') ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
      if (source.size !== null && (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > maximum)) throw new MediaError('too_large', 'Video tối đa 1 GB; ảnh tối đa 30 MB.');
      await fsp.mkdir(this.cfg.dir, { recursive: true });
      temporary = randomUUID() + '.part'; this.activeFiles.add(temporary);
      let bytes = 0, prefix = Buffer.alloc(0), detected: string | null = null;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
        if (prefix.length >= 12 && !detected) {
          detected = sniff(prefix);
          if (!detected) { done(new MediaError('unsupported_type', 'Nội dung tải về không phải MP4, MOV, JPG hoặc PNG.')); return; }
          if (detected.startsWith('image/')) maximum = IMAGE_MAX_BYTES;
        }
        done(bytes > maximum ? new MediaError('too_large', 'Video tối đa 1 GB; ảnh tối đa 30 MB.') : null, chunk);
      } });
      await pipeline(source.stream, guard, fs.createWriteStream(this.filePath(temporary), { flags: 'wx' }));
      detected = sniff(prefix);
      if (!bytes || !detected) throw new MediaError('unsupported_type', 'File không phải media được hỗ trợ.');
      if (source.size !== null && bytes !== source.size) throw new MediaError('download_failed', 'File tải xuống thiếu hoặc sai kích thước.');
      const kind = detected.startsWith('image/') ? 'image' : 'video';
      if (EXT[source.mimeType] && source.mimeType.startsWith('image/') !== detected.startsWith('image/')) throw new MediaError('unsupported_type', 'Loại file không khớp nội dung media.');
      const { stdout } = await run(this.cfg.ffprobePath || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_streams', '-show_format', this.filePath(temporary)], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } }>; format?: { duration?: string; format_name?: string } };
      const video = probe.streams?.find(s => s.codec_type === 'video');
      if (!video?.width || !video.height || (kind === 'video' && !/mov|mp4/.test(probe.format?.format_name ?? ''))) throw new MediaError('unsupported_type', 'ffprobe không xác nhận được định dạng hoặc kích thước file.');
      const rotation = Math.abs(Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180;
      const [width, height] = rotation === 90 ? [video.height, video.width] : [video.width, video.height];
      const duration = Number(probe.format?.duration ?? video.duration);
      if (kind === 'video' && (!Number.isFinite(duration) || duration <= 0)) throw new MediaError('unsupported_type', 'Không đọc được thời lượng video.');
      const token = randomBytes(32).toString('base64url');
      const expires = Date.now() + ttlHours * 3600_000;
      const extension = EXT[detected];
      let name = path.basename(source.fileName.replace(/\\/g, '/')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160).replace(/[\uD800-\uDFFF]/gu, '_');
      const originalExt = path.extname(name).toLowerCase();
      if (originalExt && !['.mp4', '.mov', '.png', '.jpg', '.jpeg'].includes(originalExt)) throw new MediaError('unsupported_type', 'Tên file phải có đuôi MP4, MOV, JPG hoặc PNG.');
      if (!originalExt) name += extension;
      if (kind === 'image' && originalExt && !(detected === 'image/png' ? originalExt === '.png' : ['.jpg', '.jpeg'].includes(originalExt))) throw new MediaError('unsupported_type', 'Đuôi ảnh không khớp nội dung file.');
      if (kind === 'video' && originalExt && !['.mp4', '.mov'].includes(originalExt)) throw new MediaError('unsupported_type', 'Đuôi video không hợp lệ.');
      if (originalExt === '.mov' && kind === 'video') detected = 'video/quicktime';
      finalName = randomUUID() + EXT[detected]; this.activeFiles.add(finalName);
      await fsp.rename(this.filePath(temporary), this.filePath(finalName));
      const row: CachedFile = { token_hash: digest(token), cache_name: finalName, file_id: fileId, expires, created: Date.now(), file_name: name, mime_type: detected, size_bytes: bytes, kind, width, height, ...(kind === 'video' ? { duration_sec: duration } : {}) };
      this.db.prepare('INSERT INTO staged_media(token_hash,data,expires) VALUES(?,?,?)').run(row.token_hash, JSON.stringify(row), expires);
      log.info('Drive media staged', { file_id: fileId, size_bytes: bytes, kind, expires_at: new Date(expires).toISOString() });
      return { url: new URL(`/media/${token}/${encodeURIComponent(name)}`, origin).href, expires_at: new Date(expires).toISOString(), file_name: name, mime_type: detected, size_bytes: bytes, kind, width, height, ...(kind === 'video' ? { duration_sec: duration } : {}) };
    } catch (error) {
      source?.stream.destroy();
      if (finalName) await fsp.rm(this.filePath(finalName), { force: true }).catch(() => {});
      const failure = error instanceof MediaError ? error : new MediaError('download_failed', 'Không tải hoặc kiểm tra được media. Kiểm tra Drive, ffprobe và dung lượng cache.');
      log.warn('Drive media stage failed', { file_id: fileId, error: failure.code });
      throw failure;
    } finally {
      this.active--;
      if (temporary) { await fsp.rm(this.filePath(temporary), { force: true }).catch(() => {}); this.activeFiles.delete(temporary); }
      if (finalName) this.activeFiles.delete(finalName);
    }
  }
}

export function mountMedia(app: express.Express, media: StagedMedia): void {
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nAllow: /media/\nDisallow: /\n'));
  app.get(['/media/:token/:filename', '/media/:token'], (req, res) => {
    const row = media.lookup(String(req.params.token));
    if (!row || req.params.filename !== row.file_name) { res.status(404).end(); return; }
    if (row.expires <= Date.now()) { res.status(410).end(); return; }
    res.set({ 'Content-Type': row.mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}` });
    res.sendFile(media.filePath(row.cache_name), { acceptRanges: true, cacheControl: false }, error => {
      if (error && !res.headersSent) res.status((error as { status?: number }).status ?? 404).end();
    });
  });
}
