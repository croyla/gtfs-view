const DB_NAME             = 'gtfs-dataviz';
const DB_VERSION          = 1;
const MAX_CACHE_AGE_DAYS  = 30;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bundles'))   db.createObjectStore('bundles');
      if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions');
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror  = () => reject(req.error);
  });
}

function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror  = () => reject(req.error);
  }));
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror  = () => reject(req.error);
  }));
}

function cutoffDateStr(): string {
  const d = new Date(Date.now() - MAX_CACHE_AGE_DAYS * 86400_000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Evict entries older than MAX_CACHE_AGE_DAYS. Keys are YYYYMMDD date strings,
// so lexicographic comparison matches chronological order.
async function pruneOldEntries(store: string): Promise<void> {
  try {
    const cutoff = cutoffDateStr();
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && cursor.key < cutoff) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* ignore */ }
}

// Reactive fallback for QuotaExceededError: evict the oldest `count` entries
// (ascending key order == oldest date first) then let the caller retry.
async function evictOldest(store: string, count: number): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).openCursor();
      let deleted = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || deleted >= count) return;
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* ignore */ }
}

async function putWithEviction(store: string, date: string, value: unknown): Promise<void> {
  try {
    await idbPut(store, date, value);
  } catch {
    await evictOldest(store, 5);
    try { await idbPut(store, date, value); } catch { /* give up — quota / private-mode */ }
  }
  pruneOldEntries(store); // fire-and-forget
}

export async function getCachedBundle<T>(date: string): Promise<T | null> {
  try { return await idbGet<T>('bundles', date); }
  catch { return null; }
}

export async function setCachedBundle(date: string, bundle: unknown): Promise<void> {
  await putWithEviction('bundles', date, bundle);
}

export async function getCachedPositions<T>(date: string): Promise<T[] | null> {
  try { return await idbGet<T[]>('positions', date); }
  catch { return null; }
}

export async function setCachedPositions(date: string, positions: unknown[]): Promise<void> {
  await putWithEviction('positions', date, positions);
}