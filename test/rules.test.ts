import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVariant, countEmoji, hasAllCapsSentence, type CopyVariant } from '../src/agent/copy/rules.ts';

const good: CopyVariant = {
  style: 'first_person_story',
  headline: 'For the Man Drawn to the Wild',
  primary_text:
    "People think I'm crazy for wearing my Native hoodie everywhere…\nBut this black-and-red raven wraps all the way around the back.\nPrinted on both sides, so it turns heads coming and going.\nTap to see it and pick your size 👇",
  description: 'Printed front and back',
  reason: 'Video có người mặc thật nên kể chuyện ngôi thứ nhất.',
};
const page = { pageText: 'Raven Hoodie. Buy 5 Get 2 Free on all hoodies. Sizes S–5XL.' };

test('phương án mẫu đạt mọi quy tắc', () => {
  assert.deepEqual(checkVariant(good, page), []);
});

test('bắt các từ bị cấm theo Indian Arts and Crafts Act', () => {
  const cases = [
    'An authentic design for you',
    'Native-made with love',
    'Made by Native artists in Arizona',
    'Handcrafted by an Indigenous artisan',
    'A tribal-made classic',
    'Inspired by Navajo patterns',
    'Proudly Native-owned shop',
    'Every purchase supports Native communities',
  ];
  for (const c of cases) {
    const issues = checkVariant({ ...good, primary_text: `${c}\n${good.primary_text}` }, page);
    assert.ok(issues.some((i) => /cấm|bộ tộc|gợi ý/.test(i)), `phải bắt: ${c} → ${issues.join(' | ')}`);
  }
});

test('cụm được phép không bị bắt nhầm', () => {
  const ok = [
    'A Native-inspired raven for everyday wear',
    'Inspired by Native American art, drawn in bold red',
    'A Pacific Northwest–inspired eagle',
    'The crow and the raven sit side by side', // "crow" là con quạ, không phải tên bộ tộc
    'Sold across North Dakota and beyond',
  ];
  for (const c of ok) {
    const issues = checkVariant({ ...good, primary_text: `${c}\n${good.primary_text}` }, page);
    assert.deepEqual(issues, [], `không được bắt: ${c}`);
  }
});

test('ưu đãi chỉ dùng khi trang sản phẩm có ghi', () => {
  const withOffer = { ...good, primary_text: good.primary_text + '\nBuy 5 Get 2 Free today.' };
  assert.deepEqual(checkVariant(withOffer, page), []);
  const invented = { ...good, primary_text: good.primary_text.replace('Tap to see', '20% off, ends tonight. Tap to see') };
  const issues = checkVariant(invented, page);
  assert.ok(issues.some((i) => /giảm giá %/.test(i)));
  assert.ok(issues.some((i) => /hạn chót/.test(i)));
});

test('sức khoẻ / tâm linh, IN HOA, emoji', () => {
  assert.ok(checkVariant({ ...good, primary_text: good.primary_text + '\nThis hoodie protects you from bad energy.' }, page).length);
  assert.ok(checkVariant({ ...good, primary_text: good.primary_text + '\nBUY YOURS NOW BEFORE IT IS GONE' }, page).some((i) => /IN HOA/.test(i)));
  assert.ok(checkVariant({ ...good, description: 'Soft 🔥🔥🔥' }, page).some((i) => /emoji/.test(i)));
  assert.equal(countEmoji('🦅 Raven 👇 ❤️'), 3);
  assert.equal(hasAllCapsSentence('100% Customized with your name!'), null);
});

test('cấu trúc: headline 4–7 từ ≤ 40 ký tự, 3–6 dòng, description < 30', () => {
  const bad = { ...good, headline: 'Raven', primary_text: 'One line only', description: 'This description is far too long to fit' };
  const issues = checkVariant(bad, page);
  assert.ok(issues.some((i) => /headline có 1 từ/.test(i)));
  assert.ok(issues.some((i) => /primary_text có 1 dòng/.test(i)));
  assert.ok(issues.some((i) => /description dài/.test(i)));
});
