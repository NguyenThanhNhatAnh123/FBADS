// Client Graph API: tham số gửi dạng form (object → JSON), tiền theo cent.
// - Lỗi giới hạn tần suất → chờ theo thời gian Meta trả về rồi thử lại, tối đa 3 lần.
// - Token hết hạn / bị thu hồi (code 190) → MetaTokenError để Agent dừng mọi brief.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/log.ts';
import { sleep } from '../../shared/telegram.ts';

const log = logger('meta');

export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
  is_transient?: boolean;
}

export class MetaApiError extends Error {
  readonly body: MetaErrorBody;
  readonly httpStatus: number;
  readonly method: string;
  readonly pathName: string;
  constructor(method: string, pathName: string, httpStatus: number, body: MetaErrorBody) {
    super(`Meta ${method} ${pathName}: ${body.message ?? 'lỗi không rõ'} (code ${body.code ?? '?'}${body.error_subcode ? '/' + body.error_subcode : ''})`);
    this.body = body;
    this.httpStatus = httpStatus;
    this.method = method;
    this.pathName = pathName;
  }
  get code(): number | undefined {
    return this.body.code;
  }
  /** Câu gửi chủ shop: nguyên văn error.message và error_user_msg như đặc tả yêu cầu. */
  get ownerText(): string {
    const parts = [`error.message: ${this.body.message ?? '—'}`];
    if (this.body.error_user_title) parts.push(`error_user_title: ${this.body.error_user_title}`);
    if (this.body.error_user_msg) parts.push(`error_user_msg: ${this.body.error_user_msg}`);
    parts.push(`code: ${this.body.code ?? '?'}${this.body.error_subcode ? ` / subcode ${this.body.error_subcode}` : ''}`);
    if (this.body.fbtrace_id) parts.push(`fbtrace_id: ${this.body.fbtrace_id}`);
    return parts.join('\n');
  }
}

/** Token hết hạn hoặc bị thu hồi — dừng mọi brief, gửi cảnh báo đỏ. */
export class MetaTokenError extends MetaApiError {}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const RATE_LIMIT_SUBCODES = new Set([2446079, 1487742, 1504022]);

export type Params = Record<string, string | number | boolean | object | null | undefined>;

export interface MetaClientOpts {
  token: string;
  version: string;
  graphBase?: string;
  videoBase?: string;
  maxRateLimitRetries?: number;
  /** Cho test: thay sleep để không phải chờ thật. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class MetaClient {
  private readonly token: string;
  readonly version: string;
  private readonly graphBase: string;
  private readonly videoBase: string;
  private readonly maxRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(o: MetaClientOpts) {
    this.token = o.token;
    this.version = o.version;
    this.graphBase = (o.graphBase ?? 'https://graph.facebook.com').replace(/\/$/, '');
    this.videoBase = (o.videoBase ?? 'https://graph-video.facebook.com').replace(/\/$/, '');
    this.maxRetries = o.maxRateLimitRetries ?? 3;
    this.sleepFn = o.sleepFn ?? sleep;
  }

  get<T = any>(p: string, params: Params = {}): Promise<T> {
    return this.request<T>('GET', p, params);
  }

  post<T = any>(p: string, params: Params = {}): Promise<T> {
    return this.request<T>('POST', p, params);
  }

  delete<T = any>(p: string): Promise<T> {
    return this.request<T>('DELETE', p, {});
  }

  /** Tải file lên (adimages / advideos). `host: 'video'` dùng graph-video.facebook.com. */
  async upload<T = any>(p: string, fileField: string, filePath: string, extra: Params = {}, host: 'graph' | 'video' = 'graph'): Promise<T> {
    return this.withRetry('POST', p, async () => {
      const form = new FormData();
      form.set('access_token', this.token);
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) form.set(k, encodeParam(v));
      form.set(fileField, await fs.openAsBlob(filePath), path.basename(filePath));
      const base = host === 'video' ? this.videoBase : this.graphBase;
      return fetch(`${base}/${this.version}/${p.replace(/^\//, '')}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15 * 60_000),
      });
    });
  }

  private request<T>(method: 'GET' | 'POST' | 'DELETE', p: string, params: Params): Promise<T> {
    return this.withRetry(method, p, () => {
      const url = new URL(`${this.graphBase}/${this.version}/${p.replace(/^\//, '')}`);
      const body = new URLSearchParams();
      body.set('access_token', this.token);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, encodeParam(v));
      if (method === 'GET' || method === 'DELETE') {
        for (const [k, v] of body) url.searchParams.set(k, v);
        return fetch(url, { method, signal: AbortSignal.timeout(60_000) });
      }
      return fetch(url, {
        method,
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(120_000),
      });
    });
  }

  private async withRetry<T>(method: string, p: string, send: () => Promise<Response>): Promise<T> {
    let transientTries = 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await send();
      } catch (err) {
        if (transientTries++ < 2) {
          log.warn(`Lỗi mạng khi gọi ${method} ${p}, thử lại`, err);
          await this.sleepFn(2000 * transientTries);
          continue;
        }
        throw err;
      }
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: { message: `Phản hồi không phải JSON (HTTP ${res.status}): ${text.slice(0, 200)}` } };
      }
      if (res.ok && !json?.error) return json as T;

      const body: MetaErrorBody = json?.error ?? { message: `HTTP ${res.status}` };
      const err = isTokenError(body)
        ? new MetaTokenError(method, p, res.status, body)
        : new MetaApiError(method, p, res.status, body);
      if (err instanceof MetaTokenError) throw err;

      if (isRateLimit(body) && attempt < this.maxRetries) {
        const waitMs = rateLimitWaitMs(res.headers);
        log.warn(`Meta giới hạn tần suất (${body.code}/${body.error_subcode ?? '-'}), chờ ${Math.round(waitMs / 1000)}s rồi thử lại (${attempt + 1}/${this.maxRetries})`);
        await this.sleepFn(waitMs);
        continue;
      }
      if ((body.is_transient || body.code === 1 || body.code === 2 || res.status >= 500) && transientTries++ < 2) {
        log.warn(`Lỗi tạm thời từ Meta (${body.code}), thử lại`, body.message);
        await this.sleepFn(3000 * transientTries);
        continue;
      }
      throw err;
    }
  }
}

function encodeParam(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function isTokenError(b: MetaErrorBody): boolean {
  return b.code === 190 || b.code === 102;
}

export function isRateLimit(b: MetaErrorBody): boolean {
  return (b.code !== undefined && RATE_LIMIT_CODES.has(b.code)) || (b.error_subcode !== undefined && RATE_LIMIT_SUBCODES.has(b.error_subcode));
}

/** Đọc thời gian chờ từ header usage của Meta; mặc định 60s, tối đa 15 phút. */
export function rateLimitWaitMs(h: Headers): number {
  let waitS = 0;
  const buc = h.get('x-business-use-case-usage');
  if (buc) {
    try {
      const obj = JSON.parse(buc) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      for (const arr of Object.values(obj))
        for (const u of arr) waitS = Math.max(waitS, (u.estimated_time_to_regain_access ?? 0) * 60);
    } catch {
      /* bỏ qua header hỏng */
    }
  }
  const acc = h.get('x-ad-account-usage');
  if (acc) {
    try {
      const obj = JSON.parse(acc) as { reset_time_duration?: number };
      waitS = Math.max(waitS, obj.reset_time_duration ?? 0);
    } catch {
      /* bỏ qua */
    }
  }
  const ms = (waitS > 0 ? waitS : 60) * 1000;
  return Math.min(ms, 15 * 60_000);
}
