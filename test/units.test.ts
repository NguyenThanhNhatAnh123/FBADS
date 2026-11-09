import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signCallback, verifyCallback } from '../src/agent/callbacks.ts';
import { ratioLabel, checkMedia, probe, extractFrames } from '../src/agent/media.ts';
import { chunkText } from '../src/shared/telegram.ts';
import { lastClosedAdDay, startOfDayUtc, tzOffsetMinutes } from '../src/shared/time.ts';
import { toTelegramMarkdown, RateLimiter } from '../src/bridge/outbox.ts';
import { classify } from '../src/bridge/router.ts';
import { parseItemId } from '../src/bridge/mcp.ts';
import { rateLimitWaitMs, isRateLimit } from '../src/agent/meta/graph.ts';
import { productFromCampaignName, campaignName, adName } from '../src/agent/pipeline/steps.ts';

test('callback_data: ký, kiểm tra, chống sửa, ≤ 64 byte', () => {
  const d = signCallback('secret-key-1234567890abcdef', 42, 'ok', 3);
  assert.ok(Buffer.byteLength(d) <= 64);
  assert.deepEqual(verifyCallback('secret-key-1234567890abcdef', d), { requestId: 42, action: 'ok', version: 3 });
  assert.equal(verifyCallback('secret-key-1234567890abcdef', d.replace(':ok:', ':cx:')), null);
  assert.equal(verifyCallback('other-secret', d), null);
  assert.equal(verifyCallback('secret-key-1234567890abcdef', 'cl:1:0'), null);
});

test('ratioLabel', () => {
  assert.deepEqual(ratioLabel(1080, 1920), { label: '9:16', standard: true });
  assert.deepEqual(ratioLabel(1080, 1350), { label: '4:5', standard: true });
  assert.deepEqual(ratioLabel(1080, 1080), { label: '1:1', standard: true });
  assert.equal(ratioLabel(1920, 1080).standard, false);
});

test('checkMedia: thời lượng, định dạng, cạnh ngắn ảnh', () => {
  const v = checkMedia('video', 'a.mp4', 'video/mp4', { width: 1080, height: 1920, durationS: 70, formatName: 'mov,mp4', codec: 'h264' });
  assert.match(v.errors[0], /cần 5–60 giây/);
  const i = checkMedia('image', 'b.png', 'image/png', { width: 800, height: 1000, durationS: null, formatName: 'png_pipe', codec: 'png' });
  assert.match(i.errors[0], /≥ 1080/);
  const w = checkMedia('video', 'c.mov', 'video/quicktime', { width: 1920, height: 1080, durationS: 20, formatName: 'mov,mp4', codec: 'h264' });
  assert.deepEqual(w.errors, []);
  assert.match(w.warnings[0], /khác 9:16/);
});

test('ffprobe + ffmpeg trên video thật (9:16, 6 giây)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-media-'));
  const file = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=10:duration=6', '-c:v', 'mpeg4', file]);
  const p = await probe(file);
  assert.equal(p.width, 540);
  assert.equal(p.height, 960);
  assert.ok(Math.abs((p.durationS ?? 0) - 6) < 0.5);
  assert.equal(checkMedia('video', 'clip.mp4', 'video/mp4', p).ratio, '9:16');
  const frames = await extractFrames(file, p.durationS!, path.join(dir, 'frames'));
  assert.equal(frames.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chunkText chia ở xuống dòng, không đoạn nào > 4096', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Dòng ${i} ` + 'x'.repeat(40)).join('\n');
  const parts = chunkText(text, 4096);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('khung ngày Dawson: 07:00 → 07:00 UTC (14:00 → 14:00 giờ VN)', () => {
  assert.equal(tzOffsetMinutes('America/Dawson', new Date('2026-11-07T00:00:00Z')), -420);
  const w = lastClosedAdDay(new Date('2026-11-07T08:00:00Z')); // 15:00 VN 07/11
  assert.equal(w.since.toISOString(), '2026-11-06T07:00:00.000Z');
  assert.equal(w.until.toISOString(), '2026-11-07T07:00:00.000Z');
  assert.equal(startOfDayUtc('America/Dawson', 2026, 11, 9).toISOString(), '2026-11-09T07:00:00.000Z');
});

test('toTelegramMarkdown', () => {
  assert.equal(toTelegramMarkdown('## Báo cáo\n**ROAS** 2.1\n- camp A'), '*Báo cáo*\n*ROAS* 2.1\n• camp A');
});

test('RateLimiter: tối đa N lần mỗi phút, phần dư phải chờ', async () => {
  let t = 0;
  const waits: number[] = [];
  const rl = new RateLimiter(3, () => t, async (ms) => {
    waits.push(ms);
    t += ms;
  });
  const at: number[] = [];
  for (let i = 0; i < 7; i++) {
    await rl.take();
    at.push(t);
  }
  // 3 lần đầu ngay lập tức, lần 4 phải chờ ~60s, lần 7 chờ thêm ~60s nữa.
  assert.deepEqual(at.slice(0, 3), [0, 0, 0]);
  assert.ok(at[3] >= 60_000);
  assert.ok(at[6] >= 120_000);
  for (let i = 0; i < at.length; i++) assert.ok(at.filter((x) => x > at[i] - 60_000 && x <= at[i]).length <= 3);
});

test('router: brief, lệnh, nút, trả lời tin Agent, tin tự do', () => {
  const chat = { id: 1, type: 'private' };
  const msg = (text: string, extra = {}) => ({ update_id: 1, message: { message_id: 5, date: 0, chat, text, ...extra } });
  assert.equal(classify(msg('#NEW\nTK: H3'), () => false).to, 'agent');
  assert.equal(classify(msg('#add ...'), () => false).to, 'agent');
  assert.equal(classify(msg('/retry 12'), () => false).to, 'agent');
  assert.equal(classify(msg('gửi bảng này lên'), () => false).to, 'inbox');
  const replyAgent = msg('nhấn mạnh in 2 mặt', { reply_to_message: { message_id: 9, date: 0, chat, from: { id: 7, is_bot: true } } });
  const r = classify(replyAgent, () => false);
  assert.ok(r.to === 'agent' && r.fallbackInbox);
  assert.equal(classify(replyAgent, () => true).to, 'inbox'); // trả lời tin Claude gửi
  const cb = (data: string) => ({ update_id: 2, callback_query: { id: 'q', from: { id: 1, is_bot: false }, data, message: { message_id: 3, date: 0, chat } } });
  assert.equal(classify(cb('ag:1:ok:1:abc'), () => false).to, 'agent');
  assert.equal(classify(cb('cl:3:0'), () => false).to, 'buttons');
});

test('parseItemId', () => {
  assert.deepEqual(parseItemId('m12'), { table: 'inbox', n: 12 });
  assert.deepEqual(parseItemId('b3'), { table: 'press', n: 3 });
  assert.equal(parseItemId('12'), null);
});

test('Meta: nhận diện giới hạn tần suất và thời gian chờ từ header', () => {
  assert.ok(isRateLimit({ code: 17 }));
  assert.ok(isRateLimit({ code: 100, error_subcode: 2446079 }));
  assert.ok(!isRateLimit({ code: 100 }));
  const h = new Headers({ 'x-business-use-case-usage': JSON.stringify({ '123': [{ estimated_time_to_regain_access: 2 }] }) });
  assert.equal(rateLimitWaitMs(h), 120_000);
  assert.equal(rateLimitWaitMs(new Headers()), 60_000);
});

test('quy ước tên', () => {
  const c = campaignName('Dân', 'Auto', '3D Hoodie Raven', '07/11/2026');
  assert.equal(c, 'Dân - Auto - 3D Hoodie Raven - 07/11/2026');
  assert.equal(productFromCampaignName(c), '3D Hoodie Raven');
  assert.equal(productFromCampaignName('Camp tay'), null);
  assert.equal(adName('3D Hoodie Raven', 'raven_v1.mp4', 2), '3D Hoodie Raven - raven_v1 - V2');
});
