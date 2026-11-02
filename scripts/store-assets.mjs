// Regenerates extension icons and Chrome Web Store images: `npm run store:assets`.
// Screenshots come from the real release build on the local X fixture page with
// a stubbed classifier, so they show actual UI with fictional demo posts.
import { chromium } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { networkBody, networkHtml } from '../tests/fixtures.mjs';

const FONT = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";
const browser = await chromium.launch({ channel: 'chromium' });
const svg = async file => (await readFile(file, 'utf8')).replace(/<svg /, '<svg style="width:100%;height:100%;display:block" ');

async function render(html, width, height, file, transparent = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:${FONT}}</style>${html}`);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}
const dataUrl = buffer => `data:image/png;base64,${buffer.toString('base64')}`;

// Icons: the detailed artwork for 48/128, a simplified mark for toolbar sizes.
const icon = await svg('store/icon.svg'), small = await svg('store/icon-small.svg');
for (const size of [16, 32]) await render(small, size, size, `src/icons/icon${size}.png`, true);
for (const size of [48, 128]) await render(icon, size, size, `src/icons/icon${size}.png`, true);

// Drive the real extension to capture the popup and the Filtered tab.
const posts = [
  { id: '1001', text: 'Senate vote tonight could decide the election campaign. Here is what to watch.', author: { name: 'Demo Politics Desk', handle: '' }, counts: { replies: 4, reposts: 2, likes: 31, views: 1800, bookmarks: 1 } },
  { id: '1002', text: 'Finally got the tomatoes to ripen before the first frost. Patience pays off.', author: { name: 'Demo Gardener', handle: '' }, counts: { replies: 18, reposts: 9, likes: 240, views: 12400, bookmarks: 6 } },
  { id: '1003', text: 'Shipped a tiny CLI that renames photos by the date they were taken. Took an afternoon.', author: { name: 'Demo Developer', handle: '' }, counts: { replies: 7, reposts: 12, likes: 156, views: 9100, bookmarks: 22 } },
  { id: '1004', text: 'Hot take thread on the parliament budget fight. You will not believe part 7.', author: { name: 'Demo Commentator', handle: '' }, counts: { replies: 96, reposts: 41, likes: 380, views: 51000, bookmarks: 3 } },
  { id: '1005', text: 'Morning run along the river. 8 km, fog everywhere, absolutely worth it.', author: { name: 'Demo Runner', handle: '' }, counts: { replies: 3, reposts: 1, likes: 64, views: 2300, bookmarks: 0 } },
  { id: '1006', text: 'New poll: the election is tighter than ever. Retweet if you agree!', author: { name: 'Demo Poll Watch', handle: '' }, counts: { replies: 210, reposts: 88, likes: 640, views: 98000, bookmarks: 4 } },
];
const political = /election|parliament|senate|campaign/i;
const profile = await mkdtemp(path.join(tmpdir(), 'oyt-store-'));
const extension = path.resolve('dist');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
let popupShot, panelShot;
try {
  await context.route('https://x.com/**', route => route.request().url().includes('/i/api/graphql/')
    ? route.fulfill({ json: networkBody(posts) })
    : route.fulfill({ contentType: 'text/html', body: networkHtml }));
  await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#94A3B8"/></svg>' }));
  await context.route('https://api.typesafe.ai/**', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { model: 'jev-1.14.0', usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(body.state.posts).map(([name, post]) =>
        [name.replace('post_', 'hide_'), { type: 'noul', noul: political.test(post.text) ? .97 : .02 }])) } });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ apiKey: 'demo' });
    await chrome.storage.local.set({ settings: { enabled: true, showFilteredTab: true, revision: 1,
      prompt: 'Nothing political, and no engagement bait.' } });
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://x.com/home');
  // The fixture's bare links are browser blue; X renders metadata in grey.
  await page.addStyleTag({ content: 'a { color: #536471; }' });
  await page.getByRole('tab', { name: 'Filtered (3)' }).waitFor();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(new URL('popup.html', worker.url()).href);
  // A real popup reads the active X tab; point this tab-hosted popup at it.
  await popup.evaluate(id => { chrome.tabs.query = async () => [{ id }]; }, tabId);
  await popup.locator('#status', { hasText: 'Filtering this page' }).waitFor();
  popupShot = await popup.locator('main').screenshot();

  await page.bringToFront();
  await page.getByRole('tab', { name: 'Filtered (3)' }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const column = await page.locator('main').boundingBox();
  const tabs = await page.locator('nav[role="tablist"]').boundingBox();
  panelShot = await page.screenshot({ clip: { x: column.x, y: tabs.y, width: column.width, height: 520 } });
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const frame = (title, body, image, imageWidth) => `
<div style="display:flex;align-items:center;gap:64px;width:1280px;height:800px;box-sizing:border-box;padding:0 80px;
  background:linear-gradient(135deg,#F0FDFA 0%,#EEF2FF 100%);color:#0F172A">
  <div style="flex:1">
    <div style="width:72px;height:72px;margin-bottom:28px">${icon}</div>
    <h1 style="font-size:52px;line-height:1.1;margin:0 0 20px;font-weight:700;letter-spacing:-1px">${title}</h1>
    <p style="font-size:22px;line-height:1.5;margin:0;color:#334155">${body}</p>
  </div>
  <img src="${image}" style="width:${imageWidth}px;border-radius:16px;box-shadow:0 24px 60px #0F172A33;background:#fff">
</div>`;
await render(frame('Describe the feed you want.',
  'Write one instruction. OwnYourTimeline checks every post on your X Home feed with TypeSafe and removes the ones that break it, before they render.',
  dataUrl(popupShot), 380), 1280, 800, 'store/screenshot-1.png');
await render(frame('See what was hidden.',
  'Turn on the optional Filtered tab to review hidden posts beside For you and Following. Nothing is stored after you leave the page.',
  dataUrl(panelShot), 560), 1280, 800, 'store/screenshot-2.png');
await render(`<div style="display:flex;align-items:center;justify-content:center;gap:20px;width:440px;height:280px;
  background:radial-gradient(circle at 30% 20%,#1E293B,#0B1120)">
  <div style="width:96px;height:96px;filter:drop-shadow(0 6px 14px #0003)">${icon}</div>
  <div style="color:#fff;font-size:30px;font-weight:700;letter-spacing:-.5px;line-height:1.1">Own Your<br>Timeline</div>
</div>`, 440, 280, 'store/promo-small.png');
await browser.close();
console.log('Wrote src/icons/*.png and store/{screenshot-1,screenshot-2,promo-small}.png');
