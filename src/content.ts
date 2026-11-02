import { ConfirmedFilter } from './confirmed-filter';
import { FilteredView } from './filtered-view';
import { CHANNEL, DEFAULT_SETTINGS, MAX_BATCH_ITEMS, validInput, type ClassifyResult, type Settings, type TweetInput } from './shared';

// ISOLATED-world relay between the MAIN-world interceptor and the service
// worker. Credentials and classification stay in the worker.
const confirmedFilter = new ConfirmedFilter();
const view = new FilteredView();
let settings: Settings = DEFAULT_SETTINGS;
let ready = false;
let epoch = 0;
let lastPath = location.pathname;
let relayPending = 0;
// Supported response items on this page, reported to the popup.
let counts = { removed: 0, allowed: 0, unchecked: 0 };
// Successful worker decisions. The page world is untrusted, so only posts the
// worker actually rejected may enter the Filtered archive.
const accepted = new Map<string, ClassifyResult>();
let resolveReady: () => void;
const settingsReady = new Promise<void>(resolve => { resolveReady = resolve; });
const active = () => ready && settings.enabled && Boolean(settings.prompt.trim()) && location.pathname === '/home';

function post(type: string, value: object = {}) {
  window.postMessage({ channel: CHANNEL, direction: 'content', type, ...value }, location.origin);
}
function sync() {
  confirmedFilter.sync(active());
  view.configure(settings.showFilteredTab, active());
  if (ready) post('CONFIG', { config: { enabled: active(), revision: settings.revision, showFilteredTab: settings.showFilteredTab } });
}
function apply(value: Settings) {
  const previous = settings;
  const wasReady = ready;
  settings = value;
  const changed = previous.revision !== settings.revision || previous.prompt !== settings.prompt || previous.enabled !== settings.enabled;
  if (changed) {
    confirmedFilter.clear(); accepted.clear(); view.clear();
    counts = { removed: 0, allowed: 0, unchecked: 0 };
  }
  ready = true;
  resolveReady();
  sync();
  // Removed entries are absent from X's own data. Rebuild it on policy/pause
  // changes rather than attempting to restore or reclassify DOM elements.
  if (wasReady && changed && location.pathname === '/home') location.reload();
}

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.channel !== CHANNEL || event.data?.direction !== 'main') return;
  const message = event.data;
  if (message.type === 'HELLO') { sync(); return; }
  if (__DEV__ && message.type === 'LOG') {
    void chrome.runtime.sendMessage({ type: 'LOG', event: message.event, data: message.data }).catch(() => {});
    return;
  }
  if (message.type === 'BATCH') {
    const { revision, total, removed, allowed } = message;
    if (!active() || revision !== settings.revision
      || ![total, removed, allowed].every(n => Number.isSafeInteger(n) && n >= 0) || removed + allowed > total) return;
    counts.removed += removed; counts.allowed += allowed; counts.unchecked += total - removed - allowed;
    return;
  }
  if (message.type === 'REMOVED') {
    if (!active() || message.revision !== settings.revision || !validInput(message.input)) return;
    if (accepted.get(message.input.fingerprint)?.decision === 'filter') view.remember(message.input, message.card);
    return;
  }
  if (message.type !== 'CLASSIFY_BATCH' || typeof message.id !== 'string' || message.id.length > 100
    || !Array.isArray(message.inputs) || !message.inputs.length || message.inputs.length > MAX_BATCH_ITEMS
    || !message.inputs.every(validInput) || !Number.isSafeInteger(message.revision) || !Number.isFinite(message.deadline)) return;
  const inputs: TweetInput[] = message.inputs;
  if (relayPending >= 16) { post('RESULT', { id: message.id, results: null }); return; }
  relayPending++;
  void (async () => {
    let results: ClassifyResult[] | null = null;
    try {
      await settingsReady;
      if (!active() || message.revision !== settings.revision || Date.now() >= message.deadline) return;
      const response: unknown = await chrome.runtime.sendMessage({ type: 'CLASSIFY_BATCH', tweets: inputs,
        revision: message.revision, deadline: message.deadline,
        batchId: typeof message.batchId === 'string' ? message.batchId : message.id });
      if (!active() || message.revision !== settings.revision || !Array.isArray(response) || response.length !== inputs.length) return;
      results = response;
      results.forEach((result, index) => {
        if (!result?.ok || result.revision !== settings.revision || result.fingerprint !== inputs[index].fingerprint) return;
        accepted.set(result.fingerprint, result);
        if (accepted.size > 1000) accepted.delete(accepted.keys().next().value!);
        if (result.decision === 'filter') confirmedFilter.remember(inputs[index].id);
      });
    } catch { /* Worker unreachable: the batch is delivered unfiltered. */ }
    finally { confirmedFilter.sync(active()); relayPending--; post('RESULT', { id: message.id, results }); }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'SETTINGS') { epoch++; apply(message.settings); }
  if (message?.type === 'FEED_STATUS') respond({ active: active(), ...counts });
});
const initialEpoch = epoch;
const disabled = () => { if (epoch === initialEpoch && !ready) apply({ ...DEFAULT_SETTINGS }); };
const bootstrap = setTimeout(disabled, 2000);
void chrome.runtime.sendMessage({ type: 'START_PAGE' })
  .then(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }))
  .then(value => { if (epoch === initialEpoch) apply(value); })
  .catch(disabled)
  .finally(() => clearTimeout(bootstrap));

let queued = false;
const observer = new MutationObserver(records => {
  if (queued || !records.some(record => {
    if (record.target instanceof Element && record.target.closest('[data-pf-ui]')) return false;
    if (record.type === 'attributes') return true;
    return [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element) || !node.hasAttribute('data-pf-ui'));
  })) return;
  queued = true;
  queueMicrotask(() => { queued = false; confirmedFilter.sync(active()); view.sync(); });
});
observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-testid'] });
setInterval(() => {
  if (lastPath !== location.pathname) { lastPath = location.pathname; sync(); }
  confirmedFilter.sync(active());
  view.position();
}, 200);
window.addEventListener('pageshow', sync);
