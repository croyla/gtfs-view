import type { GtfsData } from './types';
import type { VehiclePosition } from './liveTypes';
import { haversineKm, parseTimeMin } from './popupUtils';

// ── Matching constants ────────────────────────────────────────────────────────

const SEQ_STOP_KM         = 0.15;  // 150 m – ping-to-stop match radius
const REVERSAL_THRESHOLD  = 3;     // consecutive backward steps before splitting a run
const BLOCK_PRE_SLACK_MIN = 10;    // {user-configurable} minutes before block start to include pings

// ── Interfaces ────────────────────────────────────────────────────────────────

/** A raw ping with its local-time pre-computed, sorted ascending. */
export interface PingWithTime {
  p: VehiclePosition;
  t: number;  // minutes since local midnight
}

/** One stop's match result from the sequential algorithm. */
export interface StopMatch {
  stopIndex:    number;
  stopId:       string;
  stopName:     string;
  schedMin:     number;
  cumDistKm:    number;
  matchedPing:  VehiclePosition | null;
  matchedPingT: number | null;
  devMin:       number | null;  // positive = late vs schedule
  visited:      boolean;
}

/**
 * All stop matches and raw pings assigned to one trip after the sequential
 * algorithm. Pings outside every trip's observation window are not stored.
 */
export interface TripRecord {
  tid:         string;
  stopMatches: StopMatch[];
  pings:       VehiclePosition[];  // all pings in [firstVisitedT, lastVisitedT]
}

/** Output of the ping-matching phase, before any metric scoring. */
export interface BlockPingData {
  tripRecords:  TripRecord[];
  skippedCount: number;   // trips with no ping match at all
  error?:       'no_match'; // set when no pings landed near any stop (3.C)
}

// ── Private stop geometry ─────────────────────────────────────────────────────

interface StopInfo {
  lat:      number;
  lon:      number;
  schedMin: number;
  cumDist:  number;
  stopId:   string;
  stopName: string;
}

// ── Epoch → local-time conversion ────────────────────────────────────────────

/**
 * Create a memoised epoch→minutes converter for a given timezone.
 * Build once per timezone; the returned function is O(1) after the first call
 * for each unique timestamp.
 */
export function makeEpochToMin(tz: string): (epoch: number) => number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const cache = new Map<number, number>();
  return (epoch: number) => {
    let v = cache.get(epoch);
    if (v === undefined) {
      const parts = fmt.formatToParts(new Date(epoch * 1000));
      v = +parts.find(p => p.type === 'hour')!.value   * 60
        + +parts.find(p => p.type === 'minute')!.value
        + +parts.find(p => p.type === 'second')!.value / 60;
      cache.set(epoch, v);
    }
    return v;
  };
}

// ── Sorted ping builder ───────────────────────────────────────────────────────

/**
 * Pre-compute local-time for every ping and sort ascending.
 * Build once per reactive cycle and share across all matching functions.
 */
export function buildSortedPings(
  pings:      VehiclePosition[],
  epochToMin: (e: number) => number,
): PingWithTime[] {
  return pings
    .map(p => ({ p, t: epochToMin(p.timestamp) }))
    .sort((a, b) => a.t - b.t);
}






// ── Binary search ─────────────────────────────────────────────────────────────

export function lowerBound(arr: PingWithTime[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ── Stop geometry helpers ─────────────────────────────────────────────────────

function buildStopInfos(tid: string, gtfsData: GtfsData): StopInfo[] {
  const sts    = gtfsData.stopTimesByTrip.get(tid) ?? [];
  const result: StopInfo[] = [];
  let cumDist  = 0;
  for (let i = 0; i < sts.length; i++) {
    const stop = gtfsData.stops.get(sts[i].stop_id);
    if (i > 0 && stop) {
      const prev = gtfsData.stops.get(sts[i - 1].stop_id);
      if (prev) cumDist += haversineKm(prev.stop_lat, prev.stop_lon, stop.stop_lat, stop.stop_lon);
    }
    result.push({
      lat:      stop?.stop_lat ?? 0,
      lon:      stop?.stop_lon ?? 0,
      schedMin: parseTimeMin(sts[i].arrival_time || sts[i].departure_time),
      cumDist,
      stopId:   sts[i].stop_id,
      stopName: stop?.stop_name ?? '',
    });
  }
  return result;
}

function emptyMatch(info: StopInfo, i: number): StopMatch {
  return {
    stopIndex: i, stopId: info.stopId, stopName: info.stopName,
    schedMin: info.schedMin, cumDistKm: info.cumDist,
    matchedPing: null, matchedPingT: null, devMin: null, visited: false,
  };
}

// ── Ping partitioning ─────────────────────────────────────────────────────────

function getPingsInWindow(
  tFirst:      number,
  tLast:       number,
  sortedPings: PingWithTime[],
): VehiclePosition[] {
  const lo     = lowerBound(sortedPings, tFirst);
  const result: VehiclePosition[] = [];
  for (let i = lo; i < sortedPings.length && sortedPings[i].t <= tLast; i++) {
    result.push(sortedPings[i].p);
  }
  return result;
}

// ── Phase 1: Global stop-ping matching ────────────────────────────────────────

/** For each (trip, stop) pair, collect all pings within SEQ_STOP_KM. */
function buildGlobalStopMatches(
  allStopInfos: StopInfo[][],
  pings:        PingWithTime[],
): PingWithTime[][][] {
  return allStopInfos.map(infos =>
    infos.map(info =>
      pings.filter(pw => haversineKm(info.lat, info.lon, pw.p.lat, pw.p.lon) < SEQ_STOP_KM),
    ),
  );
}

type BlockCoverage = 'correct' | 'partial' | 'inaccurate';

function assessCoverage(globalMatches: PingWithTime[][][]): BlockCoverage {
  const total   = globalMatches.reduce((s, trip) => s + trip.length, 0);
  const matched = globalMatches.reduce((s, trip) => s + trip.filter(ps => ps.length > 0).length, 0);
  if (matched === 0)     return 'inaccurate';
  if (matched === total) return 'correct';
  return 'partial';
}

// ── Phase 3A: Correct-run trip records ────────────────────────────────────────

/**
 * All (trip, stop) pairs matched — for each, pick the ping closest to its
 * scheduled time. Temporal disambiguation handles stops shared across trips.
 */
function buildCorrectTripRecords(
  sortedTripIds: string[],
  allStopInfos:  StopInfo[][],
  globalMatches: PingWithTime[][][],
  allPings:      PingWithTime[],
): TripRecord[] {
  return sortedTripIds.map((tid, i) => {
    const stopMatches: StopMatch[] = allStopInfos[i].map((info, j) => {
      const candidates = globalMatches[i][j];
      if (candidates.length === 0) return emptyMatch(info, j);
      const best = candidates.reduce((a, b) =>
        Math.abs(a.t - info.schedMin) < Math.abs(b.t - info.schedMin) ? a : b,
      );
      return {
        stopIndex: j, stopId: info.stopId, stopName: info.stopName,
        schedMin: info.schedMin, cumDistKm: info.cumDist,
        matchedPing: best.p, matchedPingT: best.t,
        devMin: best.t - info.schedMin, visited: true,
      };
    });
    const visited = stopMatches.filter(m => m.visited);
    const pings = visited.length >= 2
      ? getPingsInWindow(visited[0].matchedPingT!, visited.at(-1)!.matchedPingT!, allPings)
      : visited.length === 1 ? [visited[0].matchedPing!] : [];
    return { tid, stopMatches, pings };
  });
}

// ── Phase 3B: Pattern-based partial matching ──────────────────────────────────

interface StopVisit {
  stopId: string;
  pingT:  number;
  ping:   VehiclePosition;
  distKm: number;
}

/**
 * Walk pings in time order; when one lands within SEQ_STOP_KM of any block stop,
 * record the nearest stop. Deduplicate consecutive visits to the same stop,
 * keeping the closest ping.
 */
function buildStopVisitSequence(
  pings:        PingWithTime[],
  allStopInfos: StopInfo[][],
): StopVisit[] {
  const stopById = new Map<string, StopInfo>();
  for (const infos of allStopInfos)
    for (const info of infos)
      if (!stopById.has(info.stopId)) stopById.set(info.stopId, info);

  const visits: StopVisit[] = [];
  let lastStopId = '';

  for (const pw of pings) {
    let nearestId   = '';
    let nearestDist = SEQ_STOP_KM;
    for (const [id, info] of stopById) {
      const d = haversineKm(info.lat, info.lon, pw.p.lat, pw.p.lon);
      if (d < nearestDist) { nearestDist = d; nearestId = id; }
    }
    if (!nearestId) continue;

    if (nearestId === lastStopId && visits.length > 0) {
      if (nearestDist < visits.at(-1)!.distKm)
        visits[visits.length - 1] = { stopId: nearestId, pingT: pw.t, ping: pw.p, distKm: nearestDist };
    } else {
      visits.push({ stopId: nearestId, pingT: pw.t, ping: pw.p, distKm: nearestDist });
      lastStopId = nearestId;
    }
  }
  return visits;
}

/**
 * Split the stop-visit sequence into directional runs. A run boundary fires
 * when REVERSAL_THRESHOLD consecutive visits step backward relative to every
 * trip that shares both the previous and current stop.
 */
function segmentVisitsIntoRuns(
  visits:       StopVisit[],
  allStopInfos: StopInfo[][],
): StopVisit[][] {
  if (visits.length === 0) return [];

  const stopOrder = allStopInfos.map(infos => {
    const m = new Map<string, number>();
    infos.forEach((info, j) => m.set(info.stopId, j));
    return m;
  });

  const runs: StopVisit[][] = [];
  let currentRun: StopVisit[] = [visits[0]];
  let reversalCount = 0;

  for (let v = 1; v < visits.length; v++) {
    const prevId = visits[v - 1].stopId;
    const currId = visits[v].stopId;

    let isForward = false;
    let anyShared = false;
    for (let t = 0; t < allStopInfos.length; t++) {
      const pi = stopOrder[t].get(prevId);
      const ci = stopOrder[t].get(currId);
      if (pi !== undefined && ci !== undefined) {
        anyShared = true;
        if (ci > pi) { isForward = true; break; }
      }
    }

    if (!anyShared || isForward) {
      currentRun.push(visits[v]);
      reversalCount = 0;
    } else if (++reversalCount >= REVERSAL_THRESHOLD) {
      runs.push(currentRun);
      currentRun    = [visits[v]];
      reversalCount = 0;
    } else {
      currentRun.push(visits[v]);
    }
  }
  runs.push(currentRun);
  return runs.filter(r => r.length > 0);
}

/**
 * Greedily assign each run to the best unmatched trip. Scoring: stop-ID overlap
 * (primary, × 1000) minus temporal distance from run start to trip scheduled
 * start (secondary).
 */
function matchRunsToTrips(
  runs:         StopVisit[][],
  allStopInfos: StopInfo[][],
): Map<number, number> {
  const assigned = new Set<number>();
  const result   = new Map<number, number>();

  for (let r = 0; r < runs.length; r++) {
    const runStopIds = new Set(runs[r].map(v => v.stopId));
    const runStart   = runs[r][0].pingT;
    let bestTripIdx  = -1;
    let bestScore    = -Infinity;

    for (let t = 0; t < allStopInfos.length; t++) {
      if (assigned.has(t)) continue;
      const overlap  = allStopInfos[t].filter(info => runStopIds.has(info.stopId)).length;
      if (overlap === 0) continue;
      const timeDiff = Math.abs(runStart - (allStopInfos[t][0]?.schedMin ?? 0));
      const score    = overlap * 1000 - timeDiff;
      if (score > bestScore) { bestScore = score; bestTripIdx = t; }
    }

    if (bestTripIdx >= 0) { result.set(r, bestTripIdx); assigned.add(bestTripIdx); }
  }
  return result;
}

/**
 * Build TripRecords for a partial run. Trims pings before the first stop match,
 * segments the visit sequence into directional runs, and matches each run to the
 * temporally closest trip with overlapping stops.
 */
function buildPartialTripRecords(
  sortedTripIds: string[],
  allStopInfos:  StopInfo[][],
  pings:         PingWithTime[],
): TripRecord[] {
  // Trim pings before first stop match
  let firstMatchT = Infinity;
  outer: for (const pw of pings) {
    for (const infos of allStopInfos)
      for (const info of infos)
        if (haversineKm(info.lat, info.lon, pw.p.lat, pw.p.lon) < SEQ_STOP_KM) {
          firstMatchT = pw.t; break outer;
        }
  }
  const trimmed = firstMatchT === Infinity ? pings : pings.filter(pw => pw.t >= firstMatchT);

  const visits    = buildStopVisitSequence(trimmed, allStopInfos);
  const runs      = segmentVisitsIntoRuns(visits, allStopInfos);
  const runToTrip = matchRunsToTrips(runs, allStopInfos);

  return sortedTripIds.map((tid, tripIdx) => {
    const runIdx = [...runToTrip.entries()].find(([, t]) => t === tripIdx)?.[0];
    if (runIdx === undefined)
      return { tid, stopMatches: allStopInfos[tripIdx].map((s, j) => emptyMatch(s, j)), pings: [] };

    // Earlier visit wins for each stop (first time the vehicle reaches it in this run)
    const visitMap = new Map<string, StopVisit>();
    for (const v of runs[runIdx])
      if (!visitMap.has(v.stopId)) visitMap.set(v.stopId, v);

    const stopMatches: StopMatch[] = allStopInfos[tripIdx].map((info, j) => {
      const v = visitMap.get(info.stopId);
      if (!v) return emptyMatch(info, j);
      return {
        stopIndex: j, stopId: info.stopId, stopName: info.stopName,
        schedMin: info.schedMin, cumDistKm: info.cumDist,
        matchedPing: v.ping, matchedPingT: v.pingT,
        devMin: v.pingT - info.schedMin, visited: true,
      };
    });

    const visited = stopMatches.filter(m => m.visited);
    const pingWindow = visited.length >= 2
      ? getPingsInWindow(visited[0].matchedPingT!, visited.at(-1)!.matchedPingT!, pings)
      : visited.length === 1 ? [visited[0].matchedPing!] : [];
    return { tid, stopMatches, pings: pingWindow };
  });
}

// ── matchBlockPings ───────────────────────────────────────────────────────────

/**
 * Match vehicle pings to a block's trips and return structured TripRecords.
 *
 * Phase 1 — Global: for every (trip, stop) pair, collect pings within SEQ_STOP_KM
 *   starting from BLOCK_PRE_SLACK_MIN before the block's first scheduled departure.
 * Phase 2 — Assess coverage:
 *   2.A All stops matched  → 3.A
 *   2.B/C Partial matches  → 3.B
 *   2.D No matches at all  → 3.C (error)
 * Phase 3A — Correct run: pick temporally-closest ping per (trip, stop).
 * Phase 3B — Partial run: trim pre-block pings, build a stop-visit sequence,
 *   segment into directional runs, match runs to trips by stop-overlap + time.
 * Phase 3C — Inaccurate: return empty records with error: 'no_match'.
 */
export function matchBlockPings(
  sortedTripIds:      string[],
  sortedVehiclePings: PingWithTime[],
  gtfsData:           GtfsData,
): BlockPingData {
  const n            = sortedTripIds.length;
  const allStopInfos = sortedTripIds.map(tid => buildStopInfos(tid, gtfsData));

  const blockStartMin = allStopInfos[0]?.[0]?.schedMin ?? 0;
  const relevant      = sortedVehiclePings.filter(pw => pw.t >= blockStartMin - BLOCK_PRE_SLACK_MIN);

  // Phase 1
  const globalMatches = buildGlobalStopMatches(allStopInfos, relevant);

  // Phase 2
  const coverage = assessCoverage(globalMatches);

  // Phase 3C
  if (coverage === 'inaccurate') {
    return {
      tripRecords:  sortedTripIds.map((tid, i) => ({
        tid,
        stopMatches: allStopInfos[i].map((s, j) => emptyMatch(s, j)),
        pings: [],
      })),
      skippedCount: n,
      error: 'no_match',
    };
  }

  // Phase 3A
  if (coverage === 'correct') {
    const tripRecords = buildCorrectTripRecords(sortedTripIds, allStopInfos, globalMatches, relevant);
    return {
      tripRecords,
      skippedCount: tripRecords.filter(r => !r.stopMatches.some(m => m.visited)).length,
    };
  }

  // Phase 3B
  const tripRecords = buildPartialTripRecords(sortedTripIds, allStopInfos, relevant);
  return {
    tripRecords,
    skippedCount: tripRecords.filter(r => !r.stopMatches.some(m => m.visited)).length,
  };
}