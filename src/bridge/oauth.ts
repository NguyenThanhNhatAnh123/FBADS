// OAuth for the single-owner bridge. Registration is public; authorization
// requires the owner's existing MCP_TOKEN. Credentials never enter URLs/logs.
import express from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthClientMetadataSchema, type OAuthClientInformationFull, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { DB } from '../shared/sqlite.ts';
import type { BridgeConfig } from './config.ts';
import { logger } from '../shared/log.ts';

const log = logger('oauth');
const CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);
// Explicit trust policy also prevents CIMD fetches from reaching private networks.
const CIMD_URLS = new Set(['claude.ai', 'claude.com'].flatMap(host =>
  ['/oauth/mcp-oauth-client-metadata', '/api/oauth/mcp-oauth-client-metadata'].map(path => `https://${host}${path}`)));
const now = () => Math.floor(Date.now() / 1000);
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const html = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Grant = { clientId: string; scopes: string[]; resource: string; grantId: string };
type Pending = { client: OAuthClientInformationFull; params: AuthorizationParams; attempts: number };
type Code = Grant & { challenge: string; redirectUri: string };

export class BridgeOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: string;
  readonly issuer: URL;
  private readonly db: DB;
  private readonly ownerToken: string;
  private readonly fetchMetadata: typeof fetch;

  constructor(db: DB, cfg: Pick<BridgeConfig, 'publicUrl' | 'mcpToken'>, fetchMetadata: typeof fetch = fetch) {
    this.db = db;
    this.ownerToken = cfg.mcpToken;
    this.fetchMetadata = fetchMetadata;
    this.issuer = new URL(cfg.publicUrl);
    if (this.issuer.protocol !== 'https:' || this.issuer.pathname !== '/' || this.issuer.search || this.issuer.hash || this.issuer.username || this.issuer.password) {
      throw new Error('OAuth requires BRIDGE_PUBLIC_URL to be an HTTPS origin');
    }
    this.resource = new URL('/mcp', this.issuer).href;
    db.exec(`CREATE TABLE IF NOT EXISTS oauth_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER,
      PRIMARY KEY(kind, id)
    ); CREATE INDEX IF NOT EXISTS oauth_records_expiry ON oauth_records(expires);`);
    this.clientsStore = {
      getClient: id => this.getClient(id),
      registerClient: client => {
        this.validateClient(client);
        const count = db.prepare("SELECT COUNT(*) AS n FROM oauth_records WHERE kind='client'").get() as { n: number };
        if (count.n >= 1000) throw new InvalidClientMetadataError('Client registration capacity reached');
        const info: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: now() };
        this.put('client', info.client_id, info);
        log.info('Client registered', { clientId: info.client_id, redirectUris: info.redirect_uris, authMethod: info.token_endpoint_auth_method });
        return info;
      },
    };
  }

  private put(kind: string, id: string, data: unknown, expires: number | null = null): void {
    this.db.prepare('DELETE FROM oauth_records WHERE expires IS NOT NULL AND expires<=?').run(now());
    this.db.prepare('INSERT OR REPLACE INTO oauth_records(kind,id,data,expires) VALUES(?,?,?,?)').run(kind, id, JSON.stringify(data), expires);
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM oauth_records WHERE kind=? AND id=? AND (expires IS NULL OR expires>?)').get(kind, id, now()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  private remove(kind: string, id: string): void {
    this.db.prepare('DELETE FROM oauth_records WHERE kind=? AND id=?').run(kind, id);
  }
  private validateClient(client: Pick<OAuthClientInformationFull, 'redirect_uris' | 'token_endpoint_auth_method' | 'grant_types' | 'response_types'>): void {
    if (!client.redirect_uris.length || client.redirect_uris.length > 2 || client.redirect_uris.some(uri => !CALLBACKS.has(uri))) {
      log.warn('Client registration rejected: redirect_uri must be an exact Claude callback');
      throw new InvalidClientMetadataError('Only the HTTPS claude.ai / claude.com MCP callback is allowed');
    }
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(client.token_endpoint_auth_method ?? 'client_secret_post')) {
      throw new InvalidClientMetadataError('Unsupported token_endpoint_auth_method');
    }
    if ((client.response_types && (!client.response_types.includes('code') || client.response_types.some(type => type !== 'code'))) ||
      (client.grant_types && (!client.grant_types.includes('authorization_code') || client.grant_types.some(type => !['authorization_code', 'refresh_token'].includes(type))))) {
      throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported');
    }
  }
  private async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
    if (id.length > 2048) return undefined;
    const stored = this.get<OAuthClientInformationFull>('client', id) ?? this.get<OAuthClientInformationFull>('cimd', id);
    if (stored || !CIMD_URLS.has(id)) return stored;
    try {
      const response = await this.fetchMetadata(id, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error('Metadata endpoint did not return JSON');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 32768) throw new Error('Metadata too large');
        chunks.push(Buffer.from(chunk));
      }
      const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (document.client_id !== id || typeof document.client_name !== 'string' || !document.client_name.length) throw new Error('Metadata client_id/name mismatch');
      const metadata = OAuthClientMetadataSchema.parse(document);
      // Metadata may list other grant types. This server only handles code/refresh.
      const supported = (metadata.grant_types ?? ['authorization_code']).filter(g => ['authorization_code', 'refresh_token'].includes(g));
      if (!supported.includes('authorization_code') || metadata.token_endpoint_auth_method !== 'none') throw new Error('Unsupported CIMD client');
      const client: OAuthClientInformationFull = { ...metadata, grant_types: supported, client_id: id };
      this.validateClient(client);
      const cacheControl = response.headers.get('cache-control') ?? '';
      const ttl = /no-store|no-cache/i.test(cacheControl) ? 0 : Math.min(300, Number(/max-age=(\d+)/i.exec(cacheControl)?.[1] ?? 300));
      if (ttl > 0) this.put('cimd', id, client, now() + ttl);
      log.info('CIMD client resolved', { clientId: id });
      return client;
    } catch {
      log.warn('CIMD metadata fetch/validation failed', { clientId: id });
      return undefined;
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response): Promise<void> {
    if (params.resource && params.resource.href !== this.resource) throw new InvalidTargetError('Resource must match this MCP server');
    if (params.scopes?.some(scope => scope !== 'mcp')) throw new InvalidScopeError('Only mcp scope is supported');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('A valid S256 PKCE challenge is required');
    const pending = secret();
    this.put('pending', hash(pending), { client, params, attempts: 0 }, now() + 600);
    // no-referrer also makes browser form POSTs send Origin:null. Send only the
    // origin (never the authorization query) so same-origin consent can pass.
    res.set({ 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'origin', 'X-Content-Type-Options': 'nosniff' });
    res.type('html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kết nối ADS</title>
      <h1>Cho phép Claude kết nối ADS</h1><p>Ứng dụng: ${html(client.client_name ?? 'Claude')}</p>
      <p>Quyền: đọc hộp thư và sử dụng các công cụ Telegram của ADS.</p>
      <p>Nhập MCP_TOKEN từ file .env.bridge trên máy chạy ADS để xác nhận. Chỉ nhập trên ${html(this.issuer.origin)}.</p>
      <form method="post" action="/oauth/approve"><input type="hidden" name="request" value="${pending}">
      <label>Mã kết nối MCP <input type="password" name="owner_token" required autocomplete="off" maxlength="512"></label>
      <button name="decision" value="approve">Cho phép</button><button name="decision" value="deny" formnovalidate>Huỷ</button></form></html>`);
  }

  approve(req: express.Request, res: express.Response): void {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (req.header('origin') !== this.issuer.origin) {
      log.warn('Consent origin rejected', { origin: req.header('origin') ?? '(missing)' });
      res.status(403).json({ error: 'access_denied', error_description: 'Consent must be submitted from the ADS authorization page; reconnect from Claude' }); return;
    }
    const id = typeof req.body?.request === 'string' ? hash(req.body.request) : '';
    const pending = this.get<Pending>('pending', id);
    if (!pending) { res.status(400).json({ error: 'invalid_request', error_description: 'Authorization request expired; reconnect from Claude' }); return; }
    const target = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined) target.searchParams.set('state', pending.params.state);
    if (req.body.decision === 'deny') {
      this.remove('pending', id);
      target.searchParams.set('error', 'access_denied');
      res.redirect(303, target.href); return;
    }
    if (req.body.decision !== 'approve' || typeof req.body.owner_token !== 'string' || !equal(req.body.owner_token, this.ownerToken)) {
      pending.attempts++;
      if (pending.attempts >= 5) this.remove('pending', id);
      else this.db.prepare("UPDATE oauth_records SET data=? WHERE kind='pending' AND id=?").run(JSON.stringify(pending), id);
      log.warn('Owner authorization rejected');
      res.status(403).json({ error: 'access_denied', error_description: 'Incorrect MCP token; reconnect from Claude to retry' }); return;
    }
    const code = secret();
    this.db.transaction(() => {
      this.remove('pending', id);
      this.put('code', hash(code), { clientId: pending.client.client_id, scopes: ['mcp'], resource: this.resource, grantId: randomUUID(), challenge: pending.params.codeChallenge, redirectUri: pending.params.redirectUri } satisfies Code, now() + 300);
    })();
    target.searchParams.set('code', code);
    target.searchParams.set('iss', this.issuer.href);
    log.info('Owner authorized client', { clientId: pending.client.client_id });
    res.redirect(303, target.href);
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const grant = this.get<Code>('code', hash(code));
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return grant.challenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    return this.db.transaction(() => {
      const grant = this.get<Code>('code', hash(code));
      if (!grant || grant.clientId !== client.client_id || grant.redirectUri !== redirectUri) throw new InvalidGrantError('Invalid authorization code or redirect_uri');
      if (resource && resource.href !== grant.resource) throw new InvalidTargetError('Resource does not match authorization');
      this.remove('code', hash(code));
      return this.issue(grant);
    })();
  }
  private issue(grant: Grant): OAuthTokens {
    const access = secret(), refresh = secret();
    const data: Grant = { clientId: grant.clientId, scopes: grant.scopes, resource: grant.resource, grantId: grant.grantId };
    this.put('access', hash(access), data, now() + 3600);
    this.put('refresh', hash(refresh), data, now() + 30 * 86400);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: grant.scopes.join(' ') };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const replay = this.get<Grant>('refresh_used', hash(token));
    if (replay?.clientId === client.client_id) {
      this.revokeGrant(replay);
      log.warn('Refresh token reuse detected; grant revoked', { clientId: client.client_id });
      throw new InvalidGrantError('Refresh token was already used; reconnect from Claude');
    }
    return this.db.transaction(() => {
      const grant = this.get<Grant>('refresh', hash(token));
      if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token');
      if (scopes?.some(scope => !grant.scopes.includes(scope))) throw new InvalidScopeError('Cannot expand scopes');
      if (resource && resource.href !== grant.resource) throw new InvalidTargetError('Resource does not match authorization');
      this.remove('refresh', hash(token));
      this.put('refresh_used', hash(token), grant, now() + 30 * 86400);
      return this.issue({ ...grant, scopes: scopes ?? grant.scopes });
    })();
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db.prepare("SELECT data,expires FROM oauth_records WHERE kind='access' AND id=? AND expires>?").get(hash(token), now()) as { data: string; expires: number } | undefined;
    if (!row) throw new InvalidTokenError('Invalid or expired token');
    const grant = JSON.parse(row.data) as Grant;
    if (grant.resource !== this.resource || !grant.scopes.includes('mcp')) throw new InvalidTokenError('Token audience/scope mismatch');
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: row.expires, resource: new URL(grant.resource) };
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const grant = this.get<Grant>('access', hash(request.token)) ?? this.get<Grant>('refresh', hash(request.token));
    if (grant?.clientId === client.client_id) {
      this.revokeGrant(grant);
    }
  }
  private revokeGrant(grant: Grant): void {
    this.db.prepare("DELETE FROM oauth_records WHERE kind IN ('access','refresh') AND json_extract(data,'$.grantId')=? AND json_extract(data,'$.clientId')=?").run(grant.grantId, grant.clientId);
  }
}

export function mountOAuth(app: express.Express, cfg: BridgeConfig, db: DB): BridgeOAuth | undefined {
  if (!cfg.publicUrl) return undefined;
  const provider = new BridgeOAuth(db, cfg);
  const paths = ['/authorize', '/register', '/token', '/revoke', '/oauth/approve', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
  app.use(paths, (req, res, next) => {
    const start = Date.now(), requestId = randomUUID();
    let error: string | undefined;
    let fields: string[] | undefined;
    const json = res.json.bind(res);
    res.json = body => {
      if (typeof body?.error === 'string') error = body.error;
      // SDK validation details can contain submitted data: log field names only.
      if (error === 'invalid_client_metadata' && typeof body?.error_description === 'string') {
        try { fields = JSON.parse(body.error_description).map((issue: { path?: string[] }) => issue.path?.join('.')); } catch { /* provider logs its fixed rejection reason */ }
      }
      return json(body);
    };
    res.set('X-Request-ID', requestId);
    const path = req.baseUrl + (req.path === '/' ? '' : req.path);
    res.on('finish', () => log.info('OAuth request', { requestId, method: req.method, path, status: res.statusCode, error, fields, ms: Date.now() - start, source: req.header('cf-connecting-ip') ?? req.socket.remoteAddress, userAgent: req.header('user-agent')?.slice(0, 180) }));
    next();
  });
  const metadata = { ...createOAuthMetadata({ provider, issuerUrl: provider.issuer, scopesSupported: ['mcp'] }), client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'] };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }).json(metadata));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }).json({ resource: provider.resource, authorization_servers: [provider.issuer.href], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'ADS Telegram Bridge' }));
  app.post('/register', express.json({ limit: '16kb' }), (req, _res, next) => {
    if (req.body && typeof req.body === 'object' && !req.body.token_endpoint_auth_method) req.body.token_endpoint_auth_method = 'client_secret_post';
    next();
  });
  app.use(['/token', '/revoke'], express.urlencoded({ extended: false, limit: '16kb' }), (req, res, next) => {
    const authorization = req.header('authorization');
    if (authorization?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon < 0 || req.body.client_id || req.body.client_secret) throw new Error('Conflicting client credentials');
        req.body.client_id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
        req.body.client_secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
      } catch { res.status(400).json({ error: 'invalid_client' }); return; }
    }
    next();
  });
  app.post('/oauth/approve', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => provider.approve(req, res));
  // Tunnel requests share a loopback connection. Use an aggregate limit rather
  // than trusting arbitrary forwarded IP headers; suitable for this owner-only bridge.
  const rateLimit = { validate: { xForwardedForHeader: false } };
  app.use(mcpAuthRouter({ provider, issuerUrl: provider.issuer, resourceServerUrl: new URL(provider.resource), scopesSupported: ['mcp'], clientRegistrationOptions: { rateLimit }, authorizationOptions: { rateLimit }, tokenOptions: { rateLimit }, revocationOptions: { rateLimit } }));
  app.use(paths, (error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_request', error_description: 'Malformed or oversized request' });
  });
  return provider;
}
