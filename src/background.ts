import { log } from './debug';
import { HIDE_THRESHOLD, jev, jevBulk, MODEL, ProviderError } from './provider';
import { BATCH_TIMEOUT_MS, DEFAULT_SETTINGS, MAX_BATCH_ITEMS, validInput,
  type ClassifyRequest, type ClassifyResult, type Settings, type TweetInput } from './shared';

// Slots and queue entries are whole response batches, not individual posts.
const MAX_ACTIVE = 4;
const MAX_QUEUE = 16;
const MAX_CACHE = 1000;
const X_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
// Per-post problems are reported as unchecked counts, not as a provider error.
const PER_POST = new Set(['incomplete-content', 'incomplete-media', 'context-limit', 'payload-limit', 'superseded', 'backoff']);

// Decisions belong to one tab document. A reload starts with an empty cache.
const cache = new Map<string, number>();
const pending = new Map<string, Promise<ClassifyResult>>();
const pageDocuments = new Map<number, string>();
const queue: Array<() => void> = [];
const controllers = new Set<AbortController>();
let active = 0;
let failures = 0;
let blockedUntil = 0;
let authBlocked = false;
let reportedError: string | undefined;

// The API key may live in storage.local; keep it out of content scripts.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function normalizeSettings(value: unknown): Settings {
  const input: Partial<Settings> = value && typeof value === 'object' ? value : {};
  const revision = input.revision;
  return {
    enabled: input.enabled === true,
    showFilteredTab: input.showFilteredTab === true,
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : DEFAULT_SETTINGS.prompt,
    revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : DEFAULT_SETTINGS.revision,
  };
}
const readSettings = async () => normalizeSettings((await chrome.storage.local.get('settings')).settings);
async function readKey(): Promise<string> {
  const session = await chrome.storage.session.get('apiKey');
  const stored = session.apiKey ? session : await chrome.storage.local.get('apiKey');
  return typeof stored.apiKey === 'string' ? stored.apiKey : '';
}

function beginPage(tabId: number, documentId: string) {
  if (pageDocuments.get(tabId) === documentId) return;
  pageDocuments.set(tabId, documentId);
  for (const key of cache.keys()) if (key.startsWith(`${tabId}:`)) cache.delete(key);
}
function validSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' && X_HOSTS.includes(url.hostname);
  } catch { return false; }
}
function validRequest(message: unknown): message is ClassifyRequest {
  if (!message || typeof message !== 'object') return false;
  const request: Partial<ClassifyRequest> = message;
  return request.type === 'CLASSIFY_BATCH' && Number.isSafeInteger(request.revision)
    && typeof request.deadline === 'number' && Number.isFinite(request.deadline)
    && (request.batchId === undefined || typeof request.batchId === 'string' && request.batchId.length <= 100)
    && Array.isArray(request.tweets) && request.tweets.length > 0 && request.tweets.length <= MAX_BATCH_ITEMS
    && request.tweets.every(validInput);
}
function failure(tweet: TweetInput, revision: number, reason: string): ClassifyResult {
  return { ok: false, revision, fingerprint: tweet.fingerprint, reason };
}
function success(tweet: TweetInput, revision: number, probability: number): ClassifyResult {
  return { ok: true, revision, fingerprint: tweet.fingerprint, probability, decision: probability >= HIDE_THRESHOLD ? 'filter' : 'allow' };
}

// The popup shows the latest provider-level failure; a clean batch clears it.
async function reportError(error?: ProviderError) {
  const code = error?.code ?? '';
  if (code === reportedError) return;
  reportedError = code;
  await chrome.storage.local.set({ lastError: error ? { code, httpStatus: error.httpStatus, at: Date.now() } : null });
}
async function noteErrors(errors: ProviderError[]) {
  for (const error of errors) {
    if (error.code === 'key-access-problem') authBlocked = true;
    if (error.code === 'rate-limited') blockedUntil = Math.max(blockedUntil, Date.now() + error.retryAfter);
  }
  // One failed bulk request counts once, not once per post it carried.
  if (errors.some(error => error.code === 'unavailable' || error.code === 'malformed-result')) {
    if (++failures >= 3) blockedUntil = Math.max(blockedUntil, Date.now() + 30000);
  } else if (!errors.length) failures = 0;
  const provider = errors.find(error => !PER_POST.has(error.code));
  if (provider || !errors.some(error => error.code === 'superseded' || error.code === 'backoff')) await reportError(provider);
}

type Job = { tweet: TweetInput; key: string; resolve: (result: ClassifyResult) => void };
function finish(job: Job, result: ClassifyResult) { pending.delete(job.key); job.resolve(result); }
function pump() { while (active < MAX_ACTIVE && queue.length) queue.shift()!(); }

async function execute(jobs: Job[], request: ClassifyRequest, isCurrent: () => Promise<boolean>) {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Leave time for the isolated relay and MAIN-world delivery.
    const deadline = Math.min(request.deadline - 200, Date.now() + BATCH_TIMEOUT_MS);
    if (Date.now() >= deadline) throw new ProviderError('queue-timeout');
    if (!await isCurrent()) throw new ProviderError('superseded');
    if (authBlocked || Date.now() < blockedUntil) throw new ProviderError('backoff');
    const key = await readKey();
    if (!key) throw new ProviderError('key-required');
    const { prompt } = await readSettings();
    const abort = new AbortController();
    controller = abort; controllers.add(abort);
    timer = setTimeout(() => abort.abort(), deadline - Date.now());
    const answers = await jevBulk(jobs.map(job => job.tweet), prompt, key, abort.signal);
    if (!await isCurrent()) throw new ProviderError('superseded');
    const errors: ProviderError[] = [];
    jobs.forEach((job, index) => {
      const answer = answers[index];
      if ('error' in answer) { errors.push(answer.error); finish(job, failure(job.tweet, request.revision, answer.error.code)); return; }
      cache.set(job.key, answer.probability);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      finish(job, success(job.tweet, request.revision, answer.probability));
    });
    await noteErrors(errors);
  } catch (cause) {
    const error = cause instanceof ProviderError ? cause
      : cause instanceof DOMException && ['AbortError', 'TimeoutError'].includes(cause.name) ? new ProviderError('timeout')
      : new ProviderError('unavailable');
    for (const job of jobs) finish(job, failure(job.tweet, request.revision, error.code));
    await noteErrors([error]);
  } finally {
    clearTimeout(timer);
    if (controller) controllers.delete(controller);
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function classify(request: ClassifyRequest, tabId: number, documentId: string): Promise<ClassifyResult[]> {
  if (!pageDocuments.has(tabId)) beginPage(tabId, documentId);
  const isCurrent = async () => {
    const settings = await readSettings();
    return pageDocuments.get(tabId) === documentId && settings.enabled && Boolean(settings.prompt.trim())
      && settings.revision === request.revision;
  };
  if (!await isCurrent()) return request.tweets.map(tweet => failure(tweet, request.revision, 'superseded'));
  if (__DEV__) log('classify-request', { tabId, batchId: request.batchId, revision: request.revision, tweets: request.tweets });
  // The revision changes whenever the instruction does, so it scopes the cache.
  const keys = await Promise.all(request.tweets.map(async tweet =>
    `${tabId}:${documentId}:${request.revision}:${MODEL}:${await sha256(tweet.fingerprint)}`));
  const jobs: Job[] = [];
  const results = request.tweets.map((tweet, index) => {
    const key = keys[index];
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(success(tweet, request.revision, cached));
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = new Promise<ClassifyResult>(resolve => { jobs.push({ tweet, key, resolve }); });
    pending.set(key, promise);
    return promise;
  });
  if (jobs.length && queue.length >= MAX_QUEUE) {
    for (const job of jobs) finish(job, failure(job.tweet, request.revision, 'queue-full'));
    await reportError(new ProviderError('queue-full'));
  } else if (jobs.length) {
    queue.push(() => {
      active++;
      void execute(jobs, request, isCurrent).finally(() => { active--; pump(); });
    });
    pump();
  }
  const completed = await Promise.all(results);
  if (__DEV__) log('classify-results', { tabId, batchId: request.batchId,
    results: completed.map((result, index) => ({ id: request.tweets[index].id, ...result })) });
  return completed;
}

type KeyResult = { ok: boolean; error?: string; httpStatus?: number };
async function updateKey(key: unknown, remember: boolean): Promise<KeyResult> {
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 4096)) return { ok: false, error: 'invalid-key' };
  await chrome.storage.local.remove('apiKey');
  await chrome.storage.session.remove('apiKey');
  authBlocked = false; failures = 0; blockedUntil = 0;
  if (key === undefined) { await reportError(new ProviderError('key-required')); return { ok: true }; }
  await (remember ? chrome.storage.local : chrome.storage.session).set({ apiKey: key.trim() });
  try {
    await jev({ id: 'connection-test', text: 'This is a connection test.', quotedText: '', media: [], fingerprint: 'connection-test' },
      'Show all posts.', key.trim(), AbortSignal.timeout(10000));
    await reportError();
  } catch (cause) {
    const error = cause instanceof ProviderError ? cause : new ProviderError('unavailable');
    if (error.code === 'key-access-problem') authBlocked = true;
    await reportError(error);
    return { ok: true, error: error.code, httpStatus: error.httpStatus };
  }
  // Rebuild open Home tabs so they are filtered with the new key.
  const settings = await readSettings();
  await chrome.storage.local.set({ settings: { ...settings, revision: settings.revision + 1 } });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const msg: { type?: unknown; key?: unknown; remember?: unknown; event?: unknown; data?: unknown } =
    message && typeof message === 'object' ? message : {};
  const fromPopup = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('')) === true;
  const fromX = validSender(sender);
  const tabId = sender.tab?.id;
  if (__DEV__ && fromX && msg.type === 'LOG' && typeof msg.event === 'string') {
    log(msg.event, { tabId, ...(msg.data && typeof msg.data === 'object' ? msg.data : {}) });
    return false;
  }
  if (msg.type === 'GET_SETTINGS' && (fromX || fromPopup)) {
    void readSettings().then(respond);
    return true;
  }
  if (msg.type === 'START_PAGE' && fromX && tabId !== undefined) {
    beginPage(tabId, sender.documentId ?? '');
    respond({ ok: true });
    return false;
  }
  if (fromPopup && (msg.type === 'SET_KEY' || msg.type === 'REMOVE_KEY')) {
    void updateKey(msg.type === 'SET_KEY' ? msg.key : undefined, msg.remember === true)
      .then(respond, () => respond({ ok: false }));
    return true;
  }
  if (fromX && tabId !== undefined && validRequest(message)) {
    void classify(message, tabId, sender.documentId ?? '')
      .then(respond, () => respond(message.tweets.map(tweet => failure(tweet, message.revision, 'unavailable'))));
    return true;
  }
  return false;
});
chrome.tabs.onRemoved.addListener(tabId => {
  pageDocuments.delete(tabId);
  for (const key of cache.keys()) if (key.startsWith(`${tabId}:`)) cache.delete(key);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = normalizeSettings(changes.settings.newValue);
  if (normalizeSettings(changes.settings.oldValue).revision !== settings.revision) {
    controllers.forEach(controller => controller.abort(new ProviderError('superseded')));
  }
  void chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) if (tab.id) void chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS', settings }).catch(() => {});
  });
});
