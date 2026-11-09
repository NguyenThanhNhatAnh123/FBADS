import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { BridgeStore } from '../src/bridge/db.ts';
import { StagedMedia, PublicDriveSource, MediaError, mountMedia, type MediaSource, type MediaConfig, VIDEO_MAX_BYTES } from '../src/bridge/media.ts';

let assets: string, png: Buffer, mp4: Buffer;
const fileId = 'DRIVE_FILE_0123456789';
before(() => {
  assets = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-stage-assets-'));
  const image = path.join(assets, 'test.png'), video = path.join(assets, 'test.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', image], { windowsHide: true });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x320:r=10:d=1', '-c:v', 'mpeg4', video], { windowsHide: true });
  png = fs.readFileSync(image); mp4 = fs.readFileSync(video);
});
after(() => fs.rmSync(assets, { recursive: true, force: true }));
const source = (bytes: Buffer, fileName: string, mimeType: string): MediaSource => ({ async open(id) { assert.equal(id, fileId); return { fileName, mimeType, size: bytes.length, stream: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]) }; } });
async function harness(publicSource: MediaSource, privateSource?: MediaSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-stage-'));
  const store = new BridgeStore(path.join(dir, 'bridge.db'));
  const cfg: MediaConfig = { publicUrl: 'https://ads.example.com', dir: path.join(dir, 'cache'), serviceAccountJson: '', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe', maxCacheBytes: 5_000_000_000 };
  const media = new StagedMedia(cfg, store.db, { public: publicSource, private: privateSource });
  const app = express(); mountMedia(app, media);
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { dir, cfg, media, store, request: (url: string, init?: RequestInit) => fetch(base + new URL(url, base).pathname, init), async close() { media.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('stage PNG and MP4: real ffprobe, direct HEAD/GET, byte ranges, no redirects, restart and robots', async () => {
  let active = source(png, 'raven.png', 'image/png');
  const h = await harness({ open: id => active.open(id) });
  try {
    const image = await h.media.stage(fileId);
    assert.equal(image.file_name, 'raven.png');
    assert.equal(image.width, 320); assert.equal(image.height, 240);
    assert.equal(image.duration_sec, undefined);
    assert.equal(image.kind, 'image');
    assert.equal(image.size_bytes, png.length);
    const head = await h.request(image.url, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/png');
    assert.equal(head.headers.get('content-length'), String(png.length));
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('location'), null);
    active = source(mp4, 'raven.mp4', 'video/mp4');
    const video = await h.media.stage(fileId, 24);
    assert.equal(video.kind, 'video'); assert.equal(video.width, 160); assert.equal(video.height, 320);
    assert.equal(video.duration_sec, 1);
    const partial = await h.request(video.url, { headers: { range: 'bytes=0-15', 'user-agent': 'facebookexternalhit' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-length'), '16');
    assert.equal(partial.headers.get('content-range'), `bytes 0-15/${mp4.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), mp4.subarray(0, 16));
    const suffix = await h.request(video.url, { headers: { range: 'bytes=-8' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), mp4.subarray(-8));
    const invalidRange = await h.request(video.url, { headers: { range: `bytes=${mp4.length + 1}-` } });
    assert.equal(invalidRange.status, 416);
    const token = new URL(video.url).pathname.split('/')[2];
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM staged_media').all()).includes(token));
    const reopened = new StagedMedia(h.cfg, h.store.db, { public: active });
    assert.equal(reopened.lookup(token)?.file_name, 'raven.mp4');
    const robots = await h.request('/robots.txt');
    assert.match(await robots.text(), /Allow: \/media\//);
    assert.equal((await h.request('/media/' + 'x'.repeat(43) + '/raven.mp4')).status, 404);
    assert.equal((await h.request('/media/' + token + '/wrong.mp4')).status, 404);
    const hash = createHash('sha256').update(token).digest('hex');
    h.store.db.prepare("UPDATE staged_media SET expires=1,data=json_set(data,'$.expires',1) WHERE token_hash=?").run(hash);
    assert.equal((await h.request(video.url)).status, 410);
    await h.media.cleanup();
    assert.equal((await h.request(video.url)).status, 404);
    assert.equal(fs.readdirSync(h.cfg.dir).filter(name => name.endsWith('.mp4')).length, 0);
    assert.equal((await h.request(image.url)).status, 200, 'cleanup preserves live images');
  } finally { await h.close(); }
});

test('staging bounds streamed bytes, rejects HTML/truncation/types, removes partial files and enforces TTL', async () => {
  let active: MediaSource = { async open() { return { fileName: 'large.mp4', mimeType: 'video/mp4', size: VIDEO_MAX_BYTES + 1, stream: Readable.from([mp4]) }; } };
  const h = await harness({ open: id => active.open(id) });
  const fails = async (code: string) => assert.rejects(h.media.stage(fileId), (e: unknown) => e instanceof MediaError && e.code === code);
  try {
    await fails('too_large');
    active = { async open() { return { fileName: 'large.png', mimeType: 'image/png', size: null, stream: Readable.from((async function* () { yield png; for (let i = 0; i < 31; i++) yield Buffer.alloc(1_000_000); })()) }; } };
    await fails('too_large');
    active = source(Buffer.from('<html>not a video</html>'), 'fake.mp4', 'video/mp4');
    await fails('unsupported_type');
    active = { async open() { return { fileName: 'short.png', mimeType: 'image/png', size: png.length + 10, stream: Readable.from([png]) }; } };
    await fails('download_failed');
    active = source(png, 'wrong.exe', 'image/png');
    await fails('unsupported_type');
    active = source(png, 'raven.png', 'image/png');
    await assert.rejects(h.media.stage(fileId, 25), (e: unknown) => e instanceof MediaError && e.code === 'invalid_ttl');
    await assert.rejects(h.media.stage('../secret'), (e: unknown) => e instanceof MediaError && e.code === 'not_found');
    assert.deepEqual(fs.readdirSync(h.cfg.dir), []);
    assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM staged_media').get() as { n: number }).n, 0);
  } finally { await h.close(); }
});

test('service account takes priority, permission failure falls back to public, source errors are preserved', async () => {
  let privateCalls = 0, publicCalls = 0, deny = false;
  const h = await harness({ async open(id) { publicCalls++; return source(png, 'public.png', 'image/png').open(id); } }, { email: 'staging@example.iam.gserviceaccount.com', async open(id) { privateCalls++; if (deny) throw new MediaError('no_access', 'denied'); return source(png, 'private.png', 'image/png').open(id); } });
  try {
    assert.equal(h.media.serviceAccountEmail, 'staging@example.iam.gserviceaccount.com');
    assert.equal((await h.media.stage(fileId)).file_name, 'private.png');
    assert.equal(privateCalls, 1); assert.equal(publicCalls, 0);
    deny = true;
    assert.equal((await h.media.stage(fileId)).file_name, 'public.png');
    assert.equal(publicCalls, 1);
    const missing = new StagedMedia(h.cfg, h.store.db, { public: { async open() { throw new MediaError('not_found', 'missing'); } } });
    await assert.rejects(missing.stage(fileId), (e: unknown) => e instanceof MediaError && e.code === 'not_found');
  } finally { await h.close(); }
});

test('public Drive downloader: fixed URL, no credentials, blocked redirects and HTML', async () => {
  const source = new PublicDriveSource((async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'drive.usercontent.google.com'); assert.equal(url.searchParams.get('id'), fileId);
    assert.equal(init.redirect, 'manual'); assert.equal(new Headers(init.headers).get('authorization'), null);
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length), 'content-disposition': "attachment; filename*=UTF-8''raven%20test.png" } });
  }) as typeof fetch);
  const opened = await source.open(fileId);
  assert.equal(opened.fileName, 'raven test.png'); opened.stream.destroy();
  const blocked = new PublicDriveSource((async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })) as typeof fetch);
  await assert.rejects(blocked.open(fileId), (e: unknown) => e instanceof MediaError && e.code === 'download_failed');
  const html = new PublicDriveSource((async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch);
  await assert.rejects(html.open(fileId), (e: unknown) => e instanceof MediaError && e.code === 'no_access');
});

test('staging bounds concurrent downloads and cache reservations', async () => {
  const h = await harness(source(png, 'small.png', 'image/png'));
  try {
    const first = h.media.stage(fileId), second = h.media.stage(fileId);
    await assert.rejects(h.media.stage(fileId), (e: unknown) => e instanceof MediaError && e.code === 'busy');
    await Promise.all([first, second]);
    const bounded = new StagedMedia({ ...h.cfg, maxCacheBytes: VIDEO_MAX_BYTES }, h.store.db, { public: source(png, 'small.png', 'image/png') });
    await assert.rejects(bounded.stage(fileId), (e: unknown) => e instanceof MediaError && e.code === 'cache_full');
    assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM staged_media').get() as { n: number }).n, 2);
  } finally { await h.close(); }
});
