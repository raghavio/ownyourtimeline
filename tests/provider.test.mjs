import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const output = await build({ entryPoints: ['src/provider.ts'], bundle: true, write: false, format: 'esm', platform: 'node', define: { __DEV__: 'false' } });
const { parseAnswer, safeMediaUrl, imageLayout, plan, MODEL } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

const answer = noul => ({ model: MODEL, answers: { hide_0: { type: 'noul', noul } }, usage: { input_tokens: 4, output_tokens: 1 } });
const post = (text, extra = {}) => ({ id: '1', text, quotedText: '', media: [], fingerprint: text, ...extra });
const image = { kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg', alt: '' };

test('answers must be a finite probability from the pinned model with usage', () => {
  assert.equal(parseAnswer(answer(.94)), .94);
  for (const p of [NaN, Infinity, -1, 1.1, '0.99', undefined]) assert.throws(() => parseAnswer(answer(p)));
  assert.throws(() => parseAnswer({ ...answer(1), model: 'other' }));
  assert.throws(() => parseAnswer({ ...answer(1), usage: {} }));
  assert.throws(() => parseAnswer(answer(.5), 'hide_1'));
});

test('media fetches are restricted to X image paths on pbs.twimg.com', () => {
  assert.ok(safeMediaUrl('https://pbs.twimg.com/media/example.jpg'));
  assert.ok(safeMediaUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg'));
  for (const url of ['http://pbs.twimg.com/media/a', 'https://pbs.twimg.com.evil.com/media/a', 'https://user@pbs.twimg.com/media/a',
    'https://pbs.twimg.com:8443/media/a', 'https://pbs.twimg.com/profile_images/a', 'file:///etc/passwd', 'not a url']) {
    assert.equal(safeMediaUrl(url), false, url);
  }
});

test('images are scaled to 1280px and padded to 384px without stretching or cropping', () => {
  assert.deepEqual(imageLayout(200, 1280), { width: 384, height: 1280, contentWidth: 200, contentHeight: 1280, x: 92, y: 0 });
  assert.deepEqual(imageLayout(16, 16), { width: 384, height: 384, contentWidth: 16, contentHeight: 16, x: 184, y: 184 });
  assert.deepEqual(imageLayout(2560, 1440), { width: 1280, height: 720, contentWidth: 1280, contentHeight: 720, x: 0, y: 0 });
  for (const dimensions of [[0, 1], [1, 0], [NaN, 2], [Infinity, 2], [10000, 10000]]) assert.throws(() => imageLayout(...dimensions));
});

test('a normal response becomes one bulk request', () => {
  const { groups, results } = plan(Array.from({ length: 20 }, (_, i) => post(`Post ${i}`)), 'Nothing political');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 20);
  assert.equal(results.filter(Boolean).length, 0);
});

test('unclassifiable posts fail open individually instead of sinking the batch', () => {
  const tweets = [post('ok'), post('partial', { incomplete: true }), post('gallery', { media: Array(9).fill(image) }),
    post('x'.repeat(30000)), post('also ok')];
  const { groups, results } = plan(tweets, 'Nothing political');
  assert.deepEqual(groups.flat().map(entry => entry.index), [0, 4]);
  assert.equal(results[1].error.code, 'incomplete-content');
  assert.equal(results[2].error.code, 'incomplete-media');
  assert.equal(results[3].error.code, 'context-limit');
});

test('groups split on the context budget and the eight-image cap, preserving order', () => {
  const long = Array.from({ length: 12 }, (_, i) => post(`${i} ${'y'.repeat(4000)}`));
  const byText = plan(long, 'Nothing political').groups;
  assert.ok(byText.length > 1);
  assert.deepEqual(byText.flat().map(entry => entry.index), long.map((_, i) => i));
  const pictures = Array.from({ length: 5 }, () => post('pics', { media: [image, image, image] }));
  assert.deepEqual(plan(pictures, 'No memes').groups.map(group => group.length), [2, 2, 1]);
});
