import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/timeline-interceptor.ts'], bundle: true, write: false, format: 'iife', globalName: 'PFInterceptor', target: 'chrome120' });
const source = bundled.outputFiles[0].text;
const original = { entries: ['keep', 'remove'], cursor: 'fixture-cursor' };
async function open(page) {
  await page.route('https://x.com/**', route => route.request().url().includes('/graphql/')
    ? route.fulfill({ json: original })
    : route.fulfill({ contentType: 'text/html', body: '<main>Local fixture</main>' }));
  await page.goto('https://x.com/home');
  await page.evaluate(source + ';window.PFInterceptor = PFInterceptor;');
}

test('async XHR filtering buffers final events for properties and event listeners', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const cleanup = PFInterceptor.installTimelineInterceptor({ transform: async body => {
      await new Promise(resolve => setTimeout(resolve, 50));
      body.entries = ['keep']; return body;
    } });
    try {
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const seen = [];
        xhr.onreadystatechange = () => { if (xhr.readyState === 4) seen.push(['state', JSON.parse(xhr.responseText).entries]); };
        xhr.addEventListener('load', () => seen.push(['listener', JSON.parse(xhr.response).entries]));
        xhr.onload = () => seen.push(['property', JSON.parse(xhr.responseText).entries]);
        xhr.onloadend = () => resolve({ seen, nativeInstance: xhr instanceof XMLHttpRequest, cursor: JSON.parse(xhr.responseText).cursor });
        xhr.onerror = reject;
        xhr.open('GET', '/i/api/graphql/fixture/HomeTimeline'); xhr.send();
      });
    } finally { cleanup(); }
  });
  expect(result).toEqual({ seen: [['state', ['keep']], ['listener', ['keep']], ['property', ['keep']]], nativeInstance: true, cursor: 'fixture-cursor' });
});

test('JSON XHR and reused native instances receive independently filtered results', async ({ page }) => {
  await open(page);
  const values = await page.evaluate(async () => {
    let count = 0;
    const cleanup = PFInterceptor.installTimelineInterceptor({ transform: async body => { body.entries = [String(++count)]; return body; } });
    const xhr = new XMLHttpRequest();
    const load = () => new Promise((resolve, reject) => {
      xhr.onload = () => resolve(xhr.response.entries);
      xhr.onerror = reject;
      xhr.open('GET', '/i/api/graphql/fixture/HomeLatestTimeline'); xhr.responseType = 'json'; xhr.send();
    });
    try { return [await load(), await load()]; } finally { cleanup(); }
  });
  expect(values).toEqual([['1'], ['2']]);
});

test('fetch filtering preserves URL/status and cursor; cleanup restores original fetch', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const native = fetch;
    const cleanup = PFInterceptor.installTimelineInterceptor({ transform: async body => { body.entries = ['keep']; return body; } });
    try {
      const response = await fetch('/i/api/graphql/fixture/HomeTimeline');
      return { url: response.url, status: response.status, body: await response.json() };
    } finally { cleanup(); if (fetch !== native) throw new Error('Fetch not restored'); }
  });
  expect(result).toEqual({ url: 'https://x.com/i/api/graphql/fixture/HomeTimeline', status: 200, body: { entries: ['keep'], cursor: 'fixture-cursor' } });
});

test('timeout and transformation failure deliver original response without late edits', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const results = [];
    for (const failure of ['timeout', 'throw']) {
      const cleanup = PFInterceptor.installTimelineInterceptor({ timeoutMs: 50, transform: async body => {
        body.entries = ['bad'];
        if (failure === 'throw') throw new Error('fixture');
        await new Promise(resolve => setTimeout(resolve, 150));
        return body;
      } });
      try {
        results.push(await new Promise(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve(JSON.parse(xhr.responseText));
          xhr.open('GET', '/i/api/graphql/fixture/HomeTimeline'); xhr.send();
        }));
      } finally { cleanup(); }
    }
    return results;
  });
  expect(result).toEqual([original, original]);
});

test('delivery acknowledgement follows actual response replacement, including timeout and serialization fallback', async ({ page }) => {
  await open(page);
  const results = await page.evaluate(async () => {
    const results = [];
    for (const transport of ['fetch', 'xhr']) for (const scenario of ['success', 'timeout', 'serialization']) {
      const acknowledgements = [];
      const cleanup = PFInterceptor.installTimelineInterceptor({ timeoutMs: 50,
        transform: async (body, _operation, onDelivery) => {
          onDelivery(applied => acknowledgements.push(applied));
          if (scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 100));
          body.entries = ['keep'];
          if (scenario === 'serialization') body.invalid = 1n;
          return body;
        },
      });
      try {
        const body = transport === 'fetch' ? await (await fetch('/i/api/graphql/fixture/HomeTimeline')).json()
          : await new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            xhr.onload = () => resolve(JSON.parse(xhr.responseText));
            xhr.open('GET', '/i/api/graphql/fixture/HomeTimeline'); xhr.send();
          });
        await new Promise(resolve => setTimeout(resolve, 120));
        results.push({ transport, scenario, body, acknowledgements });
      } finally { cleanup(); }
    }
    return results;
  });
  for (const { scenario, body, acknowledgements } of results) {
    expect(body).toEqual(scenario === 'success' ? { entries: ['keep'], cursor: 'fixture-cursor' } : original);
    expect(acknowledgements).toEqual([scenario === 'success']);
  }
});

test('disabled interception preserves native completion events', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const cleanup = PFInterceptor.installTimelineInterceptor({ enabled: () => false, transform: async () => { throw new Error('Must not be called'); } });
    try { return await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.onload = event => resolve({ trusted: event.isTrusted, body: JSON.parse(xhr.responseText) });
      xhr.open('GET', '/i/api/graphql/fixture/HomeTimeline'); xhr.send();
    }); } finally { cleanup(); }
  });
  expect(result).toEqual({ trusted: true, body: original });
});

test('abort during async classification does not replay successful completion', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const cleanup = PFInterceptor.installTimelineInterceptor({ transform: async body => {
      await new Promise(resolve => setTimeout(resolve, 100)); return body;
    } });
    let loaded = 0;
    const xhr = new XMLHttpRequest();
    xhr.onload = () => loaded++;
    xhr.open('GET', '/i/api/graphql/fixture/HomeTimeline'); xhr.send();
    await new Promise(resolve => setTimeout(resolve, 30));
    xhr.abort();
    await new Promise(resolve => setTimeout(resolve, 150));
    cleanup();
    return loaded;
  });
  expect(result).toBe(0);
});

test('non-Home operations bypass transformation; cleanup releases waiting requests', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    let called = 0;
    const cleanup = PFInterceptor.installTimelineInterceptor({ transform: async () => { called++; return new Promise(() => {}); } });
    const other = await (await fetch('/i/api/graphql/fixture/Viewer')).json();
    const pending = fetch('/i/api/graphql/fixture/HomeTimeline').then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 50));
    cleanup();
    return { called, other, pending: await pending };
  });
  expect(result).toEqual({ called: 1, other: original, pending: original });
});
