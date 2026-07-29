import type { GtfsData } from '../../types/types';
import type { VehiclePosition } from '../../types/liveTypes';
import { haversineKm, parseTimeMin } from '../popupUtils';

// ── Matching constants ────────────────────────────────────────────────────────

const SEQ_STOP_KM         = 0.25;  // 250 m – ping-to-stop match radius
const BLOCK_PRE_SLACK_MIN = 10;    // minutes before block start to include pings

// Ephemeral (interpolated) ping points, inserted along the straight line between
// two consecutive real pings so sparse GPS traces still land within SEQ_STOP_KM of
// a stop. Position and time are both interpolated linearly by distance fraction.
const EPHEMERAL_STEP_KM = 0.005; // 5 m spacing
const EPHEMERAL_MAX_GAP_KM = 2;  // skip interpolation across gaps this large (likely idle/off-route, not a straight path)

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface PingWithTime {
  p: VehiclePosition;
  t: number;  // minutes since local midnight
}

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

export interface TripRecord {
  tid:         string;
  stopMatches: StopMatch[];
  pings:       VehiclePosition[];  // all pings in [firstVisitedT, lastVisitedT]
}

export interface BlockPingData {
  tripRecords:  TripRecord[];
  skippedCount: number;
  error?:       'no_match';
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

export function buildSortedPings(
  pings:      VehiclePosition[],
  epochToMin: (e: number) => number,
): PingWithTime[] {
  return pings
    .map(p => ({ p, t: epochToMin(p.timestamp) }))
    .sort((a, b) => a.t - b.t);
}

// ── Ephemeral ping densification ────────────────────────────────────────────────

/**
 * Densify a time-sorted ping list by inserting ephemeral (synthetic) points every
 * EPHEMERAL_STEP_KM along the straight line between each pair of consecutive real
 * pings. Both position and time are interpolated linearly by distance fraction,
 * i.e. assuming constant speed between the two real pings.
 *
 * Used only to improve stop-visit detection when real GPS pings are sparse — the
 * result must never be surfaced as observed data (data availability, chart dots),
 * only used as a matching aid.
 */
export function buildEphemeralPings(sortedPings: PingWithTime[]): PingWithTime[] {
  const out: PingWithTime[] = [];
  for (let i = 0; i < sortedPings.length; i++) {
    const a = sortedPings[i];
    out.push(a);
    if (i === sortedPings.length - 1) continue;

    const b = sortedPings[i + 1];
    const distKm = haversineKm(a.p.lat, a.p.lon, b.p.lat, b.p.lon);
    if (distKm <= EPHEMERAL_STEP_KM || distKm > EPHEMERAL_MAX_GAP_KM) continue;

    const numSteps = Math.floor(distKm / EPHEMERAL_STEP_KM);
    for (let s = 1; s <= numSteps; s++) {
      const d = s * EPHEMERAL_STEP_KM;
      if (d >= distKm) break;
      const f = d / distKm;
      out.push({
        t: a.t + (b.t - a.t) * f,
        p: {
          id: -1, vehicle_id: a.p.vehicle_id, trip_id: null, route_id: null,
          lat: a.p.lat + (b.p.lat - a.p.lat) * f,
          lon: a.p.lon + (b.p.lon - a.p.lon) * f,
          bearing: null, speed: null, status: '',
          timestamp: a.p.timestamp + (b.p.timestamp - a.p.timestamp) * f,
          interpolated: true,
        },
      });
    }
  }
  return out;
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

// ── Logging helpers ───────────────────────────────────────────────────────────

function fmtMin(t: number): string {
  const h = Math.floor(t / 60);
  const m = Math.floor(t % 60);
  const s = Math.round((t % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Journey builder ───────────────────────────────────────────────────────────

interface JourneyStop {
  stopId: string;
  pingT:  number;
  ping:   VehiclePosition;
  distKm: number;
}

/**
 * Walk pings in time order; for each ping, record the nearest block stop within
 * SEQ_STOP_KM. Deduplicate consecutive visits to the same stop (keep the closest
 * ping). The result is the vehicle's observed stop-visit sequence for the block.
 */
function buildJourney(
  pings:        PingWithTime[],
  allStopInfos: StopInfo[][],
  blockId?:     string,
): JourneyStop[] {
  const stopById = new Map<string, StopInfo>();
  for (const infos of allStopInfos)
    for (const info of infos)
      if (!stopById.has(info.stopId)) stopById.set(info.stopId, info);

  const journey: JourneyStop[] = [];
  let lastStopId = '';

  for (const pw of pings) {
    let nearestId   = '';
    let nearestDist = SEQ_STOP_KM;
    for (const [id, info] of stopById) {
      const d = haversineKm(info.lat, info.lon, pw.p.lat, pw.p.lon);
      if (d < nearestDist) { nearestDist = d; nearestId = id; }
    }
    if (!nearestId) continue;

    if (nearestId === lastStopId && journey.length > 0) {
      // Deduplicate: keep closest ping for the same consecutive stop
      if (nearestDist < journey.at(-1)!.distKm)
        journey[journey.length - 1] = { stopId: nearestId, pingT: pw.t, ping: pw.p, distKm: nearestDist };
    } else {
      journey.push({ stopId: nearestId, pingT: pw.t, ping: pw.p, distKm: nearestDist });
      lastStopId = nearestId;
    }
  }

  const pfx = blockId ? `[block:${blockId}]` : '[block]';
  console.groupCollapsed(`${pfx} journey — ${journey.length} entries from ${pings.length} relevant pings`);
  journey.forEach((j, i) =>
    console.log(`  [${i}] stopId=${j.stopId} t=${fmtMin(j.pingT)} dist=${j.distKm.toFixed(3)}km`),
  );
  console.groupEnd();

  return journey;
}

// ── Journey-to-trip matching ──────────────────────────────────────────────────

/**
 * Greedily find the next forward traversal of `stopIds` in `journey` starting
 * from `cursor`.
 *
 * Three purely-geographic boundaries end the current run early:
 *
 * 1. Terminal detection — if the last stop of the sequence appears in the
 *    journey while we're still seeking intermediate stops, the vehicle has
 *    reached the route terminal. Match it immediately and close the run.
 *    Rationale: on an out-and-back route the inbound leg starts right after
 *    the outbound terminal; any stops seen beyond that point belong to the
 *    next traversal.
 *
 * 2. Sequence regression — if, while seeking stop[i], we encounter a stop
 *    whose position in the sequence is significantly LESS than the highest
 *    position matched so far (`lastMatchedI`), the vehicle is moving backward
 *    through the route.  Threshold is `max(2, ⌊n×0.10⌋)` positions; GPS
 *    noise rarely drifts more than 1–2 positions backward.
 *
 * 3. First-stop restart — if the first stop of the sequence reappears after
 *    the vehicle has already made genuine forward progress (past 35% of the
 *    route by index), a new traversal has started.
 *
 * Stops genuinely absent from this traversal are left null (partial match).
 * Returns lastK = -1 if nothing was found at all.
 */
function findSequenceRun(
  journey: JourneyStop[],
  stopIds: string[],
  cursor:  number,
  pfx?:    string,
): { matches: (number | null)[]; lastK: number } {
  const matches: (number | null)[] = new Array(stopIds.length).fill(null);
  let pos    = cursor;
  let lastK  = -1;
  let runEnd = journey.length;

  const n           = stopIds.length;
  const firstStopId = stopIds[0];
  const lastStopId  = stopIds[n - 1];
  const lastStopIdx = n - 1;

  let firstStopExp = 0;
  for (const sid of stopIds) if (sid === firstStopId) firstStopExp++;

  // Position of each stop in the sequence (first occurrence wins).
  const seqPos = new Map<string, number>();
  for (let i = 0; i < n; i++) if (!seqPos.has(stopIds[i])) seqPos.set(stopIds[i], i);

  const BOUNDARY_MIN_IDX = Math.ceil(n * 0.35);
  const MIN_REGRESSION   = Math.max(2, Math.floor(n * 0.10));

  let firstStopSeen   = 0;
  let lastMatchedI    = -1;
  let terminalMatched = false;

  outer: for (let i = 0; i < n; i++) {
    if (terminalMatched) break;

    for (let k = pos; k < runEnd; k++) {
      const sid = journey[k].stopId;

      // ── 1. Sequence regression ─────────────────────────────────────────────
      // A stop appearing MIN_REGRESSION+ positions BEHIND lastMatchedI means
      // the vehicle is reversing through the route.
      const sIdx = seqPos.get(sid);
      if (sIdx !== undefined && lastMatchedI - sIdx >= MIN_REGRESSION) {
        if (pfx) console.log(
          `${pfx} [regression] k=${k} sid=${sid} seqIdx=${sIdx}` +
          ` lastMatchedI=${lastMatchedI} (Δ=${lastMatchedI - sIdx} ≥ ${MIN_REGRESSION})`,
        );
        runEnd = k;
        break;
      }

      // ── 2. First-stop restart ──────────────────────────────────────────────
      if (
        sid === firstStopId &&
        firstStopSeen >= firstStopExp &&
        lastK > (matches[0] ?? -1) &&
        lastMatchedI >= BOUNDARY_MIN_IDX
      ) {
        if (pfx) console.log(
          `${pfx} [boundary] k=${k} t=${fmtMin(journey[k].pingT)}` +
          ` lastMatchedI=${lastMatchedI}/${n - 1}`,
        );
        runEnd = k;
        break;
      }

      // ── 3. Normal match for current target ────────────────────────────────
      if (sid === stopIds[i]) {
        matches[i] = k;
        if (i > lastMatchedI) lastMatchedI = i;
        if (k > lastK) lastK = k;
        if (sid === firstStopId) firstStopSeen++;
        pos = k + 1;
        break;
      }

      // ── 4. Terminal early detection ────────────────────────────────────────
      // Only fires when seeking an intermediate stop (i < lastStopIdx) and
      // the LAST stop appears — signalling the vehicle reached the terminal
      // before we matched all intermediate stops.
      if (i < lastStopIdx && sid === lastStopId) {
        matches[lastStopIdx] = k;
        if (lastStopIdx > lastMatchedI) lastMatchedI = lastStopIdx;
        if (k > lastK) lastK = k;
        pos = k + 1;
        runEnd = k + 1;
        terminalMatched = true;
        if (pfx) console.log(
          `${pfx} [terminal] k=${k} t=${fmtMin(journey[k].pingT)}` +
          ` early at i=${i}/${lastStopIdx}`,
        );
        break;
      }
    }
  }

  return { matches, lastK };
}

/**
 * Average absolute deviation (minutes) between a run's matched ping times and
 * a trip's scheduled stop times. Returns Infinity if no stops were matched.
 */
function runTripScore(
  run:          { matches: (number | null)[] },
  tripIdx:      number,
  allStopInfos: StopInfo[][],
  journey:      JourneyStop[],
): number {
  const devs: number[] = [];
  for (let j = 0; j < run.matches.length; j++) {
    const k = run.matches[j];
    if (k === null) continue;
    const schedMin = allStopInfos[tripIdx][j]?.schedMin;
    if (schedMin === undefined) continue;
    devs.push(Math.abs(journey[k].pingT - schedMin));
  }
  return devs.length ? devs.reduce((a, b) => a + b) / devs.length : Infinity;
}

/**
 * Greedily pair each run to the temporally closest available trip (O(n²)).
 * Each trip receives at most one run. Unmatched trips receive an array of nulls.
 * Returns both the assignments and any run indices that had no trip to pair with.
 */
function assignRunsToTrips(
  runs:         Array<{ matches: (number | null)[]; lastK: number }>,
  tripIdxs:     number[],
  allStopInfos: StopInfo[][],
  journey:      JourneyStop[],
): { assignments: Map<number, (number | null)[]>; extraRunIdxs: number[] } {
  const assignments    = new Map<number, (number | null)[]>();
  const remainingRuns  = runs.map((_, i) => i);
  const remainingTrips = [...tripIdxs];

  while (remainingTrips.length > 0 && remainingRuns.length > 0) {
    let bestTrip = -1, bestRun = -1, bestScore = Infinity;
    for (const ti of remainingTrips) {
      for (const ri of remainingRuns) {
        const s = runTripScore(runs[ri], ti, allStopInfos, journey);
        if (s < bestScore) { bestScore = s; bestTrip = ti; bestRun = ri; }
      }
    }
    if (bestTrip < 0) break;
    assignments.set(bestTrip, runs[bestRun].matches);
    remainingRuns.splice(remainingRuns.indexOf(bestRun), 1);
    remainingTrips.splice(remainingTrips.indexOf(bestTrip), 1);
  }

  for (const ti of remainingTrips) {
    assignments.set(ti, new Array(allStopInfos[ti].length).fill(null));
  }
  return { assignments, extraRunIdxs: remainingRuns };
}

/**
 * Two-phase matching:
 *   Phase 1 — Geographic: group trips by stop-ID sequence, find each group's
 *             traversals using purely geographic signals — terminal detection
 *             (last stop seen early → traversal complete), sequence regression
 *             (stop appears far behind lastMatchedI → reversal detected), and
 *             first-stop restart. No scheduled times used in this phase.
 *             Each group searches the full journey independently so that
 *             interleaved out-and-back traversals are each found correctly.
 *   Phase 2 — Temporal:  assign each geographic run to the trip whose
 *             scheduled times best match the run's observed ping times.
 */
function matchJourneyToTrips(
  journey:       JourneyStop[],
  sortedTripIds: string[],
  allStopInfos:  StopInfo[][],
  allPings:      PingWithTime[],
  blockId?:      string,
): TripRecord[] {
  const pfx = blockId ? `[block:${blockId}]` : '[block]';

  // ── Phase 1a: Group trips by identical stop-ID sequence ───────────────────
  const groupMap = new Map<string, { stopIds: string[]; tripIdxs: number[] }>();
  for (let i = 0; i < sortedTripIds.length; i++) {
    const stopIds = allStopInfos[i].map(s => s.stopId);
    const key     = stopIds.join('\0');
    if (!groupMap.has(key)) groupMap.set(key, { stopIds, tripIdxs: [] });
    groupMap.get(key)!.tripIdxs.push(i);
  }

  // Process groups in ascending scheduled-start order so earlier trips
  // consume early journey entries before later trips do.
  const groups = [...groupMap.values()].sort((a, b) => {
    const aMin = Math.min(...a.tripIdxs.map(i => allStopInfos[i][0]?.schedMin ?? Infinity));
    const bMin = Math.min(...b.tripIdxs.map(i => allStopInfos[i][0]?.schedMin ?? Infinity));
    return aMin - bMin;
  });

  console.log(
    `${pfx} ${groups.length} unique sequence(s) across ${sortedTripIds.length} trip(s)`,
  );
  groups.forEach((g, gi) =>
    console.log(
      `  [seq${gi}] stops=${g.stopIds.length}` +
      ` trips=${g.tripIdxs.length} [${g.tripIdxs.map(i => sortedTripIds[i]).join(', ')}]`,
    ),
  );

  // ── Journey coverage diagnostic ───────────────────────────────────────────
  // Identify which stop IDs from each group never appear in the journey at all.
  // If many stops are missing here, the issue is GPS coverage / SEQ_STOP_KM,
  // not the matching algorithm.
  const journeyStopSet = new Set(journey.map(j => j.stopId));
  groups.forEach((g, gi) => {
    const missing = g.stopIds.filter((sid, i, arr) => !journeyStopSet.has(sid) && arr.indexOf(sid) === i);
    const present = g.stopIds.filter((sid, i, arr) =>  journeyStopSet.has(sid) && arr.indexOf(sid) === i);
    console.log(
      `${pfx} [seq${gi}] journey coverage: ${present.length} unique stop IDs present,` +
      ` ${missing.length} NEVER appear in journey` +
      (missing.length > 0 ? ` (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})` : ''),
    );
  });

  // ── Phase 1b + 2: Find runs, assign to trips ──────────────────────────────
  // Each group searches the entire journey independently. Groups with different
  // stop sequences (e.g. outbound vs inbound on an out-and-back route) have
  // interleaved traversals in time, so a shared cursor would advance past the
  // second group's entries before it ever gets to search them.
  const journeyMatches = new Map<number, (number | null)[]>();

  for (const group of groups) {
    const { stopIds, tripIdxs } = group;
    const runs: Array<{ matches: (number | null)[]; lastK: number }> = [];
    let localCursor = 0;

    // Find every traversal of this sequence in the journey (no trip-count cap).
    while (true) {
      const run = findSequenceRun(journey, stopIds, localCursor, pfx);
      if (run.lastK < 0) break;
      runs.push(run);
      localCursor = run.lastK + 1;
    }

    console.log(
      `${pfx} [seq] ${stopIds.length}-stop sequence: found ${runs.length} run(s) for ${tripIdxs.length} trip(s)`,
    );
    runs.forEach((r, ri) => {
      const ks     = r.matches.filter((k): k is number => k !== null);
      const tFirst = ks.length > 0 ? fmtMin(journey[ks[0]].pingT)      : '—';
      const tLast  = ks.length > 0 ? fmtMin(journey[ks.at(-1)!].pingT) : '—';
      console.log(
        `${pfx}   run[${ri}] matched=${ks.length}/${stopIds.length} t=[${tFirst}–${tLast}]`,
      );
    });

    const { assignments: assigned, extraRunIdxs } = assignRunsToTrips(runs, tripIdxs, allStopInfos, journey);

    for (const [ti, m] of assigned) {
      journeyMatches.set(ti, m);
      const ks      = m.filter((k): k is number => k !== null);
      const matched = ks.length;
      const tFirst  = ks.length > 0 ? fmtMin(journey[ks[0]].pingT)       : '—';
      const tLast   = ks.length > 0 ? fmtMin(journey[ks.at(-1)!].pingT)  : '—';
      const score   = runTripScore({ matches: m }, ti, allStopInfos, journey);
      // Find which run index produced these matches
      const runIdx  = runs.findIndex(r => r.matches === m);
      console.log(
        `${pfx}   trip[${ti}]=${sortedTripIds[ti]}` +
        ` ← run[${runIdx < 0 ? 'null-fallback' : runIdx}]` +
        ` matched=${matched}/${stopIds.length}` +
        ` t=[${tFirst}–${tLast}]` +
        (isFinite(score) ? ` avgDev=${score.toFixed(1)}min` : ''),
      );
    }

    for (const ri of extraRunIdxs) {
      const r       = runs[ri];
      const ks      = r.matches.filter((k): k is number => k !== null);
      const tFirst  = ks.length > 0 ? fmtMin(journey[ks[0]].pingT)       : '—';
      const tLast   = ks.length > 0 ? fmtMin(journey[ks.at(-1)!].pingT)  : '—';
      const preview = stopIds.length > 6
        ? `${stopIds.slice(0, 3).join(',')} … ${stopIds.at(-1)}`
        : stopIds.join(',');
      console.warn(
        `${pfx} [extra run #${ri}] discarded — no unassigned trip left` +
        ` | stops=[${preview}] matched=${ks.length}/${stopIds.length} t=[${tFirst}–${tLast}]`,
      );
    }
  }

  // ── Build TripRecords ─────────────────────────────────────────────────────
  return sortedTripIds.map((tid, tripIdx) => {
    const matches = journeyMatches.get(tripIdx) ?? new Array(allStopInfos[tripIdx].length).fill(null);

    const stopMatches: StopMatch[] = allStopInfos[tripIdx].map((info, j) => {
      const k = matches[j] ?? null;
      if (k === null) {
        console.log(`${pfx} trip[${tripIdx}]=${tid} stop[${j}]=${info.stopId} ← NO MATCH`);
        return emptyMatch(info, j);
      }
      const v = journey[k];
      console.log(
        `${pfx} trip[${tripIdx}]=${tid} stop[${j}]=${info.stopId} ← MATCH` +
        ` k=${k} t=${fmtMin(v.pingT)} dev=${(v.pingT - info.schedMin).toFixed(1)}min`,
      );
      return {
        stopIndex: j, stopId: info.stopId, stopName: info.stopName,
        schedMin: info.schedMin, cumDistKm: info.cumDist,
        matchedPing: v.ping, matchedPingT: v.pingT,
        devMin: v.pingT - info.schedMin, visited: true,
      };
    });

    const visited = stopMatches.filter(m => m.visited);
    const pings   = visited.length >= 2
      ? getPingsInWindow(visited[0].matchedPingT!, visited.at(-1)!.matchedPingT!, allPings)
      : visited.length === 1 ? [visited[0].matchedPing!] : [];

    console.log(
      `${pfx} trip[${tripIdx}]=${tid}` +
      ` visited=${visited.length}/${stopMatches.length} stops` +
      (visited.length > 0
        ? ` window=[${fmtMin(visited[0].matchedPingT!)}–${fmtMin(visited.at(-1)!.matchedPingT!)}]`
        : ' window=empty') +
      ` pings=${pings.length}`,
    );

    return { tid, stopMatches, pings };
  });
}

// ── Phase 3: fill and refine stop matches from raw pings ──────────────────────

// Combined score used to rank candidate pings for a stop.  Both axes are
// normalised to [0, 1] so that a small geographic difference (e.g. 4 m vs
// 12 m) doesn't outweigh a large temporal improvement (e.g. 2 min vs 12 min).
//   score = distKm / SEQ_STOP_KM + |devMin| / P3_REF_DEV_MIN
// Lower is better.  A ping at 12 m / 2 min scores lower than one at 4 m / 12 min
// because the 8 m distance gap is negligible while the 10-minute temporal gap is not.
const P3_REF_DEV_MIN = 30;

function p3Score(distKm: number, devMin: number): number {
  return distKm / SEQ_STOP_KM + Math.abs(devMin) / P3_REF_DEV_MIN;
}

/**
 * Phase 3: scan every candidate ping (real + ephemeral) within the trip's observed
 * time window and, for each stop, keep the ping with the lowest combined
 * distance+temporal score.
 *
 * - Unvisited stops: any in-range ping fills the gap.
 * - Already-visited stops: replaced only when the new ping scores strictly
 *   lower (i.e. geographically similar but temporally better, or vice-versa).
 *
 * `candidatePings` (real + ephemeral, densified) is used to find matches;
 * `rawPings` (real only) is used to rebuild `record.pings` so ephemeral points
 * never leak into observed-ping-facing data (chart dots, ping counts).
 *
 * Operates in-place on `record.stopMatches` and rebuilds `record.pings` if
 * any matches were added or replaced.
 */
function fillMissingStopMatches(
  record:         TripRecord,
  stopInfos:      StopInfo[],
  candidatePings: PingWithTime[],
  rawPings:       PingWithTime[],
  pfx:            string,
): void {
  const visited = record.stopMatches.filter(m => m.visited);
  if (visited.length === 0) return;

  let tFirst = Infinity, tLast = -Infinity;
  for (const m of visited) {
    if (m.matchedPingT! < tFirst) tFirst = m.matchedPingT!;
    if (m.matchedPingT! > tLast)  tLast  = m.matchedPingT!;
  }

  const lo = lowerBound(candidatePings, tFirst);
  let filled = 0, refined = 0;

  for (let j = 0; j < record.stopMatches.length; j++) {
    const sm   = record.stopMatches[j];
    const info = stopInfos[j];

    // Score of the current match (Infinity when unvisited).
    const currentScore = sm.visited && sm.matchedPing
      ? p3Score(haversineKm(info.lat, info.lon, sm.matchedPing.lat, sm.matchedPing.lon), sm.devMin ?? 0)
      : Infinity;

    let bestPing:  PingWithTime | null = null;
    let bestDist   = SEQ_STOP_KM;
    let bestScore  = currentScore;

    for (let i = lo; i < candidatePings.length && candidatePings[i].t <= tLast; i++) {
      const pw  = candidatePings[i];
      const d   = haversineKm(info.lat, info.lon, pw.p.lat, pw.p.lon);
      if (d >= SEQ_STOP_KM) continue;
      const score = p3Score(d, pw.t - info.schedMin);
      if (score < bestScore) { bestScore = score; bestDist = d; bestPing = pw; }
    }

    if (bestPing) {
      const wasVisited = sm.visited;
      sm.matchedPing  = bestPing.p;
      sm.matchedPingT = bestPing.t;
      sm.devMin       = bestPing.t - info.schedMin;
      sm.visited      = true;
      if (!wasVisited) {
        filled++;
        console.log(
          `${pfx} [phase3] ${record.tid} stop[${j}]=${info.stopId} FILL` +
          ` dist=${bestDist.toFixed(3)}km dev=${sm.devMin.toFixed(1)}min` +
          (bestPing.p.interpolated ? ' (ephemeral)' : ''),
        );
      } else {
        refined++;
        console.log(
          `${pfx} [phase3] ${record.tid} stop[${j}]=${info.stopId} REFINE` +
          ` dist=${bestDist.toFixed(3)}km dev=${sm.devMin.toFixed(1)}min` +
          ` score ${currentScore.toFixed(3)}→${bestScore.toFixed(3)}` +
          (bestPing.p.interpolated ? ' (ephemeral)' : ''),
        );
      }
    }
  }

  if (filled + refined > 0) {
    const allVisited = record.stopMatches.filter(m => m.visited);
    let t0 = Infinity, t1 = -Infinity;
    for (const m of allVisited) {
      if (m.matchedPingT! < t0) t0 = m.matchedPingT!;
      if (m.matchedPingT! > t1) t1 = m.matchedPingT!;
    }
    record.pings = getPingsInWindow(t0, t1, rawPings);
    console.log(
      `${pfx} [phase3] ${record.tid} filled=${filled} refined=${refined} pings=${record.pings.length}`,
    );
  }
}

// ── matchBlockPings ───────────────────────────────────────────────────────────

/**
 * Match vehicle pings to a block's trips and return structured TripRecords.
 *
 * Phase 1 — Geographic segmentation: find all traversals of each unique stop
 *   sequence in the journey using purely geographic signals (terminal detection,
 *   sequence regression, first-stop restart).
 * Phase 2 — Temporal assignment: assign each geographic run to the trip whose
 *   scheduled times best match the run's observed ping times.
 * Phase 3 — Gap fill: for each identified trip, scan candidate pings (real +
 *   ephemeral) within the trip's observed window and match any stop still
 *   unvisited but within SEQ_STOP_KM.
 *
 * Phases 1 and 3 both search a densified ping list — real pings plus ephemeral
 * points linearly interpolated every 5 m between consecutive real pings — so
 * sparse GPS traces still register a stop visit. `record.pings` (surfaced to
 * charts/metrics) is always rebuilt from real pings only.
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
  const densified     = buildEphemeralPings(relevant);

  const blockId = sortedTripIds[0] ? `trips:${sortedTripIds.length}` : 'unknown';
  console.group(
    `[matchBlockPings] block ${blockId} — ${n} trips, ${relevant.length} relevant pings` +
    ` (+${densified.length - relevant.length} ephemeral)`,
  );

  const journey = buildJourney(densified, allStopInfos, blockId);

  if (journey.length === 0) {
    console.warn(`[block:${blockId}] journey is empty — no pings landed within ${SEQ_STOP_KM * 1000}m of any stop`);
    console.groupEnd();
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

  const tripRecords = matchJourneyToTrips(journey, sortedTripIds, allStopInfos, relevant, blockId);
  const pfx = `[block:${blockId}]`;
  for (let i = 0; i < tripRecords.length; i++) {
    fillMissingStopMatches(tripRecords[i], allStopInfos[i], densified, relevant, pfx);
  }

  const skippedCount = tripRecords.filter(r => !r.stopMatches.some(m => m.visited)).length;
  console.log(`${pfx} done — skipped=${skippedCount}/${n} trips`);
  console.groupEnd();
  return { tripRecords, skippedCount };
}