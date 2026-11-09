// ClaudeCopyWriter với một server giả lập Messages API: kiểm tra hình dạng request
// (ảnh, structured output, fallbacks) và vòng viết lại khi copy vi phạm quy tắc.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeCopyWriter, CopyRulesError } from '../src/agent/copy/writer.ts';
import { makeImage } from './helpers/agentHarness.ts';

const requests: Array<{ headers: Record<string, string>; body: any }> = [];
let replies: Array<object> = [];
let server: Server;
let baseURL: string;
let tmp: string;
let img: string;

const variant = (over: Record<string, string> = {}) => ({
  style: 'first_person_story',
  headline: 'For the Man Drawn to the Wild',
  primary_text: "People think I'm crazy for wearing my Native hoodie everywhere…\nThe red raven wraps around the back.\nPrinted on both sides.\nTap to pick your size",
  description: 'Printed front and back',
  reason: 'Có người mặc thật.',
  ...over,
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-copy-'));
  img = makeImage(tmp, 'frame.jpg', 640, 640);
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.post('/v1/messages', (req, res) => {
    requests.push({ headers: req.headers as Record<string, string>, body: req.body });
    const payload = replies.shift() ?? { variants: [] };
    res.json({
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: req.body.model,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  });
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const input = () => ({
  product: {
    title: 'Raven 3D Hoodie',
    description: 'Printed front and back',
    productType: 'Hoodie',
    tags: [],
    priceRange: '$49.95',
    variants: [],
    url: 'https://firstnationslegacy.com/products/raven',
    pageText: 'Raven 3D Hoodie',
  },
  images: [img],
  creativeSummary: '1 video (9:16; 20s)',
  copyNote: '',
});

test('request đúng hình dạng; copy vi phạm được gửi lại để viết lại', async () => {
  requests.length = 0;
  replies = [
    { variants: [variant({ primary_text: variant().primary_text.replace('Printed', 'An authentic design, printed') }), variant({ style: 'gift_giver' })] },
    { variants: [variant(), variant({ style: 'gift_giver', headline: 'For the Man Who Has Everything' })] },
  ];
  const w = new ClaudeCopyWriter({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fallbacks: true, baseURL });
  const r = await w.write(input());
  assert.equal(r.variants.length, 2);
  assert.equal(requests.length, 2, 'gọi lại một lần để viết lại');

  const first = requests[0];
  assert.equal(first.body.model, 'claude-sonnet-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(first.body.output_config.format.type, 'json_schema');
  assert.equal(first.body.system[0].cache_control.type, 'ephemeral');
  assert.equal(first.body.messages[0].content[0].type, 'image');
  assert.equal(first.body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(first.body.thinking, undefined, 'không gửi cấu hình thinking cũ');

  const second = requests[1];
  assert.equal(second.body.messages.length, 3);
  assert.equal(second.body.messages[1].role, 'assistant');
  assert.match(second.body.messages[2].content, /V1: .*authentic/);
});

test('vẫn vi phạm sau 3 lần → CopyRulesError (brief dừng, không gửi copy xấu)', async () => {
  requests.length = 0;
  const bad = { variants: [variant({ headline: 'Authentic Native-made Raven Hoodie' }), variant({ style: 'gift_giver', headline: 'Authentic Native-made Gift For Him' })] };
  replies = [bad, bad, bad];
  const w = new ClaudeCopyWriter({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', fallbacks: false, baseURL });
  await assert.rejects(() => w.write(input()), CopyRulesError);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.fallbacks, undefined, 'tắt fallbacks thì không gửi');
});
