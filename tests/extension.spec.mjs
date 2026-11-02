import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { networkBody, networkHtml } from './fixtures.mjs';

// The real built extension in real Chromium. Only the two network edges are
// stubbed: x.com serves a fixture Home page, and TypeSafe answers from post text.
const KEY = 'fixture-key-must-never-be-logged';
const judge = (route, body) => route.fulfill({ json: { model: 'jev-1.14.0', usage: { input_tokens: 1, output_tokens: 1 },
  answers: Object.fromEntries(Object.entries(body.state.posts).map(([name, post]) =>
    [name.replace('post_', 'hide_'), { type: 'noul', noul: /election|parliament/i.test(post.text) ? .98 : .01 }])) } });

let env;
test.afterEach(async () => { await env?.close(); env = undefined; });

async function launch({ build = 'dist', provider = judge } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'pf-e2e-'));
  const extension = path.resolve(build);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('https://x.com/**', route => route.request().url().includes('/i/api/graphql/')
    ? route.fulfill({ json: networkBody(JSON.parse(route.request().postData() || '{}').tweets) })
    : route.fulfill({ contentType: 'text/html', body: networkHtml }));
  const calls = [];
  await context.route('https://api.typesafe.ai/**', route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    return provider(route, body);
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = context.pages()[0] ?? await context.newPage();
  env = {
    page, worker, calls,
    configure: settings => worker.evaluate(async ({ settings, key }) => {
      await chrome.storage.session.set({ apiKey: key });
      const { settings: current } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { enabled: true, prompt: 'Nothing political', showFilteredTab: false,
        ...settings, revision: (current?.revision ?? 0) + 1 } });
    }, { settings, key: KEY }),
    popup: async () => {
      const popup = await context.newPage();
      await popup.goto(new URL('popup.html', worker.url()).href);
      return popup;
    },
    // A real popup reads the active X tab; ask that tab directly instead.
    counts: () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'FEED_STATUS' });
    }),
    close: async () => { await context.close(); await rm(profile, { recursive: true, force: true }); },
  };
  return env;
}
const article = (page, id) => page.locator(`article[data-fixture-id="${id}"]`);

test('rejected posts are removed from Home responses before X renders them', async () => {
  const { page, configure, calls, counts } = await launch();
  await configure({});
  await page.goto('https://x.com/home');
  await expect(article(page, '1002')).toBeVisible();
  await expect(article(page, '1001')).toHaveCount(0);
  // The fixture page records any political card that reached the DOM, even for one frame.
  expect(await page.evaluate(() => window.fixtureAudit)).toEqual([]);
  expect(await page.evaluate(() => window.lastBody.data.home.home_timeline_urt.instructions[0].entries.at(-1).content.value)).toBe('next-fixture-page');
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0].questions)).toHaveLength(2);

  for (const [operation, transport, id] of [['HomeLatestTimeline', 'xhr', '2001'], ['HomeTimeline', 'fetch', '2002']]) {
    await page.evaluate(args => window.feed.load([{ id: args.id, text: 'Parliament vote.' }, { id: args.id + '0', text: 'Garden update.' }],
      args.operation, args.transport), { operation, transport, id });
    await expect(article(page, id)).toHaveCount(0);
    await expect(article(page, id + '0')).toBeVisible();
  }
  // Repeated posts on the same page reuse cached decisions.
  await page.evaluate(() => window.feed.load());
  expect(calls).toHaveLength(3);
  expect(await counts()).toEqual({ active: true, removed: 4, allowed: 4, unchecked: 0 });
});

test('popup re-renders on stored changes without re-laying out', async () => {
  const { page, configure, popup } = await launch();
  await configure({});
  await page.goto('https://x.com/home');
  await expect(article(page, '1002')).toBeVisible();
  const view = await popup();
  // The popup reads the active tab, so X must be in front when it renders.
  await page.bringToFront();
  const toggle = view.locator('#showFilteredTab');
  await toggle.click();
  await expect(view.locator('#stats')).toBeVisible();
  await expect(view.locator('#removed')).toHaveText('1');
  await expect(view.locator('#allowed')).toHaveText('1');
  // Any hidden toggle mid-render resizes the real popup window (visible jitter).
  await view.evaluate(() => {
    window.layoutFlips = 0;
    // Rewriting the same value still queues a record, so count real changes only:
    // each record's new value is the next record's oldValue for that element.
    new MutationObserver(records => records.forEach((record, i) => {
      const next = records.slice(i + 1).find(later => later.target === record.target);
      if (record.oldValue !== (next ? next.oldValue : record.target.getAttribute('hidden'))) window.layoutFlips++;
    })).observe(document.querySelector('main'), { subtree: true, attributeFilter: ['hidden'], attributeOldValue: true });
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await view.waitForTimeout(500);
  expect(await view.evaluate(() => window.layoutFlips)).toBe(0);
  await expect(view.locator('#removed')).toHaveText('1');
});

test('instruction editor grows with its text but keeps the popup within Chrome\'s 600px cap', async () => {
  const { configure, popup } = await launch();
  const size = view => view.evaluate(() => ({ body: document.body.offsetHeight, editor: document.getElementById('prompt').offsetHeight }));

  await configure({ prompt: 'No politics' });
  const short = await popup();
  await expect(short.locator('#summary')).not.toHaveText('Loading…');
  expect((await size(short)).editor).toBe(160);

  await configure({ prompt: Array.from({ length: 12 }, (_, i) => `Rule ${i}: something long enough to matter`).join('\n') });
  const medium = await popup();
  await expect(medium.locator('#summary')).not.toHaveText('Loading…');
  const mediumSize = await size(medium);
  // All of it is visible: no inner scrolling.
  expect(await medium.evaluate(() => { const box = document.getElementById('prompt'); return box.scrollHeight - box.clientHeight; })).toBe(0);
  expect(mediumSize.editor).toBeGreaterThan(160);
  expect(mediumSize.body).toBeLessThanOrEqual(600);

  await configure({ prompt: 'A rule that never ends.\n'.repeat(80) });
  const long = await popup();
  await expect(long.locator('#summary')).not.toHaveText('Loading…');
  expect((await size(long)).body).toBe(600);
});

test('provider failures show posts unfiltered and the popup explains why', async () => {
  const { page, configure, calls, counts, popup } = await launch({ provider: route => route.fulfill({ status: 401, body: '' }) });
  await configure({});
  await page.goto('https://x.com/home');
  await expect(page.locator('article')).toHaveCount(2);
  expect(await counts()).toEqual({ active: true, removed: 0, allowed: 0, unchecked: 2 });
  // A rejected key stops further paid calls until the key changes.
  await page.evaluate(() => window.feed.load([{ id: '3001', text: 'Election.' }]));
  await expect(article(page, '3001')).toBeVisible();
  expect(calls).toHaveLength(1);
  const view = await popup();
  await expect(view.locator('#status')).toContainText('TypeSafe rejected your key');
  await expect(view.locator('#debug')).toBeHidden();
});

test('pausing reloads Home unfiltered and resuming filters it again', async () => {
  const { page, configure } = await launch();
  await configure({});
  await page.goto('https://x.com/home');
  await expect(article(page, '1001')).toHaveCount(0);
  let reloaded = page.waitForEvent('domcontentloaded');
  await configure({ enabled: false });
  await reloaded;
  await expect(article(page, '1001')).toBeVisible();
  reloaded = page.waitForEvent('domcontentloaded');
  await configure({});
  await reloaded;
  await expect(article(page, '1002')).toBeVisible();
  await expect(article(page, '1001')).toHaveCount(0);
});

test('the optional Filtered tab shows hidden posts as read-only cards', async () => {
  const { page, configure } = await launch();
  await configure({ showFilteredTab: true });
  await page.goto('https://x.com/home');
  await page.getByRole('tab', { name: 'Filtered (1)' }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('Election campaign');
  await expect(panel.getByRole('link', { name: 'Open original post' })).toHaveAttribute('href', 'https://x.com/i/status/1001');
  await page.getByRole('tab', { name: 'For you', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(article(page, '1002')).toBeVisible();
});

test('the dev build logs the whole pipeline and exports it without the API key', async () => {
  const { page, configure, popup } = await launch({ build: 'dist-dev' });
  await configure({});
  await page.goto('https://x.com/home');
  await expect(article(page, '1001')).toHaveCount(0);
  const view = await popup();
  await expect(view.locator('#debug')).toBeVisible();
  const events = () => view.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('ownyourtimeline-debug');
    open.onsuccess = () => {
      const read = open.result.transaction('events').objectStore('events').getAll();
      read.onsuccess = () => { open.result.close(); resolve(read.result.map(entry => entry.event)); };
    };
  }));
  await expect.poll(events).toContain('delivery');
  const download = view.waitForEvent('download');
  await view.locator('#exportLog').click();
  const text = await readFile(await (await download).path(), 'utf8');
  const exported = JSON.parse(text).events.map(entry => entry.event);
  for (const event of ['timeline-response', 'extracted-inputs', 'classify-request', 'provider-request', 'provider-response', 'classify-results', 'delivery']) {
    expect(exported).toContain(event);
  }
  expect(text).toContain('Election campaign');
  expect(text).not.toContain(KEY);
  await view.locator('#clearLog').click();
  await expect(view.locator('#debugStatus')).toHaveText('Log cleared.');
  expect(await events()).toEqual([]);
});
