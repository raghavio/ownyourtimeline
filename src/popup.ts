import { clearLog, readLog } from './debug';
import { DEFAULT_SETTINGS, type Settings } from './shared';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing #${id}`);
  return node;
}
const enabled = element('enabled', HTMLInputElement);
const prompt = element('prompt', HTMLTextAreaElement);
const count = element('count', HTMLElement);
const apply = element('apply', HTMLButtonElement);
const applyHint = element('applyHint', HTMLElement);
const showFilteredTab = element('showFilteredTab', HTMLInputElement);
const key = element('key', HTMLInputElement);
const remember = element('remember', HTMLInputElement);
const status = element('status', HTMLElement);
const summary = element('summary', HTMLElement);
const stats = element('stats', HTMLElement);
const errorLine = element('error', HTMLElement);
const keySummary = element('keySummary', HTMLElement);
const keyState = element('keyState', HTMLElement);
const keyForm = element('keyForm', HTMLElement);
const cancelKey = element('cancelKey', HTMLButtonElement);
const keyStatus = element('keyStatus', HTMLElement);

// The instruction as last applied; the editor is dirty when it differs.
let appliedPrompt = '';
// True while the user is replacing an already saved key.
let editingKey = false;

const errors: Record<string, string> = {
  'key-required': 'Add your TypeSafe API key.',
  'key-access-problem': 'TypeSafe rejected your key. Check it and save it again.',
  'rate-limited': 'TypeSafe rate limit reached. Filtering resumes automatically.',
  'unavailable': 'TypeSafe is unreachable. Posts are shown unfiltered until it recovers.',
  'timeout': 'TypeSafe took too long. Affected posts were shown unfiltered.',
  'queue-timeout': 'Too many posts were waiting. Some were shown unfiltered.',
  'queue-full': 'Too many feed batches at once. Some posts were shown unfiltered.',
  'request-rejected': 'TypeSafe rejected a request. Affected posts were shown unfiltered.',
  'provider-context-limit': 'A batch was too large for TypeSafe. Affected posts were shown unfiltered.',
  'configuration-problem': 'TypeSafe rejected the request. Check your account, model and image access.',
  'malformed-result': 'TypeSafe returned an unexpected response.',
};
const describe = (code: string, httpStatus?: number) =>
  (errors[code] ?? `Filtering failed (${code}).`) + (httpStatus ? ` HTTP ${httpStatus}.` : '');

async function readSettings(): Promise<Settings> {
  return await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }) ?? DEFAULT_SETTINGS;
}
async function save(patch: Partial<Settings>, rebuildFeed: boolean) {
  const current = await readSettings();
  // A new revision makes open Home tabs reload and reclassify.
  await chrome.storage.local.set({ settings: { ...current, ...patch, revision: current.revision + (rebuildFeed ? 1 : 0) } });
  await render();
}
// undefined: no content script answered (not an X tab, or an X tab opened
// before the extension was last reloaded, whose script Chrome disconnected).
async function pageCounts(): Promise<{ active: boolean; removed: number; allowed: number; unchecked: number } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'FEED_STATUS' }); } catch { return; }
}
type StatusState = 'on' | 'off' | 'warn' | 'error';
type PageCounts = { removed: number; allowed: number; unchecked: number };
// Synchronous on purpose: any await between DOM writes paints an intermediate
// layout, and Chrome resizes the popup window to every one of them.
function showStatus(state: StatusState, text: string, error = '', counts?: PageCounts) {
  status.dataset.state = error ? 'error' : state;
  summary.textContent = text;
  errorLine.textContent = error;
  errorLine.hidden = !error;
  stats.hidden = !counts;
  if (!counts) return;
  element('removed', HTMLElement).textContent = String(counts.removed);
  element('allowed', HTMLElement).textContent = String(counts.allowed);
  element('unchecked', HTMLElement).textContent = String(counts.unchecked);
}
// Chrome caps action popups at 600px tall; past that the whole popup scrolls.
const POPUP_MAX_HEIGHT = 600;
const EDITOR_MIN_HEIGHT = 160;
// The instruction is the point of the popup: show all of it when it fits,
// otherwise give it every pixel the rest of the popup leaves free.
function fitEditor() {
  prompt.style.height = 'auto';
  // body height is the content alone; the root scrollHeight never drops below the window.
  const room = POPUP_MAX_HEIGHT - (document.body.offsetHeight - prompt.offsetHeight);
  prompt.style.height = `${Math.max(EDITOR_MIN_HEIGHT, Math.min(prompt.scrollHeight, room))}px`;
}
function syncEditor() {
  const dirty = prompt.value.trim() !== appliedPrompt;
  count.textContent = `${prompt.value.length}/${prompt.maxLength}`;
  apply.disabled = !dirty;
  applyHint.hidden = !dirty;
  fitEditor();
}
async function render() {
  const settings = await readSettings();
  const [{ lastError }, local, session] = await Promise.all([
    chrome.storage.local.get<{ lastError?: { code: string; httpStatus: number } | null }>('lastError'), chrome.storage.local.get('apiKey'), chrome.storage.session.get('apiKey'),
  ]);
  const hasKey = Boolean(local.apiKey || session.apiKey);
  const filtering = settings.enabled && settings.prompt.trim() && hasKey;
  const page = filtering ? await pageCounts() : undefined;

  keyState.textContent = local.apiKey ? 'Saved on this device' : 'Saved for this browser session';
  keySummary.hidden = !hasKey || editingKey;
  keyForm.hidden = hasKey && !editingKey;
  cancelKey.hidden = !hasKey;

  const error = lastError?.code ? describe(lastError.code, lastError.httpStatus) : '';
  if (!settings.enabled) showStatus('off', 'Paused');
  else if (!settings.prompt.trim()) showStatus('warn', 'Add an instruction to start filtering');
  else if (!hasKey) showStatus('warn', 'Add your TypeSafe API key');
  else if (!page) showStatus('on', 'Filtering on. Open or reload X Home to see counts.', error);
  else if (!page.active) showStatus('on', 'Filtering on. Counts show on the Home timeline.', error);
  else showStatus('on', 'Filtering this page', error, page);
  // Status and key sections just changed size; hand the editor what is left.
  fitEditor();
}
function run(work: () => Promise<void>) {
  void work().catch(() => showStatus('error', 'Something went wrong', 'Reopen the popup and try again.'));
}
async function changeKey(type: 'SET_KEY' | 'REMOVE_KEY') {
  keyStatus.textContent = type === 'SET_KEY' ? 'Testing key with TypeSafe…' : '';
  const result = await chrome.runtime.sendMessage({ type, key: key.value, remember: remember.checked });
  keyStatus.textContent = !result?.ok ? 'Enter a key first.'
    : type === 'REMOVE_KEY' ? 'Key removed.'
    : result.error ? `Key saved, but the test failed: ${describe(result.error, result.httpStatus)}`
    : 'Key works.';
  if (result?.ok) { key.value = ''; editingKey = false; }
  await render();
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

run(async () => {
  const settings = await readSettings();
  enabled.checked = settings.enabled;
  prompt.value = settings.prompt;
  appliedPrompt = settings.prompt.trim();
  syncEditor();
  showFilteredTab.checked = settings.showFilteredTab;
  enabled.onchange = () => run(() => save({ enabled: enabled.checked }, true));
  const applyPrompt = () => run(async () => {
    appliedPrompt = prompt.value.trim();
    syncEditor();
    await save({ prompt: appliedPrompt }, true);
  });
  apply.onclick = applyPrompt;
  prompt.oninput = syncEditor;
  prompt.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !apply.disabled) { event.preventDefault(); applyPrompt(); }
  };
  // Presentation only: never reclassify for this toggle.
  showFilteredTab.onchange = () => run(() => save({ showFilteredTab: showFilteredTab.checked }, false));
  element('saveKey', HTMLButtonElement).onclick = () => run(() => changeKey('SET_KEY'));
  element('removeKey', HTMLButtonElement).onclick = () => run(() => changeKey('REMOVE_KEY'));
  element('changeKey', HTMLButtonElement).onclick = () => run(async () => {
    editingKey = true;
    keyStatus.textContent = '';
    await render();
    key.focus();
  });
  cancelKey.onclick = () => run(async () => { editingKey = false; key.value = ''; await render(); });
  key.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); run(() => changeKey('SET_KEY')); } };
  if (__DEV__) {
    const debugStatus = element('debugStatus', HTMLElement);
    element('debug', HTMLElement).hidden = false;
    element('exportLog', HTMLButtonElement).onclick = () => run(async () => {
      const [events, { settings: stored }] = await Promise.all([readLog(), chrome.storage.local.get('settings')]);
      download(`ownyourtimeline-debug-${Date.now()}.json`, {
        exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, settings: stored, events,
      });
      debugStatus.textContent = `Exported ${events.length} events.`;
    });
    element('clearLog', HTMLButtonElement).onclick = () => run(async () => { await clearLog(); debugStatus.textContent = 'Log cleared.'; });
  }
  await render();
  // Page counts are a snapshot taken on open; only re-render when stored state
  // changes (settings, key, or a classifier error reported by the background).
  chrome.storage.onChanged.addListener(() => run(render));
});
