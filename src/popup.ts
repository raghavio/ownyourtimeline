import { clearLog, readLog } from './debug';
import { DEFAULT_SETTINGS, type Settings } from './shared';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing #${id}`);
  return node;
}
const enabled = element('enabled', HTMLInputElement);
const prompt = element('prompt', HTMLTextAreaElement);
const showFilteredTab = element('showFilteredTab', HTMLInputElement);
const key = element('key', HTMLInputElement);
const remember = element('remember', HTMLInputElement);
const status = element('status', HTMLElement);
const keyStatus = element('keyStatus', HTMLElement);

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
async function pageCounts(): Promise<{ active: boolean; removed: number; allowed: number; unchecked: number } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'FEED_STATUS' }); } catch { return; }
}
async function render() {
  const settings = await readSettings();
  const [{ lastError }, local, session] = await Promise.all([
    chrome.storage.local.get<{ lastError?: { code: string; httpStatus: number } | null }>('lastError'), chrome.storage.local.get('apiKey'), chrome.storage.session.get('apiKey'),
  ]);
  keyStatus.textContent ||= local.apiKey ? 'Key saved on this device.' : session.apiKey ? 'Key saved for this browser session.' : 'No key saved.';
  const lines = [];
  if (!settings.enabled) lines.push('Paused.');
  else if (!settings.prompt.trim()) lines.push('Add an instruction to start filtering.');
  else if (!local.apiKey && !session.apiKey) lines.push('Add your TypeSafe API key.');
  else {
    const page = await pageCounts();
    lines.push(page?.active
      ? `Filtering this page: ${page.removed} hidden · ${page.allowed} shown · ${page.unchecked} unchecked.`
      : 'Filtering on. Open X Home to see it work.');
    if (lastError?.code) lines.push(describe(lastError.code, lastError.httpStatus));
  }
  status.textContent = lines.join(' ');
}
function run(work: () => Promise<void>) {
  void work().catch(() => { status.textContent = 'Something went wrong. Reopen the popup and try again.'; });
}
async function changeKey(type: 'SET_KEY' | 'REMOVE_KEY') {
  keyStatus.textContent = type === 'SET_KEY' ? 'Testing key with TypeSafe…' : '';
  const result = await chrome.runtime.sendMessage({ type, key: key.value, remember: remember.checked });
  keyStatus.textContent = !result?.ok ? 'Enter a key first.'
    : type === 'REMOVE_KEY' ? 'Key removed.'
    : result.error ? `Key saved, but the test failed: ${describe(result.error, result.httpStatus)}`
    : 'Key works.';
  if (result?.ok) key.value = '';
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
  showFilteredTab.checked = settings.showFilteredTab;
  enabled.onchange = () => run(() => save({ enabled: enabled.checked }, true));
  element('apply', HTMLButtonElement).onclick = () => run(() => save({ prompt: prompt.value.trim() }, true));
  // Presentation only: never reclassify for this toggle.
  showFilteredTab.onchange = () => run(() => save({ showFilteredTab: showFilteredTab.checked }, false));
  element('saveKey', HTMLButtonElement).onclick = () => run(() => changeKey('SET_KEY'));
  element('removeKey', HTMLButtonElement).onclick = () => run(() => changeKey('REMOVE_KEY'));
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
  setInterval(() => run(render), 1000);
});
