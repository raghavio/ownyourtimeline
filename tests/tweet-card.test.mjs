import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['src/tweet-card.ts'], bundle: true, write: false, format: 'esm' });
const { sanitizeCard, safeCardUrl } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

test('card resource URLs reject unsafe protocols, credentials and unapproved hosts', () => {
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,bad', 'https://user:secret@pbs.twimg.com/media/image.jpg', 'https://pbs.twimg.com.evil.test/media/image.jpg', 'https://pbs.twimg.com:123/media/image.jpg']) {
    assert.equal(safeCardUrl(value, 'image'), undefined);
  }
  assert.equal(safeCardUrl('https://video.twimg.com/ext_tw_video/fixture.mp4', 'video'), 'https://video.twimg.com/ext_tw_video/fixture.mp4');
  assert.equal(safeCardUrl('https://example.com/tracker.mp4', 'video'), undefined);
  assert.equal(safeCardUrl('https://example.com/post', 'link'), 'https://example.com/post');
});
test('card snapshots sanitize untrusted metadata, bound nesting, and preserve text verbatim', () => {
  const card = sanitizeCard({ id: '123', text: '<img src=x onerror=bad()>', author: { name: '<script>name</script>', handle: 'bad/handle', avatar: 'javascript:bad()', verified: 'true' },
    createdAt: 'not a date', counts: { likes: -1, views: Infinity, replies: 12.8 },
    links: [{ url: 'https://t.co/example', expandedUrl: 'javascript:bad()', displayUrl: 'bad' }], hiddenUrls: [],
    media: [{ kind: 'image', url: 'https://evil.test/tracker.jpg' }, { kind: 'video', url: 'https://pbs.twimg.com/media/preview.jpg', videoUrl: 'https://evil.test/movie.mp4', alt: '<img>' }],
    quote: { id: '124', text: 'Quote', media: [], quote: { id: '125', text: 'Too deep' } },
  });
  assert.equal(card.text, '<img src=x onerror=bad()>');
  assert.equal(card.author.handle, '');
  assert.equal(card.author.avatar, undefined);
  assert.equal(card.author.verified, false);
  assert.equal(card.createdAt, undefined);
  assert.deepEqual(card.counts, { replies: 12 });
  assert.equal(card.links.length, 0);
  assert.equal(card.media.length, 1);
  assert.equal(card.media[0].videoUrl, undefined);
  assert.equal(card.quote.quote, undefined);
  assert.equal(sanitizeCard({ id: 'javascript:bad()', text: 'Bad' }), null);
});
