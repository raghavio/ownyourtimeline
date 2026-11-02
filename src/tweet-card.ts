import type { TweetCard, TweetInput } from './shared';

export function safeCardUrl(value: unknown, kind: 'link' | 'image' | 'video' = 'link'): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (kind === 'image' && !['pbs.twimg.com', 'abs.twimg.com'].includes(url.hostname)) return;
    if (kind === 'video' && url.hostname !== 'video.twimg.com') return;
    return url.href;
  } catch { return; }
}

// Page-world messages are untrusted even when accompanied by a valid decision.
// Sanitize presentation data independently; never use post HTML or remote scripts.
export function sanitizeCard(value: unknown, depth = 0): TweetCard | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Partial<TweetCard>;
  if (typeof card.id !== 'string' || !/^\d{1,30}$/.test(card.id) || typeof card.text !== 'string') return null;
  const string = (input: unknown, limit: number) => typeof input === 'string' ? input.slice(0, limit) : '';
  const author = card.author;
  const media: TweetCard['media'] = [];
  for (const asset of Array.isArray(card.media) ? card.media.slice(0, 8) : []) {
    if (!asset || !['image', 'video'].includes(asset.kind)) continue;
    const url = safeCardUrl(asset.url, 'image');
    if (!url) continue;
    const dimension = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(10000, n) : undefined;
    media.push({ kind: asset.kind, url, alt: string(asset.alt, 2048), width: dimension(asset.width), height: dimension(asset.height),
      ...(safeCardUrl(asset.videoUrl, 'video') ? { videoUrl: safeCardUrl(asset.videoUrl, 'video') } : {}) });
  }
  const counts: TweetCard['counts'] = {};
  for (const key of ['replies', 'reposts', 'likes', 'views', 'bookmarks'] as const) {
    const n = card.counts?.[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) counts[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n));
  }
  const links = (Array.isArray(card.links) ? card.links.slice(0, 32) : []).flatMap(link => {
    const url = safeCardUrl(link?.url);
    const expandedUrl = safeCardUrl(link?.expandedUrl);
    return url && expandedUrl ? [{ url, expandedUrl, displayUrl: string(link.displayUrl, 200) || expandedUrl }] : [];
  });
  const quote = depth < 1 ? sanitizeCard(card.quote, depth + 1) : null;
  const date = typeof card.createdAt === 'string' && Number.isFinite(Date.parse(card.createdAt)) ? card.createdAt : undefined;
  return { id: card.id, text: string(card.text, 30000), author: { name: string(author?.name, 200) || 'X user',
    handle: /^[A-Za-z0-9_]{1,50}$/.test(author?.handle ?? '') ? author!.handle : '',
    avatar: safeCardUrl(author?.avatar, 'image'), verified: author?.verified === true },
    createdAt: date, context: string(card.context, 250), media, links,
    hiddenUrls: (Array.isArray(card.hiddenUrls) ? card.hiddenUrls.slice(0, 16) : []).filter(url => typeof url === 'string' && url.length <= 4096),
    counts, ...(quote ? { quote } : {}),
  };
}

export function fallbackCard(input: TweetInput): TweetCard {
  return sanitizeCard({ id: input.id, text: input.text, author: { name: 'X user', handle: '', verified: false },
    media: input.media.map(asset => ({ kind: asset.kind === 'image' ? 'image' : 'video', url: asset.url, alt: asset.alt })),
    counts: {}, links: [], hiddenUrls: [], ...(input.quotedText ? { quote: { id: input.id, text: input.quotedText,
      author: { name: 'Quoted post', handle: '', verified: false }, media: [], links: [], hiddenUrls: [], counts: {} } } : {}) })
    ?? { id: '', text: input.text, author: { name: 'X user', handle: '', verified: false }, media: [], links: [], hiddenUrls: [], counts: {} };
}

type Icon = 'reply' | 'repost' | 'like' | 'views' | 'bookmark' | 'open' | 'verified' | 'play';
const paths: Record<Icon, string> = {
  reply: 'M20.8 11.6c0 4.5-3.9 8-8.7 8H8l-4.8 2.9.9-5.4a7.7 7.7 0 0 1-2.9-5.9c0-4.5 4.4-8 9.8-8s9.8 3.5 9.8 8.4Z',
  repost: 'm4 7 3-3 3 3M7 4v12a3 3 0 0 0 3 3h3m7-2-3 3-3-3m3 3V8a3 3 0 0 0-3-3h-3',
  like: 'M12 21S2.5 15.2 2.5 8.5a5.5 5.5 0 0 1 9.5-3.8 5.5 5.5 0 0 1 9.5 3.8C21.5 15.2 12 21 12 21Z',
  views: 'M4 20V10m5 10V4m6 16v-8m5 8V7',
  bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
  open: 'M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7',
  verified: 'm12 2 2.5 2 3.2-.1.7 3.1L21 9l-1 3 1 3-2.6 2-.7 3.1-3.2-.1L12 22l-2.5-2-3.2.1L5.6 17 3 15l1-3-1-3 2.6-2 .7-3.1 3.2.1L12 2Z',
  play: 'm9 5 11 7-11 7V5Z',
};
export function cardIcon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', name === 'verified' || name === 'play' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path);
  if (name === 'verified') {
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    check.setAttribute('d', 'm8 12 3 3 5-6'); check.setAttribute('stroke', 'white'); check.setAttribute('fill', 'none'); svg.append(check);
  }
  return svg;
}
function link(href: string, label?: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = safeCardUrl(href) ?? 'https://x.com/home';
  anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  if (label) anchor.setAttribute('aria-label', label);
  return anchor;
}
const original = (card: TweetCard) => /^\d+$/.test(card.id) ? `https://x.com/i/status/${card.id}` : 'https://x.com/home';
function avatar(card: TweetCard, small = false): HTMLElement {
  const anchor = link(card.author.handle ? `https://x.com/${card.author.handle}` : original(card), `${card.author.name}'s profile`);
  anchor.className = small ? 'pf-card-avatar pf-card-avatar-small' : 'pf-card-avatar';
  const url = safeCardUrl(card.author.avatar, 'image');
  if (url) {
    const image = document.createElement('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { image.remove(); anchor.textContent = card.author.name.slice(0, 1); }, { once: true });
    anchor.append(image);
  } else anchor.textContent = card.author.name.slice(0, 1);
  return anchor;
}
function authorHeader(card: TweetCard, quote = false): HTMLElement {
  const header = document.createElement('div'); header.className = 'pf-card-author';
  if (quote) header.append(avatar(card, true));
  const name = link(card.author.handle ? `https://x.com/${card.author.handle}` : original(card));
  name.className = 'pf-card-name'; name.textContent = card.author.name; header.append(name);
  if (card.author.verified) {
    const badge = document.createElement('span'); badge.className = 'pf-card-verified'; badge.setAttribute('aria-label', 'Verified');
    badge.append(cardIcon('verified')); header.append(badge);
  }
  if (card.author.handle) {
    const handle = link(`https://x.com/${card.author.handle}`); handle.className = 'pf-card-handle'; handle.textContent = `@${card.author.handle}`; header.append(handle);
  }
  if (card.createdAt) {
    const dot = document.createElement('span'); dot.className = 'pf-card-muted'; dot.textContent = '·'; header.append(dot);
    const dateLink = link(original(card), 'View original post timestamp'); dateLink.className = 'pf-card-date';
    const time = document.createElement('time'); time.dateTime = new Date(card.createdAt).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(new Date(card.createdAt).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).format(new Date(card.createdAt));
    dateLink.title = new Date(card.createdAt).toLocaleString(); dateLink.append(time); header.append(dateLink);
  }
  return header;
}
function textBlock(card: TweetCard): HTMLElement {
  const text = document.createElement('div'); text.className = 'pf-card-text'; text.dir = 'auto';
  const pattern = /https?:\/\/[^\s<>"']+|@[A-Za-z0-9_]{1,50}\b|#[\p{L}\p{N}_]+/gu;
  let position = 0;
  for (const match of card.text.matchAll(pattern)) {
    const token = match[0], index = match.index!;
    text.append(document.createTextNode(card.text.slice(position, index)));
    position = index + token.length;
    if (card.hiddenUrls.includes(token)) continue;
    const entity = card.links.find(item => item.url === token);
    const href = token.startsWith('@') ? `https://x.com/${token.slice(1)}`
      : token.startsWith('#') ? `https://x.com/hashtag/${encodeURIComponent(token.slice(1))}` : safeCardUrl(entity?.expandedUrl ?? token);
    if (href) { const anchor = link(href); anchor.textContent = entity?.displayUrl ?? token; text.append(anchor); }
    else text.append(document.createTextNode(token));
  }
  text.append(document.createTextNode(card.text.slice(position)));
  return text;
}
function mediaBlock(card: TweetCard): HTMLElement | null {
  if (!card.media.length) return null;
  const grid = document.createElement('div'); grid.className = 'pf-card-media'; grid.dataset.count = String(Math.min(4, card.media.length));
  for (const media of card.media.slice(0, 4)) {
    const tile = document.createElement('div'); tile.className = 'pf-card-media-tile';
    if (card.media.length === 1 && media.width && media.height) tile.style.aspectRatio = String(Math.max(.65, Math.min(2, media.width / media.height)));
    if (media.kind === 'video' && media.videoUrl) {
      const video = document.createElement('video'); video.controls = true; video.preload = 'none'; video.playsInline = true;
      video.poster = media.url; video.src = media.videoUrl; video.setAttribute('aria-label', media.alt || 'Post video'); tile.append(video);
    } else {
      const anchor = link(original(card), media.kind === 'video' ? 'Open video on X' : 'Open image on X');
      const image = document.createElement('img'); image.src = media.url; image.alt = media.alt || (media.kind === 'video' ? 'Video thumbnail' : 'Post image');
      image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; anchor.append(image);
      if (media.kind === 'video') { const play = document.createElement('span'); play.className = 'pf-card-play'; play.append(cardIcon('play')); anchor.append(play); }
      tile.append(anchor);
    }
    grid.append(tile);
  }
  return grid;
}
export function renderTweetCard(card: TweetCard): HTMLElement {
  const article = document.createElement('article'); article.className = 'pf-tweet-card'; article.dataset.pfCard = card.id;
  article.setAttribute('aria-label', `Post by ${card.author.name}`);
  if (card.context) { const context = document.createElement('div'); context.className = 'pf-card-context'; context.append(cardIcon('repost'), document.createTextNode(card.context)); article.append(context); }
  const row = document.createElement('div'); row.className = 'pf-card-row'; row.append(avatar(card));
  const body = document.createElement('div'); body.className = 'pf-card-body'; body.append(authorHeader(card), textBlock(card));
  const media = mediaBlock(card); if (media) body.append(media);
  if (card.quote) {
    const quote = document.createElement('div'); quote.className = 'pf-card-quote';
    quote.append(authorHeader(card.quote, true), textBlock(card.quote));
    const quoteMedia = mediaBlock(card.quote); if (quoteMedia) quote.append(quoteMedia);
    body.append(quote);
  }
  const actions = document.createElement('div'); actions.className = 'pf-card-actions';
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  for (const [kind, count, name] of [
    ['reply', card.counts.replies, 'replies'], ['repost', card.counts.reposts, 'reposts'], ['like', card.counts.likes, 'likes'],
    ['views', card.counts.views, 'views'], ['bookmark', card.counts.bookmarks, 'bookmarks'],
  ] as const) {
    const action = link(original(card), `${count ?? 'View'} ${name} — open on X`); action.title = 'Open original on X'; action.dataset.action = kind;
    action.append(cardIcon(kind));
    if (count !== undefined) { const number = document.createElement('span'); number.textContent = count ? compact.format(count) : ''; action.append(number); }
    actions.append(action);
  }
  const open = link(original(card), 'Open original post'); open.title = 'Open original post'; open.append(cardIcon('open')); actions.append(open);
  body.append(actions); row.append(body); article.append(row);
  return article;
}
