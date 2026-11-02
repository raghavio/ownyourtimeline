// Runs in the page's MAIN world. No Chrome APIs or API keys belong here.
export function installTimelineInterceptor(options: {
  transform: (body: unknown, operation: string, onDelivery: (callback: (applied: boolean) => void) => void) => Promise<unknown | null>;
  timeoutMs?: number;
  enabled?: () => boolean;
}) {
  const NativeXHR = window.XMLHttpRequest;
  const nativeFetch = window.fetch;
  let active = true;
  const pending = new Set<() => void>();
  const timeoutMs = Math.min(60000, Math.max(50, options.timeoutMs ?? 2500));
  const textGetter = Object.getOwnPropertyDescriptor(NativeXHR.prototype, 'responseText')?.get;
  const responseGetter = Object.getOwnPropertyDescriptor(NativeXHR.prototype, 'response')?.get;

  function operation(raw: string) {
    if (!active || options.enabled?.() === false || location.pathname !== '/home') return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:' || !['x.com', 'api.x.com', 'twitter.com', 'api.twitter.com'].includes(url.hostname)) return null;
      return url.pathname.match(/\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/)?.[1] ?? null;
    } catch { return null; }
  }

  async function process(body: unknown, op: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let completed = false;
    let settled: boolean | undefined;
    const callbacks: Array<(applied: boolean) => void> = [];
    const settle = (applied: boolean) => {
      if (settled !== undefined) return;
      settled = applied;
      for (const callback of callbacks.splice(0)) {
        try { callback(applied); } catch { /* Reporting must not break delivery. */ }
      }
    };
    const onDelivery = (callback: (applied: boolean) => void) => {
      if (settled === undefined) callbacks.push(callback);
      else { try { callback(settled); } catch { /* Late transform reporting. */ } }
    };
    const delivery = (body: unknown | null) => ({ body,
      commit: () => settle(completed && active), discard: () => settle(false) });
    try {
      const fallback = new Promise<null>(resolve => {
        cancel = () => resolve(null);
        pending.add(cancel);
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      // A copy protects the original if a transform partially mutates then fails.
      const result = await Promise.race([
        Promise.resolve().then(async () => {
          const value = await options.transform(structuredClone(body), op, onDelivery);
          return { value };
        }),
        fallback,
      ]);
      completed = result !== null;
      const changed = active && result !== null && result.value !== null && result.value !== undefined;
      return delivery(changed ? result.value : null);
    } catch { return delivery(null); }
    finally {
      clearTimeout(timer);
      if (cancel) pending.delete(cancel);
    }
  }

  const WrappedXHR = new Proxy(NativeXHR, {
    construct(Target, args, NewTarget) {
      const xhr = Reflect.construct(Target, args, NewTarget) as XMLHttpRequest;
      const nativeOpen = xhr.open;
      let op: string | null = null;
      let async = true;
      let version = 0;
      let phase: 'native' | 'waiting' | 'ready' = 'native';
      let replacementText: string | undefined;
      let replacementJSON: unknown;
      const events: Array<{ type: string; loaded: number; total: number; lengthComputable: boolean }> = [];
      const replayed = new WeakSet<Event>();
      Object.defineProperties(xhr, {
        responseText: { configurable: true, get() { return replacementText ?? textGetter!.call(xhr); } },
        response: { configurable: true, get() {
          if (replacementText === undefined) return responseGetter!.call(xhr);
          return xhr.responseType === 'json' ? replacementJSON : replacementText;
        } },
      });
      xhr.open = function (...openArgs: Parameters<XMLHttpRequest['open']>) {
        version++;
        op = operation(String(openArgs[1]));
        async = openArgs[2] !== false;
        phase = 'native';
        replacementText = undefined;
        replacementJSON = undefined;
        events.length = 0;
        return Reflect.apply(nativeOpen, xhr, openArgs);
      } as XMLHttpRequest['open'];

      // Installed before the caller can register listeners or onload handlers.
      // Buffer final native events, then deliver them against the same native
      // XHR instance once asynchronous classification completes. No network
      // replay, altered credentials, forged requests or React DOM manipulation.
      function gate(event: Event) {
        if (replayed.has(event) || phase === 'ready') return;
        if (!op || !async || !active || options.enabled?.() === false || xhr.readyState !== 4 || xhr.status !== 200
          || !['', 'text', 'json'].includes(xhr.responseType)) return;
        event.stopImmediatePropagation();
        const progress = event as ProgressEvent;
        events.push({ type: event.type, loaded: progress.loaded ?? 0, total: progress.total ?? 0, lengthComputable: progress.lengthComputable ?? false });
        if (phase === 'waiting') return;
        phase = 'waiting';
        const currentVersion = version;
        const currentOp = op;
        void (async () => {
          try {
            const body = xhr.responseType === 'json' ? responseGetter!.call(xhr) : JSON.parse(textGetter!.call(xhr));
            const result = await process(body, currentOp);
            if (version !== currentVersion || xhr.readyState !== 4 || xhr.status !== 200) { result.discard(); return; }
            try {
              if (result.body !== null) {
                const encoded = JSON.stringify(result.body);
                replacementJSON = result.body;
                replacementText = encoded;
              }
              result.commit();
            } catch { result.discard(); }
          } catch { /* Malformed/unsupported content is delivered unchanged. */ }
          finally {
            if (version === currentVersion && xhr.readyState === 4 && xhr.status === 200) {
              phase = 'ready';
              const queued = events.splice(0);
              for (const info of queued) {
                const replay = info.type === 'readystatechange' ? new Event(info.type) : new ProgressEvent(info.type, info);
                replayed.add(replay);
                xhr.dispatchEvent(replay);
                // Event handlers may reopen/abort this XHR. Retire old events.
                if (version !== currentVersion || xhr.readyState !== 4) break;
              }
            }
          }
        })();
      }
      for (const type of ['readystatechange', 'load', 'loadend']) xhr.addEventListener(type, gate, true);
      return xhr;
    },
  });

  async function wrappedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const result = await Reflect.apply(nativeFetch, this, [input, init]) as Response;
    const op = operation(input instanceof Request ? input.url : String(input));
    if (!op || result.status !== 200) return result;
    try {
      const body = await result.clone().json();
      const modified = await process(body, op);
      try {
      if (input instanceof Request && input.signal.aborted || init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (modified.body === null) { modified.commit(); return result; }
      const headers = new Headers(result.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      const replacement = new Response(JSON.stringify(modified.body), { status: result.status, statusText: result.statusText, headers });
      for (const field of ['url', 'redirected', 'type'] as const) Object.defineProperty(replacement, field, { value: result[field] });
      modified.commit();
      return replacement;
      } catch (error) { modified.discard(); throw error; }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return result;
    }
  }
  window.XMLHttpRequest = WrappedXHR;
  window.fetch = wrappedFetch;
  return () => {
    active = false;
    if (window.XMLHttpRequest === WrappedXHR) window.XMLHttpRequest = NativeXHR;
    if (window.fetch === wrappedFetch) window.fetch = nativeFetch;
    for (const cancel of pending) cancel();
    pending.clear();
  };
}
