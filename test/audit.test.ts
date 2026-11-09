// audit.ts: soát lại các lần gọi tool của một lượt claude -p từ nhật ký phiên.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditCalls, graphqlRootFields, readToolCalls, transcriptPath, type ToolCall } from '../src/bridge/jobs/audit.ts';
import { allowedToolsFor, disallowedToolsFor, mediaViaShopify } from '../src/bridge/jobs/prompts.ts';

const SM = 'mcp__claude_ai_Shopify__graphql_mutation';
const call = (name: string, input: Record<string, unknown>, result?: string): ToolCall => ({ id: Math.random().toString(36), name, input, result });

test('graphqlRootFields: lấy đúng trường gốc, bỏ qua chuỗi, tham số, fragment lồng', () => {
  assert.deepEqual(graphqlRootFields('mutation fileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id ... on MediaImage { image { url } } } } }'), ['fileCreate']);
  assert.deepEqual(graphqlRootFields('mutation { a: productUpdate(input: {title: "x { y }"}) { product { id } } fileDelete(fileIds: ["1"]) { deletedFileIds } }'), ['productUpdate', 'fileDelete']);
  assert.deepEqual(graphqlRootFields('{ node(id: "gid://x") { id } }'), ['node']);
});

test('auditCalls: fileCreate / fileDelete đúng file của lượt → không bất thường', () => {
  const r = auditCalls(
    [
      call(SM, { query: 'mutation fileCreate($f: [FileCreateInput!]!) { fileCreate(files: $f) { files { id } } }' }, '{"files":[{"id":"gid://shopify/MediaImage/9"}]}'),
      call(SM, { query: 'mutation fileDelete($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds } }', variables: { fileIds: ['gid://shopify/MediaImage/9'] } }),
      call('mcp__claude_ai_Facebook_Ads__ads_create_campaign', { ad_account_id: '1', campaign_name: 'x' }),
      call('mcp__claude_ai_Facebook_Ads__ads_update_entity', { entity_id: 'c1', fields: '{"daily_budget":500}' }),
    ],
    { kind: 'create', ownIds: ['c1'] },
  );
  assert.deepEqual(r.anomalies, []);
  assert.ok(r.writes.includes('shopify fileCreate'));
});

test('auditCalls: bắt mutation ngoài phạm vi, xoá file lạ, sửa budget object lạ, bật ngoài danh sách', () => {
  const r = auditCalls(
    [
      call(SM, { query: 'mutation { productUpdate(input: {id: "gid://shopify/Product/1"}) { product { id } } }' }),
      call(SM, { query: 'mutation fileDelete($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds } }', variables: { fileIds: ['gid://shopify/MediaImage/777'] } }),
      call('mcp__claude_ai_Facebook_Ads__ads_update_entity', { entity_id: '999', fields: { daily_budget: 900000 } }),
      call('mcp__claude_ai_Facebook_Ads__ads_update_entity', { entity_id: '998', fields: '{"status":"DELETED"}' }),
      call('mcp__claude_ai_Shopify__update-product', { id: 'x' }),
    ],
    { kind: 'create', ownIds: ['c1'] },
  );
  const all = r.anomalies.join('\n');
  assert.match(all, /productUpdate/);
  assert.match(all, /fileDelete xoá file không do lượt này tạo: gid:\/\/shopify\/MediaImage\/777/);
  assert.match(all, /đổi daily_budget trên 999/);
  assert.match(all, /DELETED cho 998/);
  assert.match(all, /update-product/);

  const a = auditCalls([call('mcp__claude_ai_Facebook_Ads__ads_activate_entity', { entity_id: '555' })], { kind: 'activate', approvedIds: ['c1', 'ad1'] });
  assert.match(a.anomalies.join(), /ngoài danh sách được duyệt: 555/);
  const e = auditCalls([call(SM, { query: 'mutation { fileCreate(files: []) { files { id } } }' })], { kind: 'edit' });
  assert.match(e.anomalies.join(), /graphql_mutation trong lượt edit/);
});

test('readToolCalls + transcriptPath: đọc tool_use và tool_result, bỏ dòng trùng', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-audit-'));
  const work = path.join(cfg, 'runs', 'run-7');
  const file = transcriptPath(work, 'sess-1', cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const use = { type: 'tool_use', id: 't1', name: SM, input: { query: 'mutation { fileCreate(files: []) { files { id } } }' } };
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'assistant', message: { content: [use] } }),
      JSON.stringify({ type: 'api-request-blob', message: { content: [use] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'gid://shopify/MediaImage/5' }] }] } }),
    ].join('\n'),
  );
  const calls = readToolCalls(file)!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].result, 'gid://shopify/MediaImage/5');
  assert.match(file, /projects[\\/].*-runs-run-7[\\/]sess-1\.jsonl$/);
  assert.equal(readToolCalls(path.join(cfg, 'nope.jsonl')), null);
});

test('quyền graphql_mutation: chỉ lượt create chạy thật; prompt hướng dẫn Shopify Files', () => {
  assert.ok(allowedToolsFor('create').includes(SM));
  assert.ok(!disallowedToolsFor('create').includes(SM));
  for (const k of ['edit', 'activate', 'cancel'] as const) {
    assert.ok(!allowedToolsFor(k).includes(SM), k);
    assert.ok(disallowedToolsFor(k).includes(SM), k);
  }
  assert.ok(!allowedToolsFor('create', true).includes(SM), 'chạy thử không được ghi Shopify');
  const t = mediaViaShopify(12);
  assert.match(t, /fileCreate/);
  assert.match(t, /KHÔNG truyền filename/);
  assert.match(t, /cdn\.shopify\.com/);
  assert.match(t, /fileDelete/);
  assert.match(t, /ads-brief-12/);
});
