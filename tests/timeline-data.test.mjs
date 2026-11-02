import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { networkBody } from './fixtures.mjs';
const output = await build({ entryPoints: ['src/timeline-data.ts'], bundle: true, write: false, format: 'esm' });
const { timelineCandidates, tweetInput, tweetCard } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

test('response adapter removes only candidates and preserves native cursors/modules', () => {
  const body = networkBody([{ id: '101', text: 'First' }, { id: '102', text: 'Second' }]);
  const entries = body.data.home.home_timeline_urt.instructions[0].entries;
  const module = { entryId: 'module', content: { entryType: 'TimelineTimelineModule' } };
  entries.push(module);
  const candidates = timelineCandidates(body);
  assert.equal(candidates.length, 2);
  candidates[0].remove(); candidates[1].remove(); candidates[0].remove();
  assert.deepEqual(entries, [{ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'next-fixture-page' } }, module]);
});
test('response adapter extracts quote/media/note data and recognizes incomplete quotes', () => {
  const body = networkBody([{ id: '101', text: 'Link', note: 'Full long note', quote: 'Quoted text', media: true }]);
  const input = timelineCandidates(body)[0].input;
  assert.equal(input.text, 'Full long note');
  assert.equal(input.quotedText, 'Quoted text');
  assert.equal(input.media.length, 2);
  assert.equal(input.incomplete, false);
  const incomplete = tweetInput({ __typename: 'Tweet', rest_id: '102', legacy: { full_text: 'Quote unavailable', is_quote_status: true } });
  assert.equal(incomplete.incomplete, true);
  assert.deepEqual(incomplete.incompleteReasons, [{ reason: 'quoted-post-unavailable', depth: 0 }]);
});
test('incomplete inputs preserve exact reasons, quote depths and media indices', () => {
  const raw = { __typename: 'Tweet', rest_id: '103', legacy: { full_text: 'Partial text', truncated: true,
    extended_entities: { media: [{ type: 'photo' }, { type: 'mystery', media_url_https: 'https://pbs.twimg.com/media/a' }] } },
    quoted_status_result: { result: { __typename: 'Tweet', rest_id: '104', legacy: {} } } };
  const input = tweetInput(raw);
  assert.deepEqual(input.incompleteReasons, [
    { reason: 'truncated-without-full-note', depth: 0 },
    { reason: 'missing-media-url', depth: 0, mediaIndex: 0 },
    { reason: 'unsupported-media-type', depth: 0, mediaIndex: 1 },
    { reason: 'missing-text', depth: 1 },
  ]);
});

test('nested quote payloads supply their text, long notes and media instead of false incomplete flags', () => {
  const nested = { __typename: 'Tweet', rest_id: '203', legacy: { full_text: 'Nested text', is_quote_status: false,
    extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/nested.jpg' }] } } };
  const quote = { __typename: 'Tweet', rest_id: '202', legacy: { full_text: 'Short note', is_quote_status: true },
    note_tweet: { note_tweet_results: { result: { text: 'Full quote note' } } },
    nested_quoted_tweet_results: { result: nested }, quotedRefResult: { result: { __typename: 'Tweet', rest_id: '203' } } };
  const root = { __typename: 'Tweet', rest_id: '201', legacy: { full_text: 'Main post', is_quote_status: true }, quoted_status_result: { result: quote } };
  const input = tweetInput(root);
  assert.equal(input.incomplete, false);
  assert.equal(input.quotedText, 'Full quote note\nNested text');
  assert.equal(input.media[0].url, 'https://pbs.twimg.com/media/nested.jpg');
});

test('visibility wrapper may omit inner typename without discarding a valid quoted post', () => {
  const inner = { rest_id: '302', legacy: { full_text: 'Wrapped quote', is_quote_status: false } };
  const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: inner };
  const root = { __typename: 'Tweet', rest_id: '301', legacy: { full_text: 'Main', is_quote_status: true }, quoted_status_result: { result: wrapped } };
  assert.equal(tweetInput(root).incomplete, false);
  assert.equal(tweetInput(root).quotedText, 'Wrapped quote');
  assert.equal(tweetCard(root).quote.text, 'Wrapped quote');
  assert.equal(tweetInput(wrapped).text, 'Wrapped quote');
  assert.equal(tweetInput(inner), null); // Do not accept arbitrary untyped root objects.
  assert.equal(tweetInput({ __typename: 'TweetWithVisibilityResults', tweet: { __typename: 'TweetUnavailable', ...inner } }), null);
});

test('ID-only reference at an embedded quote leaf is disclosed, but missing inline quotes still fail explicitly', () => {
  const leaf = { __typename: 'Tweet', rest_id: '403', legacy: { full_text: 'Embedded leaf', is_quote_status: true, quoted_status_id_str: '404' },
    quotedRefResult: { result: { __typename: 'Tweet', rest_id: '404' } } };
  const quote = { __typename: 'Tweet', rest_id: '402', legacy: { full_text: 'Immediate quote', is_quote_status: true }, nested_quoted_tweet_results: { result: leaf } };
  const root = { __typename: 'Tweet', rest_id: '401', legacy: { full_text: 'Main', is_quote_status: true }, quoted_status_result: { result: quote } };
  const input = tweetInput(root);
  assert.equal(input.incomplete, false);
  assert.match(input.context, /post 404; that link target is not embedded and was not fetched/);
  assert.equal(input.quotedText, 'Immediate quote\nEmbedded leaf');
  assert.equal(tweetInput(leaf).incomplete, true); // The same reference is insufficient as a root's inline quote.
  const mismatch = structuredClone(root);
  mismatch.quoted_status_result.result.nested_quoted_tweet_results.result.quotedRefResult.result.rest_id = '405';
  assert.deepEqual(tweetInput(mismatch).incompleteReasons, [{ reason: 'quoted-post-unavailable', depth: 2 }]);
  const deeper = structuredClone(root);
  deeper.quoted_status_result.result.nested_quoted_tweet_results.result.nested_quoted_tweet_results = {
    result: { __typename: 'Tweet', rest_id: '404', legacy: { full_text: 'Another actual embedded post' } },
  };
  assert.deepEqual(tweetInput(deeper).incompleteReasons, [{ reason: 'quote-depth-limit', depth: 2 }]);
});

test('card snapshots include original author, media streams and counts without polluting classifier inputs', () => {
  const body = networkBody([{ id: '101', text: 'Photo', media: true, quote: 'Quote text', author: { name: 'Reporter Example', handle: 'reporter' } }]);
  const candidate = timelineCandidates(body)[0];
  const card = candidate.card();
  assert.equal(card.author.name, 'Reporter Example');
  assert.equal(card.author.handle, 'reporter');
  assert.equal(card.author.verified, true);
  assert.equal(card.quote.author.name, 'Quoted Author');
  assert.equal(card.media[1].videoUrl, 'https://video.twimg.com/ext_tw_video/fixture.mp4');
  assert.equal(card.counts.likes, 1234);
  assert.equal(card.counts.views, 15300);
  assert.equal('author' in candidate.input, false);
  assert.equal(candidate.input.fingerprint.includes('Reporter Example'), false);
  assert.equal(tweetCard({ __typename: 'TweetUnavailable' }), null);
});

test('response adapter skips unknown and unavailable result shapes without mutation', () => {
  for (const body of [{}, null, { data: { home: {} } }]) assert.deepEqual(timelineCandidates(body), []);
  assert.equal(tweetInput({ __typename: 'TweetUnavailable' }), null);
  assert.equal(tweetInput({ __typename: 'Tweet', rest_id: 'invalid', legacy: { full_text: 'Text' } }), null);
});
