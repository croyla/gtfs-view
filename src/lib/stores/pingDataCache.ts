import type { BlockPingData } from '../services/schedule/schedulePings';
import type { BlockMetrics } from '../services/schedule/scheduleMetrics';

export interface CachedSchedule {
  pingData: BlockPingData;
  metrics:  BlockMetrics;
}

// Persistent cache: localStorage under 'gtfs-pd:<blockId>:<date>'
// In-memory tier avoids repeated JSON.parse for the same session.

const LS_PREFIX = 'gtfs-pd:';
const mem       = new Map<string, CachedSchedule>();

function memKey(blockId: string, date: string)  { return `${blockId}\0${date}`; }
function lsKey(blockId:  string, date: string)  { return `${LS_PREFIX}${blockId}:${date}`; }

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
  mem.set(memKey(blockId, date), data);
  try {
    localStorage.setItem(lsKey(blockId, date), JSON.stringify(data));
  } catch {
    // QuotaExceededError — prune oldest half of our entries then retry once
    const ours: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) ours.push(k);
    }
    for (const k of ours.slice(0, Math.ceil(ours.length / 2))) localStorage.removeItem(k);
    try { localStorage.setItem(lsKey(blockId, date), JSON.stringify(data)); } catch { /* give up */ }
  }
}