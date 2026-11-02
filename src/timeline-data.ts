import type { TweetCard, TweetCardMedia, TweetInput, TweetMedia } from './shared';

type ObjectValue = Record<string, any>;
function object(value: unknown): ObjectValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}
function tweet(value: unknown, depth = 0): ObjectValue | null {
  if (depth > 8) return null;
  const result = object(value);
  if (result?.__typename === 'TweetWithVisibilityResults') {
    const inner = object(result.tweet);
    // X omits __typename on some inline TweetWithVisibilityResults.tweet
    // objects. Accept this only inside the explicit wrapper, not arbitrary data.
    if (inner && inner.__typename === undefined && typeof inner.rest_id === 'string' && object(inner.legacy)) return inner;
    return tweet(inner, depth + 1);
  }
  return result?.__typename === 'Tweet' ? result : null;
}
function quotedTweet(item: ObjectValue): { raw: unknown; value: ObjectValue } | null {
  for (const raw of [item.quoted_status_result?.result, item.nested_quoted_tweet_results?.result]) {
    const value = tweet(raw);
    if (value && object(value.legacy)) return { raw, value };
  }
  return null;
}

export function tweetInput(raw: unknown): TweetInput | null {
  const outer = tweet(raw);
  if (!outer || !/^\d+$/.test(outer.rest_id)) return null;
  const main = tweet(outer.legacy?.retweeted_status_result?.result) ?? outer;
  const media: TweetMedia[] = [];
  let incomplete = false;
  const incompleteReasons: NonNullable<TweetInput['incompleteReasons']> = [];
  const quoteBoundaryNotes: string[] = [];
  const mark = (reason: string, depth: number, mediaIndex?: number) => {
    incomplete = true; incompleteReasons.push({ reason, depth, ...(mediaIndex === undefined ? {} : { mediaIndex }) });
  };
  function extract(item: ObjectValue, depth: number): { text: string; quote: string } {
    const legacy = object(item.legacy);
    const note = item.note_tweet?.note_tweet_results?.result?.text;
    const text = typeof note === 'string' ? note : legacy?.full_text;
    if (typeof text !== 'string') { mark('missing-text', depth); return { text: '', quote: '' }; }
    if (legacy?.truncated && typeof note !== 'string') mark('truncated-without-full-note', depth);
    const assets = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
    if (!Array.isArray(assets)) { mark('invalid-media-list', depth); return { text, quote: '' }; }
    for (const [mediaIndex, asset] of assets.entries()) {
      const url = asset?.media_url_https;
      if (typeof url !== 'string') { mark('missing-media-url', depth, mediaIndex); continue; }
      const kind = asset.type === 'photo' ? 'image' : ['video', 'animated_gif'].includes(asset.type) ? 'video-thumbnail' : null;
      if (!kind) { mark('unsupported-media-type', depth, mediaIndex); continue; }
      if (!media.some(existing => existing.url === url)) media.push({ kind, url, alt: typeof asset.ext_alt_text === 'string' ? asset.ext_alt_text : '' });
    }
    const quoted = quotedTweet(item);
    if (!quoted && legacy?.is_quote_status) {
      const ref = tweet(item.quotedRefResult?.result);
      // At the embedded chain's leaf, X supplies an ID-only link to another
      // post, not another inline card. Treat it like any other unfetched link:
      // classify all embedded evidence and disclose the boundary in context.
      // Missing first/second-level inline quotes still fail open explicitly.
      const referenceOnly = depth >= 2 && ref && !ref.legacy && /^\d+$/.test(ref.rest_id)
        && ref.rest_id === legacy.quoted_status_id_str;
      if (referenceOnly) quoteBoundaryNotes.push(`Embedded quote at depth ${depth} links to post ${ref.rest_id}; that link target is not embedded and was not fetched.`);
      else mark('quoted-post-unavailable', depth);
    }
    if (!quoted) return { text, quote: '' };
    if (depth >= 2) { mark('quote-depth-limit', depth); return { text, quote: '' }; }
    const child = extract(quoted.value, depth + 1);
    return { text, quote: [child.text, child.quote].filter(Boolean).join('\n') };
  }
  const extracted = extract(main, 0);
  const input = { id: outer.rest_id as string, text: extracted.text, quotedText: extracted.quote, media, incomplete, ...(incompleteReasons.length ? { incompleteReasons } : {}), context: [main !== outer ? 'Reposted post' : '', ...quoteBoundaryNotes].filter(Boolean).join('\n') };
  if (!input.text && !media.length || input.text.length > 30000 || input.quotedText.length > 30000 || media.length > 32) return null;
  const fingerprint = JSON.stringify(input);
  // Keep unsupported oversized entries out of the relay; one malformed entry
  // must not invalidate the rest of a bulk request at the worker boundary.
  if (input.id.length > 512 || fingerprint.length > 100000
    || media.some(asset => asset.url.length > 4096 || asset.alt.length > 2048)) return null;
  return { ...input, fingerprint };
}

export function tweetCard(raw: unknown, depth = 0): TweetCard | null {
  const outer = tweet(raw);
  if (!outer || !/^\d+$/.test(outer.rest_id)) return null;
  const main = tweet(outer.legacy?.retweeted_status_result?.result) ?? outer;
  const legacy = object(main.legacy) ?? {};
  const user = object(main.core?.user_results?.result) ?? {};
  const userCore = object(user.core) ?? object(user.legacy) ?? {};
  const rawText = main.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text;
  if (typeof rawText !== 'string') return null;
  const media: TweetCardMedia[] = [];
  const hiddenUrls: string[] = [];
  const assets = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  if (Array.isArray(assets)) for (const asset of assets.slice(0, 8)) {
    if (typeof asset?.media_url_https !== 'string') continue;
    const kind = asset.type === 'photo' ? 'image' : ['video', 'animated_gif'].includes(asset.type) ? 'video' : null;
    if (!kind) continue;
    const variants = Array.isArray(asset.video_info?.variants) ? asset.video_info.variants : [];
    const videos = variants.filter((variant: ObjectValue) => variant?.content_type === 'video/mp4' && typeof variant.url === 'string');
    // Prefer a modest MP4 stream; do not preload full video assets in the panel.
    const sorted = [...videos].sort((a, b) => (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0));
    const video = sorted.find(variant => Number(variant.bitrate) >= 256000) ?? sorted[0];
    media.push({ kind, url: asset.media_url_https, alt: typeof asset.ext_alt_text === 'string' ? asset.ext_alt_text : '',
      width: Number(asset.original_info?.width ?? asset.sizes?.large?.w) || undefined,
      height: Number(asset.original_info?.height ?? asset.sizes?.large?.h) || undefined,
      ...(video ? { videoUrl: video.url } : {}) });
    if (typeof asset.url === 'string') hiddenUrls.push(asset.url);
  }
  const count = (value: unknown) => value !== undefined && value !== null && /^\d+$/.test(String(value)) ? Math.min(Number(value), Number.MAX_SAFE_INTEGER) : undefined;
  const urls = main.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? legacy.entities?.urls ?? [];
  const links: TweetCard['links'] = Array.isArray(urls) ? urls.slice(0, 32).flatMap((url: ObjectValue) =>
    typeof url?.url === 'string' && typeof url.expanded_url === 'string' ? [{ url: url.url, expandedUrl: url.expanded_url, displayUrl: typeof url.display_url === 'string' ? url.display_url : url.expanded_url }] : []) : [];
  const quote = depth < 1 ? tweetCard(quotedTweet(main)?.raw, depth + 1) : null;
  const reposter = outer.core?.user_results?.result;
  const reposterName = reposter?.core?.name ?? reposter?.legacy?.name;
  return { id: String(main.rest_id), text: rawText.slice(0, 30000), author: {
    name: String(userCore.name ?? user.legacy?.name ?? 'X user').slice(0, 200),
    handle: String(userCore.screen_name ?? user.legacy?.screen_name ?? '').slice(0, 50),
    avatar: typeof user.avatar?.image_url === 'string' ? user.avatar.image_url : user.legacy?.profile_image_url_https,
    verified: user.is_blue_verified === true || user.legacy?.verified === true,
  }, createdAt: typeof legacy.created_at === 'string' ? legacy.created_at : undefined,
    ...(main !== outer ? { context: typeof reposterName === 'string' ? `${reposterName} reposted` : 'Reposted' } : {}),
    media, links, hiddenUrls, counts: { replies: count(legacy.reply_count), reposts: count(legacy.retweet_count),
      likes: count(legacy.favorite_count), views: count(main.views?.count), bookmarks: count(legacy.bookmark_count) },
    ...(quote ? { quote } : {}),
  };
}

// Only direct tweet items in known Home instruction shapes are edited. Unknown
// modules/instructions are preserved, never partially guessed at or flattened.
export function timelineCandidates(body: unknown): Array<{ input: TweetInput; card: () => TweetCard | null; remove: () => void }> {
  const instructions = object(body)?.data?.home?.home_timeline_urt?.instructions;
  if (!Array.isArray(instructions)) return [];
  const candidates: Array<{ input: TweetInput; card: () => TweetCard | null; remove: () => void }> = [];
  for (const instruction of instructions) {
    if (instruction?.type !== 'TimelineAddEntries' || !Array.isArray(instruction.entries)) continue;
    const entries = instruction.entries as ObjectValue[];
    for (const entry of entries) {
      const content = entry?.content;
      if (content?.entryType !== 'TimelineTimelineItem' || content?.itemContent?.itemType !== 'TimelineTweet') continue;
      const input = tweetInput(content.itemContent.tweet_results?.result);
      if (!input) continue;
      candidates.push({ input, card: () => tweetCard(content.itemContent.tweet_results?.result), remove: () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      } });
    }
  }
  return candidates;
}
