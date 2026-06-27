const DB_NAME    = 'gtfs-dataviz';
const DB_VERSION = 1;

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

export async function getCachedBundle<T>(date: string): Promise<T | null> {
  try { return await idbGet<T>('bundles', date); }
  catch { return null; }
}

export async function setCachedBundle(date: string, bundle: unknown): Promise<void> {
  try { await idbPut('bundles', date, bundle); }
  catch { /* ignore quota / private-mode errors */ }
}

export async function getCachedPositions<T>(date: string): Promise<T[] | null> {
  try { return await idbGet<T[]>('positions', date); }
  catch { return null; }
}

export async function setCachedPositions(date: string, positions: unknown[]): Promise<void> {
  try { await idbPut('positions', date, positions); }
  catch { /* ignore */ }
}