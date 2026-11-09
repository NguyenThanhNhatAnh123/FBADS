import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadonlyBilling, BillingError, H3_ACCOUNT_ID } from '../src/bridge/billing.ts';

const account = { name: 'H3', currency: 'USD', account_status: 1, disable_reason: 0, balance: '4210', amount_spent: '1234500', spend_cap: '0', is_prepay_account: false, funding_source_details: { display_string: 'Visa 4111 1111 1111 4417', id: 'secret-funding-id' } };
test('billing: only GET on H3, integer minor units, latest threshold and card redaction', async () => {
  const calls: string[] = [];
  const service = new ReadonlyBilling({ token: 'read-only-secret', apiVersion: 'v26.0' }, (async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url.href);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.ok(url.pathname.startsWith('/v26.0/act_' + H3_ACCOUNT_ID));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer read-only-secret');
    assert.ok(!url.href.includes('read-only-secret'));
    return Response.json(url.pathname.endsWith('adspaymentcycle') ? { data: [{ threshold_amount: 10000, updated_time: '2025-01-01' }, { threshold_amount: '50000', updated_time: '2026-11-09' }] } : account);
  }) as typeof fetch);
  const result = await service.read();
  assert.equal(calls.length, 2);
  assert.equal(result.account_id, H3_ACCOUNT_ID);
  assert.equal(result.account_status, 'ACTIVE');
  assert.equal(result.balance_cents, 4210);
  assert.equal(result.amount_spent_cents, 1234500);
  assert.equal(result.spend_cap_cents, null);
  assert.equal(result.threshold_cents, 50000);
  assert.equal(result.percent_of_threshold, 8.4);
  assert.equal(result.is_prepay, false);
  assert.equal(result.funding_source, 'Visa ••4417');
  assert.ok(!JSON.stringify(result).includes('4111'));
  assert.ok(!JSON.stringify(result).includes('secret-funding-id'));
});

test('billing: unsupported payment edge never fabricates a threshold', async () => {
  const service = new ReadonlyBilling({ token: 'x', apiVersion: 'v26.0' }, (async (input: URL) => new URL(input).pathname.endsWith('adspaymentcycle') ? Response.json({ error: { code: 100, message: 'unsupported secret' } }, { status: 400 }) : Response.json({ ...account, account_status: 2, balance: null })) as typeof fetch);
  const result = await service.read();
  assert.equal(result.account_status, 'DISABLED');
  assert.equal(result.threshold_cents, null);
  assert.equal(result.percent_of_threshold, null);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(!JSON.stringify(result).includes('unsupported secret'));
});

test('billing: optional fields fall back, missing config/auth errors do not expose API text', async () => {
  let calls = 0;
  const service = new ReadonlyBilling({ token: 'x', apiVersion: 'v26.0' }, (async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { code: 100 } }, { status: 400 });
    if (calls === 2) return Response.json({ currency: 'USD', account_status: 1, balance: '0' });
    return Response.json({ data: [] });
  }) as typeof fetch);
  const result = await service.read();
  assert.equal(calls, 3);
  assert.equal(result.is_prepay, null);
  assert.equal(result.funding_source, null);
  assert.equal(result.amount_spent_cents, null);
  await assert.rejects(new ReadonlyBilling({ token: '', apiVersion: 'v26.0' }).read(), (e: unknown) => e instanceof BillingError && e.code === 'not_configured');
  const expired = new ReadonlyBilling({ token: 'x', apiVersion: 'v26.0' }, (async () => Response.json({ error: { code: 190, message: '4111111111111111 bearer secret' } }, { status: 400 })) as typeof fetch);
  await assert.rejects(expired.read(), (e: unknown) => e instanceof BillingError && e.code === 'invalid_token' && !/4111|bearer/.test(e.message));
});
