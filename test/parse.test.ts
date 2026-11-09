import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief, parseMoney, parseDriveLink, parseCountries, parseStartDate, briefFingerprint } from '../src/agent/brief/parse.ts';

const ctx = {
  accountNames: ['H3'],
  pageId: '101065259399535',
  shopDomain: 'firstnationslegacy.com',
  timezone: 'America/Dawson',
  now: new Date('2026-11-07T10:00:00Z'), // 03:00 ngày 07/11 giờ Dawson
};

const NEW_OK = `#NEW
TK: H3
Kiểu chạy: Auto
Mức cap ($):
Sản phẩm: 3D Hoodie Raven
Link SP: https://firstnationslegacy.com/products/raven-3d-hoodie?variant=1
Creative: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing
Quốc gia: US, ca
Budget/ngày ($): 50
Ngày chạy: hôm nay
Ghi chú copy:`;

test('#NEW hợp lệ được chuẩn hoá đầy đủ', () => {
  const r = parseBrief(NEW_OK, ctx);
  assert.deepEqual(r.errors, []);
  const b = r.brief!;
  assert.equal(b.type, 'NEW');
  if (b.type !== 'NEW') return;
  assert.equal(b.runType, 'Auto');
  assert.equal(b.capUsd, null);
  assert.equal(b.product, '3D Hoodie Raven');
  assert.equal(b.productHandle, 'raven-3d-hoodie');
  assert.equal(b.productUrl, 'https://firstnationslegacy.com/products/raven-3d-hoodie');
  assert.deepEqual(b.creative, { kind: 'file', id: '1AbCdEfGhIjKlMnOpQrStUv', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing' });
  assert.deepEqual(b.countries, ['US', 'CA']);
  assert.equal(b.budgetUsd, 50);
  assert.equal(b.startDate, null);
});

test('tên trường không phân biệt hoa thường / dấu, bỏ qua dòng trống', () => {
  const text = `#new\n\ntk: h3\nKIEU CHAY: cc\nmuc cap: 12,5\nsan pham: Jersey Eagle\nlink sp: https://www.firstnationslegacy.com/products/eagle-jersey\ncreative: https://drive.google.com/drive/folders/1FolderIdAbcdefghij\nquoc gia: us\nbudget/ngay: $80\nngay chay: 09/11`;
  const r = parseBrief(text, ctx);
  assert.deepEqual(r.errors, []);
  const b = r.brief!;
  if (b.type !== 'NEW') throw new Error('sai loại');
  assert.equal(b.account, 'H3');
  assert.equal(b.runType, 'CC');
  assert.equal(b.capUsd, 12.5);
  assert.equal(b.creative.kind, 'folder');
  assert.deepEqual(b.startDate, { y: 2026, m: 11, d: 9 });
});

test('checklist: thiếu Link SP và sai Kiểu chạy → một danh sách đủ 2 lỗi', () => {
  const text = NEW_OK.replace('Kiểu chạy: Auto', 'Kiểu chạy: Autoo').replace(/Link SP: .*\n/, 'Link SP:\n');
  const r = parseBrief(text, ctx);
  assert.equal(r.brief, null);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join('\n'), /Thiếu trường bắt buộc: Link SP/);
  assert.match(r.errors.join('\n'), /Kiểu chạy "Autoo" không hợp lệ/);
});

test('CC/BidCap thiếu mức cap → lỗi; TK lạ → liệt kê tên hợp lệ', () => {
  const r = parseBrief(NEW_OK.replace('Kiểu chạy: Auto', 'Kiểu chạy: BidCap').replace('TK: H3', 'TK: H9'), ctx);
  assert.match(r.errors.join('\n'), /BidCap cần Mức cap/);
  assert.match(r.errors.join('\n'), /Tên hợp lệ: H3/);
});

test('link SP khác tên miền shop, mã quốc gia lạ, ngày đã qua', () => {
  const text = NEW_OK.replace('https://firstnationslegacy.com/products/raven-3d-hoodie?variant=1', 'https://evil.com/products/x')
    .replace('US, ca', 'US, XX')
    .replace('hôm nay', '01/11');
  const r = parseBrief(text, ctx);
  const all = r.errors.join('\n');
  assert.match(all, /thuộc firstnationslegacy.com/);
  assert.match(all, /Mã quốc gia không hợp lệ: XX/);
  assert.match(all, /đã qua/);
});

test('tên sản phẩm > 40 ký tự bị cắt kèm cảnh báo', () => {
  const long = 'A'.repeat(50);
  const r = parseBrief(NEW_OK.replace('3D Hoodie Raven', long), ctx);
  assert.equal(r.brief?.type === 'NEW' && r.brief.product.length, 40);
  assert.match(r.warnings.join(), /đã cắt còn 40/);
});

test('#ADD với Post ID: không cần Link SP / Creative; Post ID khác Page bị từ chối', () => {
  const ok = parseBrief(`#ADD\nTK: H3\nCamp: 120248209112780436\nAdset: mới\nPost ID: 101065259399535_111, 101065259399535_222`, ctx);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.brief?.type, 'ADD');
  if (ok.brief?.type !== 'ADD') return;
  assert.deepEqual(ok.brief.adset, { mode: 'new' });
  assert.deepEqual(ok.brief.postIds, ['101065259399535_111', '101065259399535_222']);

  const bad = parseBrief(`#ADD\nTK: H3\nCamp: 1202\nPost ID: 999_111`, ctx);
  assert.match(bad.errors.join(), /không thuộc Page/);
});

test('#ADD không có Post ID thì bắt buộc Link SP + Creative; Adset trống = auto', () => {
  const r = parseBrief(`#ADD\nTK: H3\nCamp: Raven\nAdset:\nPost ID:`, ctx);
  assert.match(r.errors[0], /Thiếu trường bắt buộc: Link SP, Creative/);
  const r2 = parseBrief(
    `#ADD\nTK: H3\nCamp: Raven\nLink SP: https://firstnationslegacy.com/products/raven\nCreative: https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQr\nGhi chú copy: nhấn mạnh in 2 mặt\nthêm dòng thứ hai`,
    ctx,
  );
  assert.deepEqual(r2.errors, []);
  if (r2.brief?.type !== 'ADD') return;
  assert.deepEqual(r2.brief.adset, { mode: 'auto' });
  assert.equal(r2.brief.creative?.kind, 'unknown');
  assert.equal(r2.brief.copyNote, 'nhấn mạnh in 2 mặt\nthêm dòng thứ hai');
});

test('parseMoney', () => {
  assert.equal(parseMoney('50'), 50);
  assert.equal(parseMoney('$12,5'), 12.5);
  assert.equal(parseMoney('12.75'), 12.75);
  assert.equal(parseMoney('1.500'), 1500);
  assert.equal(parseMoney('0'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-5'), null);
});

test('parseDriveLink nhận các dạng link phổ biến', () => {
  assert.equal(parseDriveLink('https://drive.google.com/drive/u/0/folders/1FolderIdAbcdefghij?usp=drive_link')?.kind, 'folder');
  assert.equal(parseDriveLink('https://drive.google.com/file/d/1FileIdAbcdefghijk/view')?.id, '1FileIdAbcdefghijk');
  assert.equal(parseDriveLink('https://dropbox.com/x'), null);
});

test('parseCountries: UK → GB, bỏ trùng', () => {
  assert.deepEqual(parseCountries('us, UK; us gb'), { codes: ['US', 'GB'], bad: [] });
});

test('parseStartDate: hôm nay theo giờ tài khoản', () => {
  // 2026-11-08T05:00Z = 22:00 ngày 07/11 giờ Dawson → "07/11" là hôm nay
  assert.equal(parseStartDate('07/11', 'America/Dawson', new Date('2026-11-08T05:00:00Z')), null);
  assert.throws(() => parseStartDate('31/02', 'America/Dawson', ctx.now), /không tồn tại/);
});

test('briefFingerprint bỏ khác biệt hoa thường / khoảng trắng', () => {
  assert.equal(briefFingerprint('#NEW\nTK: H3\n\nSản phẩm: X'), briefFingerprint('#new\ntk:  h3\nSan pham: x'));
});
