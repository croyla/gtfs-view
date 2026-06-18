import type { GtfsData } from './types';
import type { VehiclePosition } from './liveTypes';
import { haversineKm, parseTimeMin } from './popupUtils';

// ── Matching constants ────────────────────────────────────────────────────────

const SEQ_STOP_KM         = 0.15;  // 150 m – ping-to-stop match radius
const BLOCK_PRE_SLACK_MIN = 10;    // minutes before block start to include pings

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

// ── Stop schedule map ─────────────────────────────────────────────────────────

function buildStopScheduleMap(
  allStopInfos: StopInfo[][],
): Map<string, Array<{ tripIdx: number; schedMin: number }>> {
  const map = new Map<string, Array<{ tripIdx: number; schedMin: number }>>();
  for (let t = 0; t < allStopInfos.length; t++) {
    for (const info of allStopInfos[t]) {
      if (!map.has(info.stopId)) map.set(info.stopId, []);
      map.get(info.stopId)!.push({ tripIdx: t, schedMin: info.schedMin });
    }
  }
  return map;
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
  return journey;
}

// ── Journey-to-trip matching ──────────────────────────────────────────────────

/**
 * Match the observed journey to each trip's stop sequence.
 *
 * For each journey entry, the "preferred" trip is the one whose scheduled time
 * for that stop is closest to the ping time — exclusive temporal attribution
 * with no hard threshold, purely relative. A trip may only claim a journey entry
 * that prefers it. Claims advance a per-trip cursor enforcing that stop matches
 * appear in the same chronological order as the journey (monotone forward scan).
 *
 * Trips with identical stop sequences are handled correctly: early pings are
 * claimed by the trip whose schedule is temporally closest, leaving later pings
 * exclusively available for the later trip.
 */
function matchJourneyToTrips(
  journey:       JourneyStop[],
  sortedTripIds: string[],
  allStopInfos:  StopInfo[][],
  allPings:      PingWithTime[],
): TripRecord[] {
  const stopSchedules = buildStopScheduleMap(allStopInfos);

  // For each journey entry, pre-compute which trip has the closest scheduled
  // time for that stop. Ties broken by trip index (earlier trip wins).
  const preferred: number[] = journey.map(visit => {
    const schedules = stopSchedules.get(visit.stopId) ?? [];
    let bestTripIdx = -1;
    let bestDist    = Infinity;
    for (const s of schedules) {
      const d = Math.abs(visit.pingT - s.schedMin);
      if (d < bestDist) { bestDist = d; bestTripIdx = s.tripIdx; }
    }
    return bestTripIdx;
  });

  const claimed = new Uint8Array(journey.length);

  return sortedTripIds.map((tid, tripIdx) => {
    // cursor ensures we only scan forward in the journey (monotone ordering)
    let cursor = 0;

    const stopMatches: StopMatch[] = allStopInfos[tripIdx].map((info, j) => {
      for (let k = cursor; k < journey.length; k++) {
        if (journey[k].stopId !== info.stopId) continue;
        if (claimed[k] || preferred[k] !== tripIdx) continue;
        claimed[k] = 1;
        cursor     = k + 1;
        const v    = journey[k];
        return {
          stopIndex: j, stopId: info.stopId, stopName: info.stopName,
          schedMin: info.schedMin, cumDistKm: info.cumDist,
          matchedPing: v.ping, matchedPingT: v.pingT,
          devMin: v.pingT - info.schedMin, visited: true,
        };
      }
      return emptyMatch(info, j);
    });

    const visited = stopMatches.filter(m => m.visited);
    const pings   = visited.length >= 2
      ? getPingsInWindow(visited[0].matchedPingT!, visited.at(-1)!.matchedPingT!, allPings)
      : visited.length === 1 ? [visited[0].matchedPing!] : [];
    return { tid, stopMatches, pings };
  });
}

// ── matchBlockPings ───────────────────────────────────────────────────────────

/**
 * Match vehicle pings to a block's trips and return structured TripRecords.
 *
 * 1. Build the journey — the vehicle's observed stop-visit sequence across the
 *    entire block, in chronological order.
 * 2. If the journey is empty (no pings near any block stop), return error.
 * 3. Match the journey to each trip via exclusive temporal attribution and
 *    monotone forward scanning. Handles all cases uniformly: unique stops,
 *    shared stops, repeated sequences, same-direction consecutive trips.
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

  const journey = buildJourney(relevant, allStopInfos);

  if (journey.length === 0) {
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

  const tripRecords = matchJourneyToTrips(journey, sortedTripIds, allStopInfos, relevant);
  return {
    tripRecords,
    skippedCount: tripRecords.filter(r => !r.stopMatches.some(m => m.visited)).length,
  };
}