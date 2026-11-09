// Checklist nghiệm thu Giai đoạn 1, chạy với Meta + Telegram giả lập (không cần token thật).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, newBrief, makeVideo, makeImage, OWNER, PAGE, type Harness } from './helpers/agentHarness.ts';
import { resumeUnfinished } from '../src/agent/resume.ts';
import { approvalSweep } from '../src/agent/scheduler.ts';
import { formatDate, TZ_VN } from '../src/shared/time.ts';

let assets: string;
let video1: string;
let video2: string;
let video3: string;
let banner: string;

before(() => {
  assets = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-assets-'));
  video1 = makeVideo(assets, 'raven_hook.mp4');
  video2 = makeVideo(assets, 'raven_b.mp4', 540, 960, 7);
  video3 = makeVideo(assets, 'raven_c.mp4', 864, 1080, 8); // 4:5
  banner = makeImage(assets, 'banner.png');
});
after(() => fs.rmSync(assets, { recursive: true, force: true }));

function seedDrive(h: Harness) {
  h.drive.files.set('FILE_ONE_VIDEO', [{ id: 'FILE_ONE_VIDEO', name: 'raven_hook.mp4', mimeType: 'video/mp4', size: 1, kind: 'video', local: video1 }]);
  h.drive.files.set('FOLDER_THREE', [
    { id: 'F1aaaaaaaaaa', name: 'a_raven.mp4', mimeType: 'video/mp4', size: 1, kind: 'video', local: video1 },
    { id: 'F2aaaaaaaaaa', name: 'b_raven.mp4', mimeType: 'video/mp4', size: 1, kind: 'video', local: video2 },
    { id: 'F3aaaaaaaaaa', name: 'c_banner.png', mimeType: 'image/png', size: 1, kind: 'image', local: banner },
  ]);
  h.drive.files.set('FILE_45_VIDEO', [{ id: 'FILE_45_VIDEO', name: 'raven_45.mp4', mimeType: 'video/mp4', size: 1, kind: 'video', local: video3 }]);
}

async function withHarness(fn: (h: Harness) => Promise<void>) {
  const h = await startHarness();
  seedDrive(h);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const today = () => formatDate(new Date(), TZ_VN);

test('#NEW 1 video → camp, adset, 2 ad PAUSED đúng tên, tin duyệt có 2 Post ID, không có camp nháp', () =>
  withHarness(async (h) => {
    await h.send(newBrief({ budget: 8 }));
    const camps = h.meta.of('campaign');
    assert.equal(camps.length, 1, 'chỉ đúng 1 campaign');
    const c = camps[0];
    assert.equal(c.name, `Dân - Auto - 3D Hoodie Raven - ${today()}`);
    assert.equal(c.status, 'PAUSED');
    assert.equal(c.objective, 'OUTCOME_SALES');
    assert.equal(c.daily_budget, '800');
    assert.equal(c.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
    assert.deepEqual(c.special_ad_categories, []);

    const adsets = h.meta.of('adset');
    assert.equal(adsets.length, 1);
    assert.equal(adsets[0].name, `${c.name} - US`);
    assert.equal(adsets[0].status, 'PAUSED');
    assert.equal(adsets[0].optimization_goal, 'OFFSITE_CONVERSIONS');
    assert.deepEqual(adsets[0].promoted_object, { pixel_id: '625569536048355', custom_event_type: 'PURCHASE' });
    assert.deepEqual(adsets[0].targeting.geo_locations, { countries: ['US'] });
    assert.equal(adsets[0].publisher_platforms, undefined, 'Advantage+ placements: không truyền publisher_platforms');

    const ads = h.meta.of('ad');
    assert.equal(ads.length, 2);
    assert.ok(ads.every((a) => a.status === 'PAUSED'));
    assert.deepEqual(ads.map((a) => a.name).sort(), ['3D Hoodie Raven - raven_hook - V1', '3D Hoodie Raven - raven_hook - V2']);

    const creatives = h.meta.of('creative');
    assert.equal(creatives.length, 2);
    const posts = creatives.map((cr) => cr.effective_object_story_id);
    assert.equal(new Set(posts).size, 2, 'mỗi ad một Post ID riêng');
    assert.ok(posts.every((p) => p.startsWith(`${PAGE}_`)));
    const v = creatives[0].object_story_spec.video_data;
    assert.equal(v.call_to_action.type, 'SHOP_NOW');
    assert.equal(v.call_to_action.value.link, 'https://firstnationslegacy.com/products/raven-spirit-3d-hoodie');

    const approval = h.tg.sent('sendMessage').find((m) => /CHỜ DUYỆT/.test(m.body.text))!;
    assert.ok(approval, 'có tin duyệt');
    for (const p of posts) assert.ok(approval.body.text.includes(p), `tin duyệt có Post ID ${p}`);
    assert.match(approval.body.text, /Creative: 1 video \(9:16 ✓\)/);
    assert.match(approval.body.text, /\[V1 Feed\].*\[V1 Reels\].*\[V2 Feed\]/s);
    assert.ok(h.tg.sent('sendVideo').length === 1, 'gửi kèm video creative');
    assert.equal(h.copy.calls.length, 1);
    assert.equal(h.copy.calls[0].images.length, 3, '3 khung hình cắt từ video');
    const req = h.store.getRequest(1)!;
    assert.equal(req.status, 'pending_approval');
  }));

test('Duyệt & chạy → bật ad → adset → campaign, effective_status ACTIVE, tin đổi 🟢 kèm ID', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    await h.press(/Duyệt & chạy/);
    for (const t of ['campaign', 'adset', 'ad'] as const) assert.ok(h.meta.of(t).every((o) => o.effective_status === 'ACTIVE'), `${t} ACTIVE`);
    const order = h.meta.requests.filter((r) => r.method === 'POST' && r.params.status === 'ACTIVE').map((r) => h.meta.objects.get(r.path)!.type);
    assert.deepEqual(order, ['ad', 'ad', 'adset', 'campaign']);
    const edit = h.tg.calls.filter((c) => c.method === 'editMessageText').pop()!;
    assert.match(edit.body.text, /🟢 <b>ĐANG CHẠY<\/b>/);
    assert.ok(edit.body.text.includes(h.meta.of('campaign')[0].id));
    assert.equal(h.store.getRequest(1)!.status, 'active');
    // Bấm lại → nút đã hết hiệu lực, không bật lần hai.
    const before = h.meta.requests.length;
    await h.press(/Duyệt & chạy/);
    assert.equal(h.meta.requests.length, before);
  }));

test('Thư mục Drive 3 file → 3 creative × 2 phương án = 6 ad', () =>
  withHarness(async (h) => {
    await h.send(newBrief({ creative: 'FOLDER_THREE' }));
    assert.equal(h.meta.of('ad').length, 6);
    assert.equal(h.meta.of('creative').length, 6);
    assert.equal(h.meta.of('video').length, 2);
    assert.equal(h.meta.requests.filter((r) => r.path.endsWith('/adimages')).length, 1);
    const img = h.meta.of('creative').find((c) => c.object_story_spec.link_data)!;
    assert.match(img.object_story_spec.link_data.image_hash, /^hash_/);
  }));

test('Huỷ → mọi object PAUSED của brief bị xoá, tin đổi ⚪', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    await h.press(/Huỷ/);
    for (const t of ['campaign', 'adset', 'ad'] as const) assert.equal(h.meta.of(t).length, 0, `${t} đã xoá`);
    assert.equal(h.store.getRequest(1)!.status, 'cancelled');
    assert.match(h.tg.calls.filter((c) => c.method === 'editMessageText').pop()!.body.text, /ĐÃ HUỶ/);
  }));

test('Chỉ V2 → xoá ad V1, bật phần còn lại', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    await h.press(/Chỉ V2/);
    const ads = h.meta.of('ad');
    assert.equal(ads.length, 1);
    assert.match(ads[0].name, /V2$/);
    assert.equal(ads[0].effective_status, 'ACTIVE');
  }));

test('Sửa copy "nhấn mạnh in 2 mặt" → viết lại, ad trỏ sang bài mới, tin duyệt mới', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    const adsBefore = h.meta.of('ad').map((a) => ({ id: a.id, creative: a.creative.creative_id }));
    await h.press(/Sửa copy/);
    const ask = h.tg.sent('sendMessage').pop()!;
    assert.match(ask.body.text, /Sửa gì\?/);
    assert.equal(ask.body.reply_markup.force_reply, true);
    const askId = 1000 + h.tg.calls.filter((c) => c.method.startsWith('send')).length - 1;
    const r = await h.reply(askId, 'nhấn mạnh in 2 mặt');
    assert.equal(r.handled, true);
    assert.equal(h.copy.calls.length, 2);
    assert.equal(h.copy.calls[1].editFeedback, 'nhấn mạnh in 2 mặt');
    assert.equal(h.copy.calls[1].previous?.length, 2);
    const adsAfter = h.meta.of('ad');
    assert.equal(adsAfter.length, 2, 'giữ 2 ad, không tạo ad mới');
    for (const a of adsBefore) assert.notEqual(h.meta.objects.get(a.id)!.creative.creative_id, a.creative, 'ad đổi sang creative mới');
    const approvals = h.tg.sent('sendMessage').filter((m) => /CHỜ DUYỆT/.test(m.body.text));
    assert.equal(approvals.length, 2);
    assert.match(approvals[1].body.text, /both sides/);
    assert.ok(h.tg.calls.some((c) => c.method === 'editMessageText' && /đã thay bằng tin duyệt mới/.test(c.body.text)));
    // Nút của tin duyệt cũ không còn hiệu lực; nút tin mới bật được.
    await h.press(/Duyệt & chạy/);
    assert.ok(h.meta.of('ad').every((a) => a.effective_status === 'ACTIVE'));
  }));

test('#ADD vào camp có sẵn, Adset = mới → sao chép target + pixel, camp cũ không bị sửa', () =>
  withHarness(async (h) => {
    const camp = h.meta.seedCampaign({ id: '120248209112780436', name: 'Dân - CC - 3D Hoodie Raven - 01/11/2026' });
    h.meta.seedAdset({
      campaign_id: camp.id,
      name: 'src adset',
      targeting: { geo_locations: { countries: ['US', 'CA'] }, age_min: 25, targeting_automation: { advantage_audience: 0 } },
      promoted_object: { pixel_id: '625569536048355', custom_event_type: 'PURCHASE' },
      bid_amount: 1800,
      optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS',
    });
    await h.send(
      `#ADD\nTK: H3\nCamp: 120248209112780436\nAdset: mới\nPost ID:\nLink SP: https://firstnationslegacy.com/products/raven-spirit-3d-hoodie\nCreative: https://drive.google.com/file/d/FILE_ONE_VIDEO/view\nGhi chú copy:`,
    );
    const newAdset = h.meta.of('adset').find((a) => a.name !== 'src adset')!;
    assert.ok(newAdset, 'có adset mới');
    assert.deepEqual(newAdset.targeting, { geo_locations: { countries: ['US', 'CA'] }, age_min: 25, targeting_automation: { advantage_audience: 0 } });
    assert.deepEqual(newAdset.promoted_object, { pixel_id: '625569536048355', custom_event_type: 'PURCHASE' });
    assert.equal(Number(newAdset.bid_amount), 1800);
    assert.equal(newAdset.name, 'Dân - CC - 3D Hoodie Raven - 01/11/2026 - US, CA');
    assert.equal(h.meta.of('ad')[0].name, '3D Hoodie Raven - raven_hook - V1');
    assert.equal(h.meta.of('campaign').length, 1, 'không tạo campaign mới');
    await h.press(/Duyệt & chạy/);
    assert.ok(!h.meta.requests.some((r) => r.method === 'POST' && r.path === camp.id), 'campaign có sẵn không bị sửa');
    assert.equal(newAdset.effective_status, 'ACTIVE');
    assert.ok(h.meta.of('ad').every((a) => a.effective_status === 'ACTIVE'));
  }));

test('#ADD có Post ID → ad dùng đúng bài cũ, không gọi Claude, không tạo bài mới', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    const post = h.meta.of('creative')[0].effective_object_story_id;
    await h.press(/Duyệt & chạy/);
    const camp = h.meta.of('campaign')[0];
    const creativesBefore = h.meta.of('creative').length;
    const postsBefore = h.meta.of('post').length;
    await h.send(`#ADD\nTK: H3\nCamp: ${camp.id}\nAdset:\nPost ID: ${post}`);
    assert.equal(h.copy.calls.length, 1, 'không gọi Claude thêm lần nào');
    assert.equal(h.meta.of('post').length, postsBefore, 'không tạo bài mới');
    assert.equal(h.meta.of('creative').length, creativesBefore, 'dùng lại creative đã trỏ vào bài');
    const ads = h.meta.of('ad');
    assert.equal(ads.length, 3);
    const newAd = ads[2];
    assert.equal(h.meta.objects.get(newAd.creative.creative_id)!.effective_object_story_id, post);
    assert.equal(newAd.adset_id, h.meta.of('adset')[0].id, 'Adset trống = adset đang chạy đầu tiên');
  }));

test('Brief thiếu Link SP + sai Kiểu chạy → một tin liệt kê đủ 2 lỗi, không gọi Meta', () =>
  withHarness(async (h) => {
    const text = newBrief({ run: 'Autoo' }).replace(/Link SP: .*\n/, 'Link SP:\n');
    await h.send(text);
    assert.equal(h.meta.requests.length, 0);
    const msgs = h.tg.sent('sendMessage');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].body.text, /Thiếu trường bắt buộc: Link SP/);
    assert.match(msgs[0].body.text, /Kiểu chạy "Autoo"/);
  }));

test('Budget $400 → bắt buộc xác nhận lần 2; bấm xác nhận mới tạo', () =>
  withHarness(async (h) => {
    await h.send(newBrief({ budget: 400 }));
    assert.equal(h.meta.of('campaign').length, 0);
    assert.match(h.tg.lastText(), /xác nhận lần 2[\s\S]*Budget \$400/);
    await h.press(/vẫn tạo/);
    assert.equal(h.meta.of('campaign').length, 1);
    assert.equal(h.meta.of('campaign')[0].daily_budget, '40000');
  }));

test('Tổng budget các camp Agent quản lý > $1.500 → từ chối brief mới', () =>
  withHarness(async (h) => {
    h.deps.cfg.limits.budgetConfirmUsd = 10_000;
    await h.send(newBrief({ budget: 1000, product: 'A' }));
    await h.press(/Duyệt & chạy/);
    await h.send(newBrief({ budget: 600, product: 'B' }));
    assert.equal(h.meta.of('campaign').length, 1);
    assert.match(h.tg.lastText(), /vượt giới hạn \$1,500/);
  }));

test('Mức cap ngoài $5–$150 → hỏi lại; CC đặt bid_amount ở adset', () =>
  withHarness(async (h) => {
    await h.send(newBrief({ run: 'CC', cap: '300' }));
    assert.match(h.tg.lastText(), /Mức cap \$300/);
    await h.press(/vẫn tạo/);
    assert.equal(h.meta.of('campaign')[0].bid_strategy, 'COST_CAP');
    assert.equal(Number(h.meta.of('adset')[0].bid_amount), 30000);
  }));

test('Gửi trùng brief trong 10 phút → hỏi lại', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    await h.send(newBrief());
    assert.match(h.tg.lastText(), /giống brief #1/);
    assert.equal(h.meta.of('campaign').length, 1);
  }));

test('Tin từ tài khoản Telegram khác → im lặng, có dòng audit_log', () =>
  withHarness(async (h) => {
    await h.send(newBrief(), {}, 999);
    assert.equal(h.tg.calls.length, 0);
    const row = h.store.db.prepare(`SELECT * FROM audit_log WHERE action='ignored_chat'`).get() as { detail: string } | undefined;
    assert.ok(row);
    assert.match(row!.detail, /999/);
  }));

test('Meta từ chối lệnh tạo ad → dừng, xoá camp/adset vừa tạo, báo nguyên văn lỗi; /retry chạy tiếp không tạo bài trùng', () =>
  withHarness(async (h) => {
    h.meta.failWith = (m, p) =>
      m === 'POST' && p.endsWith('/ads') ? { message: 'Invalid parameter', code: 100, error_subcode: 1885183, error_user_title: 'Ad bị lỗi', error_user_msg: 'Page chưa liên kết' } : null;
    await h.send(newBrief());
    assert.equal(h.meta.of('campaign').length, 0, 'campaign đã xoá');
    assert.equal(h.meta.of('adset').length, 0, 'adset đã xoá');
    const msg = h.tg.lastText();
    assert.match(msg, /error\.message: Invalid parameter/);
    assert.match(msg, /error_user_msg: Page chưa liên kết/);
    assert.equal(h.store.getRequest(1)!.status, 'failed');
    const postsBefore = h.meta.of('post').length;

    h.meta.failWith = null;
    await h.send('/retry 1');
    assert.equal(h.store.getRequest(1)!.status, 'pending_approval');
    assert.equal(h.meta.of('campaign').length, 1);
    assert.equal(h.meta.of('ad').length, 2);
    assert.equal(h.meta.of('post').length, postsBefore, 'không tạo bài trùng trên Page');
    assert.equal(h.copy.calls.length, 1, 'không viết lại copy');
  }));

test('Token Meta hết hạn → dừng mọi brief, cảnh báo đỏ', () =>
  withHarness(async (h) => {
    h.meta.failWith = () => ({ message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 });
    await h.send(newBrief());
    assert.ok(h.runner.halted);
    assert.match(h.tg.lastText(), /TOKEN META HẾT HẠN/);
  }));

test('Link Drive không truy cập được → báo share cho service account, /retry chạy lại', () =>
  withHarness(async (h) => {
    h.drive.denied.add('FILE_ONE_VIDEO');
    await h.send(newBrief());
    assert.equal(h.store.getRequest(1)!.status, 'waiting');
    assert.match(h.tg.lastText(), /ads-agent@project\.iam\.gserviceaccount\.com/);
    h.drive.denied.clear();
    await h.send('/retry 1');
    assert.equal(h.store.getRequest(1)!.status, 'pending_approval');
  }));

test('Video tỷ lệ 4:5 được ghi nhận đúng và vẫn làm tiếp', () =>
  withHarness(async (h) => {
    await h.send(newBrief({ creative: 'FILE_45_VIDEO' }));
    assert.match(h.tg.sent('sendMessage').find((m) => /CHỜ DUYỆT/.test(m.body.text))!.body.text, /4:5 ✓/);
  }));

test('Server khởi động lại giữa chừng → chạy tiếp từ bước đã ghi', () =>
  withHarness(async (h) => {
    let release!: () => void;
    h.copy.gate = new Promise((r) => (release = r));
    void h.app.handleUpdate({ update_id: 99001, message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' }, text: newBrief() } });
    // chờ tới khi copy được gọi (đang "treo" như lúc mất điện)
    for (let i = 0; i < 200 && h.copy.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.store.getRequest(1)!.step, 'copy');
    // "Khởi động lại": Runner mới trên cùng DB, copy writer chạy bình thường.
    const h2 = h.restart();
    h2.copy.gate = null;
    const resumed = resumeUnfinished(h2.store, h2.runner);
    assert.deepEqual(resumed, [1]);
    await h2.runner.idle();
    assert.equal(h2.store.getRequest(1)!.status, 'pending_approval');
    assert.equal(h.meta.of('campaign').length, 1);
    release();
  }));

test('Chưa duyệt sau 24 giờ → nhắc một lần; sau 72 giờ → tự huỷ và xoá object PAUSED', () =>
  withHarness(async (h) => {
    await h.send(newBrief());
    const sent = new Date(h.store.getRequest(1)!.approval_sent_at!).getTime();
    await approvalSweep(h.deps, new Date(sent + 25 * 3600_000));
    assert.match(h.tg.lastText(), /chờ duyệt đã 25 giờ/);
    const n = h.tg.calls.length;
    await approvalSweep(h.deps, new Date(sent + 26 * 3600_000));
    assert.equal(h.tg.calls.length, n, 'chỉ nhắc một lần');
    await approvalSweep(h.deps, new Date(sent + 73 * 3600_000));
    assert.equal(h.store.getRequest(1)!.status, 'cancelled');
    assert.equal(h.meta.of('ad').length, 0);
    assert.equal(h.meta.of('campaign').length, 0);
  }));

test('Sản phẩm không ACTIVE → dừng trước khi tạo gì trên Meta', () =>
  withHarness(async (h) => {
    h.shopify.status = 'DRAFT';
    await h.send(newBrief());
    assert.equal(h.meta.requests.filter((r) => r.method === 'POST').length, 0);
    assert.match(h.tg.lastText(), /DRAFT/);
  }));

test('HTTP nội bộ của Agent: thiếu / sai X-Bridge-Key → 401; đúng key → xử lý update', () =>
  withHarness(async (h) => {
    const { buildAgentServer, listen } = await import('../src/agent/server.ts');
    const srv = await listen(buildAgentServer(h.app, h.deps), 0);
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const post = (key: string | null, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/brief`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'x-bridge-key': key } : {}) },
        body: JSON.stringify(body),
      });
    assert.equal((await post(null, {})).status, 401);
    assert.equal((await post('wrong-key-0123456789abcdefghij', {})).status, 401);
    const update = { update_id: 4242, message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' }, text: 'chào' } };
    const r = await post(h.cfg.bridgeKey, update);
    assert.deepEqual(await r.json(), { ok: true, handled: false }, 'tin tự do không phải của Agent → handled=false');
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-bridge-key': h.cfg.bridgeKey } });
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
    await new Promise((r) => srv.close(() => r(undefined)));
  }));
