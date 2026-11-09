import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeStore } from '../src/bridge/db.ts';
import { BridgeOAuth } from '../src/bridge/oauth.ts';
import { buildBridgeApp } from '../src/bridge/server.ts';
import type { BridgeConfig } from '../src/bridge/config.ts';
import { TelegramApi } from '../src/shared/telegram.ts';
import { Outbox, RateLimiter } from '../src/bridge/outbox.ts';
import { AgentForwarder } from '../src/bridge/forwarder.ts';
import type { OAuthMetadata, OAuthClientInformationFull, OAuthTokens, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const ORIGIN = 'https://ads.example.com';
const OWNER_TOKEN = 'owner-secret-'.repeat(4);
const RESOURCE = ORIGIN + '/mcp';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const cfg: BridgeConfig = {
  port: 0, host: '127.0.0.1', publicUrl: ORIGIN, dbFile: ':memory:', tgBotToken: 'TEST',
  tgWebhookSecret: 'w'.repeat(20), tgAllowedChatIds: [1], ownerChatId: 1,
  mcpToken: OWNER_TOKEN, mcpAllowPathToken: false, polling: false, agentPort: 1,
  agentHost: '127.0.0.1', bridgeKey: 'b'.repeat(32), sendPerMinute: 100,
  agentRetryEveryS: 30, agentNotifyAfterMin: 10, agentGiveUpAfterH: 24,
};

async function harness(file = ':memory:') {
  const store = new BridgeStore(file);
  const tg = new TelegramApi('TEST');
  const app = buildBridgeApp({ cfg, store, tg, outbox: new Outbox(tg, 1, new RateLimiter(100)), forwarder: new AgentForwarder(cfg, store, async () => {}) });
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    request: (url: string, init?: RequestInit) => fetch(base + url, { redirect: 'manual', ...init }),
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); },
  };
}
const form = (values: Record<string, string>, origin?: string): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: new URLSearchParams(values),
});
const registration = (extra = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }) });

test('OAuth discovery and DCR: exact Claude callbacks, useful failures, no credentials from registration', async () => {
  const h = await harness();
  try {
    const metadata = await (await h.request('/.well-known/oauth-authorization-server')).json() as OAuthMetadata;
    assert.equal(metadata.registration_endpoint, ORIGIN + '/register');
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    for (const endpoint of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const resource = await (await h.request(endpoint)).json() as OAuthProtectedResourceMetadata;
      assert.equal(resource.resource, RESOURCE);
      assert.deepEqual(resource.authorization_servers, [ORIGIN + '/']);
    }
    const unauth = await h.request('/mcp');
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate')!, /resource_metadata=.*oauth-protected-resource\/mcp/);
    const registered = await h.request('/register', registration());
    assert.equal(registered.status, 201);
    assert.ok(registered.headers.get('x-request-id'));
    const client = await registered.json() as OAuthClientInformationFull & { access_token?: string };
    assert.ok(client.client_id);
    assert.equal(client.client_secret, undefined);
    assert.equal(client.access_token, undefined);
    assert.deepEqual(client.redirect_uris, [CALLBACK]);
    const forged = await h.request('/register', registration({ redirect_uris: [CALLBACK + '?evil=1'] }));
    assert.equal(forged.status, 400);
    assert.equal((await forged.json() as { error: string }).error, 'invalid_client_metadata');
    const future = await h.request('/register', registration({ redirect_uris: ['https://claude.com/api/mcp/auth_callback'] }));
    assert.equal(future.status, 201);
    const malformed = await h.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, 'invalid_request');
    const oversized = await h.request('/register', registration({ client_name: 'x'.repeat(20000) }));
    assert.equal(oversized.status, 413);
    const badMethod = await h.request('/register', registration({ token_endpoint_auth_method: 'private_key_jwt' }));
    assert.equal(badMethod.status, 400);
  } finally { await h.close(); }
});

test('OAuth full flow: owner consent, PKCE, client/redirect/resource binding, restart, refresh rotation and revocation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-oauth-'));
  const file = path.join(dir, 'bridge.db');
  let h = await harness(file);
  try {
    const client = await (await h.request('/register', registration())).json() as OAuthClientInformationFull;
    const other = await (await h.request('/register', registration())).json() as OAuthClientInformationFull;
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123', resource: RESOURCE, scope: 'mcp' });
    const invalidRedirect = await h.request('/authorize?' + new URLSearchParams({ ...Object.fromEntries(query), redirect_uri: 'https://evil.example/callback' }));
    assert.equal(invalidRedirect.status, 400);
    assert.equal(invalidRedirect.headers.get('location'), null);
    const noPkce = await h.request('/authorize?' + new URLSearchParams({ ...Object.fromEntries(query), code_challenge_method: 'plain' }));
    assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
    const authorize = await h.request('/authorize?' + query);
    assert.equal(authorize.status, 200);
    const page = await authorize.text();
    assert.ok(!page.includes(OWNER_TOKEN));
    assert.match(authorize.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(authorize.headers.get('referrer-policy'), 'origin', 'HTML form submissions must preserve their Origin header');
    const request = /name="request" value="([^"]+)"/.exec(page)![1];
    assert.equal((await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: OWNER_TOKEN }, 'https://evil.example'))).status, 403);
    assert.equal((await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: OWNER_TOKEN }, 'null'))).status, 403);
    assert.equal((await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: 'wrong' }, ORIGIN))).status, 403);
    const approved = await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: OWNER_TOKEN }, ORIGIN));
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get('location')!);
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.equal(callback.searchParams.get('state'), 'state-123');
    const code = callback.searchParams.get('code')!;
    assert.ok(code);
    assert.equal((await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: OWNER_TOKEN }, ORIGIN))).status, 400);
    const exchange = { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: CALLBACK, resource: RESOURCE };
    assert.equal((await h.request('/token', form({ ...exchange, code_verifier: 'wrong' }))).status, 400);
    assert.equal((await h.request('/token', form({ ...exchange, client_id: other.client_id }))).status, 400);
    assert.equal((await h.request('/token', form({ ...exchange, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }))).status, 400);
    assert.equal((await h.request('/token', form({ ...exchange, resource: 'https://evil.example/mcp' }))).status, 400);
    const tokenResponse = await h.request('/token', form(exchange));
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as OAuthTokens;
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.token_type, 'Bearer');
    assert.notEqual(tokens.access_token, OWNER_TOKEN);
    assert.equal((await h.request('/token', form(exchange))).status, 400, 'authorization code is single-use');
    const rows = JSON.stringify(h.store.db.prepare("SELECT * FROM oauth_records WHERE kind IN ('access','refresh','code')").all());
    assert.ok(!rows.includes(tokens.access_token) && !rows.includes(tokens.refresh_token), 'store token hashes only');
    await h.close();
    h = await harness(file);
    const initialized = await h.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + tokens.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } } }) });
    assert.equal(initialized.status, 200, 'OAuth access survives process restart');
    assert.equal((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'telegram-bridge');
    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: RESOURCE };
    assert.equal((await h.request('/token', form({ ...refresh, client_id: other.client_id }))).status, 400);
    assert.equal((await h.request('/token', form({ ...refresh, scope: 'admin' }))).status, 400);
    const rotatedResponse = await h.request('/token', form(refresh));
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json() as OAuthTokens;
    assert.ok(rotated.refresh_token);
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal((await h.request('/revoke', form({ client_id: client.client_id, token: rotated.refresh_token }))).status, 200);
    assert.equal((await h.request('/mcp', { headers: { authorization: 'Bearer ' + rotated.access_token } })).status, 401);
    assert.equal((await h.request('/mcp', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);
    assert.equal((await h.request('/token', form(refresh))).status, 400);
    assert.equal((await h.request('/mcp', { headers: { authorization: 'Bearer ' + OWNER_TOKEN } })).status, 405, 'existing static bearer remains valid');
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OAuth rejects expired tokens, wrong audiences and reused refresh tokens', async () => {
  const store = new BridgeStore(':memory:');
  try {
    const provider = new BridgeOAuth(store.db, cfg);
    const client = await provider.clientsStore.registerClient!({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const grant = { clientId: client.client_id, scopes: ['mcp'], resource: RESOURCE, grantId: 'family' };
    const insert = (kind: string, token: string, data: unknown, expiry: number) => store.db.prepare('INSERT OR REPLACE INTO oauth_records VALUES (?,?,?,?)').run(kind, digest(token), JSON.stringify(data), expiry);
    const future = Math.floor(Date.now() / 1000) + 3600;
    insert('access', 'expired', grant, 1);
    insert('access', 'wrong-resource', { ...grant, resource: 'https://evil.example/mcp' }, future);
    await assert.rejects(provider.verifyAccessToken('expired'));
    await assert.rejects(provider.verifyAccessToken('wrong-resource'));
    insert('refresh', 'refresh-once', grant, future);
    const tokens = await provider.exchangeRefreshToken(client, 'refresh-once');
    assert.ok(tokens.refresh_token);
    assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
    await assert.rejects(provider.exchangeRefreshToken(client, 'refresh-once'));
    await assert.rejects(provider.verifyAccessToken(tokens.access_token), 'replay revokes the whole grant');
    await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token));
  } finally { store.close(); }
});

test('CIMD resolves trusted HTTPS document, checks identity/callbacks, caches and never fetches arbitrary URLs', async () => {
  const store = new BridgeStore(':memory:');
  try {
    const clientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    let calls = 0;
    let doc = { client_id: clientId, client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] };
    const provider = new BridgeOAuth(store.db, cfg, (async (_url: unknown, init: RequestInit) => {
      calls++;
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } });
    }) as typeof fetch);
    assert.equal((await provider.clientsStore.getClient(clientId))?.client_id, clientId);
    assert.equal((await provider.clientsStore.getClient(clientId))?.token_endpoint_auth_method, 'none');
    assert.equal(calls, 1);
    for (const url of ['http://127.0.0.1/client.json', 'https://evil.example/client.json', 'https://claude.ai@127.0.0.1/client.json', clientId + '?next=http://127.0.0.1']) assert.equal(await provider.clientsStore.getClient(url), undefined);
    assert.equal(calls, 1);
    store.db.prepare("DELETE FROM oauth_records WHERE kind='cimd'").run();
    doc = { ...doc, client_id: 'https://evil.example/client.json' };
    assert.equal(await provider.clientsStore.getClient(clientId), undefined);
    doc = { ...doc, client_id: clientId, redirect_uris: ['https://evil.example/callback'] };
    assert.equal(await provider.clientsStore.getClient(clientId), undefined);
  } finally { store.close(); }
});

test('OAuth confidential clients: client_secret_post/basic must authenticate before code exchange', async () => {
  const h = await harness();
  try {
    for (const method of ['client_secret_post', 'client_secret_basic']) {
      const response = await h.request('/register', registration({ token_endpoint_auth_method: method }));
      assert.equal(response.status, 201);
      const client = await response.json() as OAuthClientInformationFull;
      assert.ok(client.client_secret);
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
      const page = await (await h.request('/authorize?' + query)).text();
      const request = /name="request" value="([^"]+)"/.exec(page)![1];
      const approved = await h.request('/oauth/approve', form({ request, decision: 'approve', owner_token: OWNER_TOKEN }, ORIGIN));
      const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
      const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK };
      assert.equal((await h.request('/token', form({ ...exchange, client_id: client.client_id, client_secret: 'incorrect' }))).status, 400);
      const init = method === 'client_secret_post' ? form({ ...exchange, client_id: client.client_id, client_secret: client.client_secret }) : form(exchange);
      if (method === 'client_secret_basic') init.headers = { ...init.headers, authorization: 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64') };
      const exchanged = await h.request('/token', init);
      assert.equal(exchanged.status, 200);
    }
  } finally { await h.close(); }
});
