export interface Settings {
  enabled: boolean;
  showFilteredTab: boolean;
  prompt: string;
  revision: number;
}
export const DEFAULT_SETTINGS: Settings = { enabled: false, showFilteredTab: false, prompt: '', revision: 1 };
// X's response is held at most this long while its posts are classified.
export const BATCH_TIMEOUT_MS = 60000;
// Each bulk group's media/API work has its own bounded allowance.
export const GROUP_TIMEOUT_MS = 10000;
export const MAX_BATCH_ITEMS = 80;
export const CHANNEL = 'ownyourtimeline-v1';

export interface TweetMedia {
  kind: 'image' | 'video-thumbnail';
  url: string;
  alt: string;
}
export interface TweetInput {
  id: string;
  text: string;
  quotedText: string;
  media: TweetMedia[];
  fingerprint: string;
  incomplete?: boolean;
  incompleteReasons?: Array<{ reason: string; depth: number; mediaIndex?: number }>;
  context?: string;
}
// Presentation snapshots are kept separately from classifier inputs/cache keys.
export interface TweetCardMedia {
  kind: 'image' | 'video';
  url: string;
  alt: string;
  width?: number;
  height?: number;
  videoUrl?: string;
}
export interface TweetCard {
  id: string;
  text: string;
  author: { name: string; handle: string; avatar?: string; verified: boolean };
  createdAt?: string;
  context?: string;
  media: TweetCardMedia[];
  links: Array<{ url: string; expandedUrl: string; displayUrl: string }>;
  hiddenUrls: string[];
  counts: { replies?: number; reposts?: number; likes?: number; views?: number; bookmarks?: number };
  quote?: TweetCard;
}
export interface SavedTweet {
  input: TweetInput;
  card?: TweetCard;
}
export interface ClassifyRequest {
  type: 'CLASSIFY_BATCH';
  tweets: TweetInput[];
  revision: number;
  deadline: number;
  batchId?: string;
}
export interface ClassifyResult {
  ok: boolean;
  decision?: 'allow' | 'filter';
  revision: number;
  fingerprint: string;
  reason?: string;
  probability?: number;
}

const short = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
// Inputs originate in X's page world, so every hop re-validates their bounds.
export function validInput(value: unknown): value is TweetInput {
  if (!value || typeof value !== 'object') return false;
  const tweet: Partial<TweetInput> = value;
  return short(tweet.id, 512) && short(tweet.text, 30000) && short(tweet.quotedText, 30000)
    && (tweet.context === undefined || short(tweet.context, 4096))
    && (tweet.incomplete === undefined || typeof tweet.incomplete === 'boolean')
    && (tweet.incompleteReasons === undefined || Array.isArray(tweet.incompleteReasons) && tweet.incompleteReasons.length <= 128)
    && short(tweet.fingerprint, 100000) && tweet.fingerprint.length > 0
    && Array.isArray(tweet.media) && tweet.media.length <= 32
    && tweet.media.every(media => media && (media.kind === 'image' || media.kind === 'video-thumbnail')
      && short(media.url, 4096) && short(media.alt, 2048));
}
