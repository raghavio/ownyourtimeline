// Dev builds only. Every pipeline stage is recorded in full (X responses,
// extracted inputs, provider requests/responses, outcomes) so a broken session
// can be exported from the popup and replayed. API keys are never recorded.
// Release builds never call into this module, so it is tree-shaken away.
const LIMIT = 500;
let database: Promise<IDBDatabase> | undefined;
let queue: Promise<void> = Promise.resolve();

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('ownyourtimeline-debug', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function store(mode: IDBTransactionMode) {
  return (await open()).transaction('events', mode).objectStore('events');
}

export function log(event: string, data: unknown = {}): void {
  queue = queue.then(async () => {
    const events = await store('readwrite');
    events.add({ at: new Date().toISOString(), event, data });
    const excess = await result(events.count()) - LIMIT;
    if (excess > 0) {
      const keys = await result(events.getAllKeys(null, excess));
      events.delete(IDBKeyRange.upperBound(keys[keys.length - 1]));
    }
  }).catch(() => { /* Logging must never break filtering. */ });
}
export async function readLog(): Promise<unknown[]> {
  await queue;
  return result((await store('readonly')).getAll());
}
export async function clearLog(): Promise<void> {
  await queue;
  await result((await store('readwrite')).clear());
}
