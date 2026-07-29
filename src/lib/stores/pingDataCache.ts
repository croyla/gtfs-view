import type { BlockPingData } from '../services/schedule/schedulePings';
import type { BlockMetrics } from '../services/schedule/scheduleMetrics';

export interface CachedSchedule {
  pingData: BlockPingData;
  metrics:  BlockMetrics;
}

// Persistent cache: localStorage under 'gtfs-pd:<blockId>:<date>'
// In-memory tier avoids repeated JSON.parse for the same session.
//
// Only days strictly before today are cached — today's operations may still be
// running, so its ping data isn't final yet (see App.svelte date selection).

const LS_PREFIX           = 'gtfs-pd:';
const MAX_CACHE_AGE_DAYS  = 30;
const mem                 = new Map<string, CachedSchedule>();

function memKey(blockId: string, date: string)  { return `${blockId}\0${date}`; }
function lsKey(blockId:  string, date: string)  { return `${LS_PREFIX}${blockId}:${date}`; }

function dateStr(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function isBeforeToday(date: string): boolean {
  return date < dateStr(new Date());
}

// Cache keys are `gtfs-pd:<blockId>:<date>` — date is the trailing 8-digit segment.
function dateFromKey(key: string): string {
  return key.slice(key.lastIndexOf(':') + 1);
}

function ourKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LS_PREFIX)) keys.push(k);
  }
  return keys;
}

// Evict entries older than MAX_CACHE_AGE_DAYS. Cheap no-op scan on every write.
function pruneOldEntries(): void {
  const cutoff = dateStr(new Date(Date.now() - MAX_CACHE_AGE_DAYS * 86400_000));
  for (const k of ourKeys()) {
    if (dateFromKey(k) < cutoff) localStorage.removeItem(k);
  }
}

// Reactive fallback for QuotaExceededError: evict the oldest half of our entries
// by date (not insertion order), so the most recently-relevant days survive.
function evictOldestHalf(): void {
  const keys = ourKeys().sort((a, b) => dateFromKey(a).localeCompare(dateFromKey(b)));
  for (const k of keys.slice(0, Math.ceil(keys.length / 2))) localStorage.removeItem(k);
}

export function pingCacheGet(blockId: string, date: string): CachedSchedule | undefined {
  const mk = memKey(blockId, date);
  if (mem.has(mk)) return mem.get(mk)!;
  try {
    const raw = localStorage.getItem(lsKey(blockId, date));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as CachedSchedule;
    // Discard entries written by older code that stored BlockPingData directly
    if (!v.pingData || !v.metrics) return undefined;
    mem.set(mk, v);
    return v;
  } catch { return undefined; }
}

export function pingCacheSet(blockId: string, date: string, data: CachedSchedule): void {
  // Today's data isn't final — never persist it, so tomorrow's real result
  // doesn't get shadowed by a stale in-progress snapshot.
  if (!isBeforeToday(date)) return;

  mem.set(memKey(blockId, date), data);
  try {
    pruneOldEntries();
    localStorage.setItem(lsKey(blockId, date), JSON.stringify(data));
  } catch {
    // QuotaExceededError — evict oldest half of our entries then retry once
    evictOldestHalf();
    try { localStorage.setItem(lsKey(blockId, date), JSON.stringify(data)); } catch { /* give up */ }
  }
}
