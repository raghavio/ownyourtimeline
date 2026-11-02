import { timelineCandidates } from './timeline-data';
import { installTimelineInterceptor } from './timeline-interceptor';
import { BATCH_TIMEOUT_MS, CHANNEL, MAX_BATCH_ITEMS, type ClassifyResult, type TweetCard, type TweetInput } from './shared';

// MAIN world, document_start. No extension APIs or keys exist here; decisions
// arrive from the isolated content script over window.postMessage.
interface Config { enabled: boolean; revision: number; showFilteredTab: boolean }
let config: Config | undefined;
let serial = 0;
const session = crypto.randomUUID();
const waiting = new Map<string, { resolve: (value: ClassifyResult[] | null) => void; timer: ReturnType<typeof setTimeout> }>();
const configWaiters = new Set<() => void>();

function post(type: string, value: object = {}) {
  window.postMessage({ channel: CHANNEL, direction: 'main', type, ...value }, location.origin);
}
function debug(event: string, data: object) {
  if (__DEV__) post('LOG', { event, data });
}
window.addEventListener('message', event => {
  if (event.source !== window || event.data?.channel !== CHANNEL || event.data?.direction !== 'content') return;
  const message = event.data;
  if (message.type === 'CONFIG' && typeof message.config?.enabled === 'boolean' && Number.isSafeInteger(message.config.revision)) {
    const previous = config?.revision;
    config = { enabled: message.config.enabled, revision: message.config.revision, showFilteredTab: message.config.showFilteredTab === true };
    for (const resolve of configWaiters) resolve();
    configWaiters.clear();
    // Release stale decisions immediately on pause or instruction change.
    if (!config.enabled || config.revision !== previous) {
      for (const item of waiting.values()) { clearTimeout(item.timer); item.resolve(null); }
      waiting.clear();
    }
  }
  if (message.type === 'RESULT' && typeof message.id === 'string') {
    const item = waiting.get(message.id);
    if (!item) return;
    waiting.delete(message.id); clearTimeout(item.timer);
    item.resolve(Array.isArray(message.results) ? message.results : null);
  }
});
async function ready(): Promise<void> {
  if (config) return;
  post('HELLO');
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); configWaiters.delete(done); resolve(); };
    const timer = setTimeout(done, 1000);
    configWaiters.add(done);
  });
}
function classify(inputs: TweetInput[], revision: number, deadline: number, batchId: string): Promise<ClassifyResult[] | null> {
  if (waiting.size >= 16) return Promise.resolve(null);
  const id = `${session}:${++serial}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, Math.max(1, deadline - Date.now()));
    waiting.set(id, { resolve, timer });
    post('CLASSIFY_BATCH', { id, batchId, inputs, revision, deadline });
  });
}
const current = (revision: number) => config?.enabled === true && config.revision === revision && location.pathname === '/home';

installTimelineInterceptor({
  enabled: () => config?.enabled !== false,
  timeoutMs: BATCH_TIMEOUT_MS,
  transform: async (body, operation, onDelivery) => {
    const startedAt = Date.now();
    await ready();
    if (!config?.enabled || location.pathname !== '/home') return null;
    const { revision, showFilteredTab } = config;
    const batchId = `${session}:batch:${++serial}`;
    debug('timeline-response', { batchId, operation, body });
    const all = timelineCandidates(body);
    const candidates = all.slice(0, MAX_BATCH_ITEMS);
    if (!candidates.length) return null;
    debug('extracted-inputs', { batchId, inputs: all.map(candidate => candidate.input) });

    const removed: Array<{ input: TweetInput; card?: TweetCard | null }> = [];
    const unchecked: Record<string, number> = {};
    let allowed = 0;
    // Counts and archive entries are published only once X actually received
    // the edited response, never for a timed-out or discarded transform.
    onDelivery(applied => {
      if (!current(revision)) return;
      const delivered = applied ? removed : [];
      for (const item of delivered) post('REMOVED', { revision, ...item });
      post('BATCH', { revision, total: all.length, removed: delivered.length, allowed: applied ? allowed : 0 });
      debug('delivery', { batchId, applied, removed: delivered.map(item => item.input.id), allowed, unchecked });
    });

    // Reserve a small margin so completed decisions land before X's deadline.
    const deliveryDeadline = startedAt + BATCH_TIMEOUT_MS;
    const results = await classify(candidates.map(candidate => candidate.input), revision, deliveryDeadline - 40, batchId);
    if (!results || !current(revision) || Date.now() >= deliveryDeadline) return null;
    candidates.forEach((candidate, index) => {
      const result = results[index];
      if (!result?.ok || result.revision !== revision || result.fingerprint !== candidate.input.fingerprint) {
        const reason = result?.reason ?? 'no-result';
        unchecked[reason] = (unchecked[reason] ?? 0) + 1;
      } else if (result.decision === 'filter') {
        candidate.remove();
        removed.push({ input: candidate.input, card: showFilteredTab ? candidate.card() : undefined });
      } else if (result.decision === 'allow') allowed++;
    });
    return removed.length ? body : null;
  },
});
post('HELLO');
