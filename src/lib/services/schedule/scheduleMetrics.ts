import type { GtfsData } from '../../types/types';
import type { VehiclePosition } from '../../types/liveTypes';
import { haversineKm, parseTimeMin } from '../popupUtils';
import type { PingWithTime, StopMatch, TripRecord, BlockPingData } from './schedulePings';

// Re-export ping-side types and utilities so existing callers keep working.
export type { PingWithTime, StopMatch, TripRecord, BlockPingData };
export { makeEpochToMin, buildSortedPings, matchBlockPings } from './schedulePings';

// ── Completion types ───────────────────────────────────────────────────────────

export type CompletionTier = 'complete' | '<25' | '25-60' | '60-99';

export interface TripCompletionResult {
  tid:            string;
  completionPct:  number;
  scheduledKm:    number;
  lostKm:         number;
  penaltyPct:     0 | 50 | 75 | 100;
  tier:           CompletionTier;
  schedStartTime: string;
  schedEndTime:   string;
  startPing:      VehiclePosition | null;
  endPing:        VehiclePosition | null;
  startStop:      { stop_lat: number; stop_lon: number; stop_name: string } | null;
  endStop:        { stop_lat: number; stop_lon: number; stop_name: string } | null;
  stopMatches:    StopMatch[];
}

// ── Punctuality types ──────────────────────────────────────────────────────────

export interface PunctualitySettings {
  startThresholdMin: number;
  endThresholdMin:   number;
  startPenaltyPct:   number;
  endPenaltyPct:     number;
}

export const DEFAULT_PUNCT_SETTINGS: PunctualitySettings = {
  startThresholdMin: 5,
  endThresholdMin:   10,
  startPenaltyPct:   5,
  endPenaltyPct:     5,
};

export interface TripPunctualityDetail {
  tid:           string;
  durationMin:   number;
  startDevMin:   number | null;
  arrivalDevMin: number | null;
  startOnTime:   boolean | null;
  endOnTime:     boolean | null;
}

export interface PunctualityMetrics {
  trips:            TripPunctualityDetail[];
  startOnTimeCount: number;
  startLateCount:   number;
  startNoDataCount: number;
  endOnTimeCount:   number;
  endLateCount:     number;
  endNoDataCount:   number;
  startPenaltyPct:  number;
  endPenaltyPct:    number;
  totalNetPct:      number;
  settings:         PunctualitySettings;
}

// ── Data availability types ────────────────────────────────────────────────────

export const DATA_AVAIL_THRESHOLD   = 98;
export const DATA_AVAIL_PENALTY_PCT = 1;
const        EXPECTED_PINGS_PER_MIN = 2;

export interface TripDataAvailability {
  tid:             string;
  durationMin:     number;
  pingCount:       number;
  expectedPings:   number;
  availabilityPct: number;
  penalized:       boolean;
}

export interface DataAvailabilityMetrics {
  trips:           TripDataAvailability[];
  totalPenaltyPct: number;
}

// ── Block output ───────────────────────────────────────────────────────────────

export interface BlockMetrics {
  tripRecords:      TripRecord[];
  completions:      TripCompletionResult[];
  punctuality:      PunctualityMetrics;
  dataAvailability: DataAvailabilityMetrics;
  skippedCount:     number;
}

// ── Completion scoring ─────────────────────────────────────────────────────────

/**
 * Score a trip from its per-stop match array.
 * Served km = sum of segments where both adjacent stops were visited.
 * Exported so the UI can rescore after user overrides without re-running the
 * sequential algorithm.
 */
export function computeTripCompletionFromStopMatches(
  tid:         string,
  stopMatches: StopMatch[],
  gtfsData:    GtfsData,
): TripCompletionResult {
  const sts         = gtfsData.stopTimesByTrip.get(tid) ?? [];
  const scheduledKm = stopMatches.at(-1)?.cumDistKm ?? 0;
  const anyVisited  = stopMatches.some(s => s.visited);

  let servedKm = 0;
  const segments: Array<{ from: string; to: string; km: number; counted: boolean }> = [];
  for (let i = 1; i < stopMatches.length; i++) {
    const segKm   = stopMatches[i].cumDistKm - stopMatches[i - 1].cumDistKm;
    const counted = stopMatches[i - 1].visited && stopMatches[i].visited;
    if (counted) servedKm += segKm;
    segments.push({ from: stopMatches[i - 1].stopId, to: stopMatches[i].stopId, km: segKm, counted });
  }

  const completionPct = scheduledKm > 0 ? Math.min(100, servedKm / scheduledKm * 100) : 0;
  const lostKm        = Math.max(0, scheduledKm - servedKm);

  let tier: CompletionTier;
  let penaltyPct: 0 | 50 | 75 | 100;
  if (!anyVisited)               { tier = '<25';      penaltyPct = 100; }
  else if (completionPct >= 100) { tier = 'complete'; penaltyPct = 0;   }
  else if (completionPct < 25)   { tier = '<25';      penaltyPct = 100; }
  else if (completionPct < 60)   { tier = '25-60';    penaltyPct = 75;  }
  else                            { tier = '60-99';    penaltyPct = 50;  }

  const firstStopRaw = sts.length > 0 ? gtfsData.stops.get(sts[0].stop_id)      : undefined;
  const lastStopRaw  = sts.length > 0 ? gtfsData.stops.get(sts.at(-1)!.stop_id) : undefined;

  // ── verbose logging ──
  console.groupCollapsed(
    `[completion] ${tid} — ${tier} ${completionPct.toFixed(1)}% (${servedKm.toFixed(2)}/${scheduledKm.toFixed(2)} km) penalty=${penaltyPct}%`,
  );
  console.log(`  anyVisited=${anyVisited}  scheduledKm=${scheduledKm.toFixed(3)}  servedKm=${servedKm.toFixed(3)}  lostKm=${lostKm.toFixed(3)}`);
  console.log('  stop matches:');
  stopMatches.forEach((m, i) => {
    const pingInfo = m.visited
      ? `t=${m.matchedPingT?.toFixed(1)} dev=${m.devMin?.toFixed(1)}min`
      : 'NO MATCH';
    console.log(`    [${i}] ${m.stopId} "${m.stopName}" sched=${m.schedMin.toFixed(1)} cumDist=${m.cumDistKm.toFixed(3)}km visited=${m.visited} ${pingInfo}`);
  });
  if (segments.length > 0) {
    console.log('  segments:');
    segments.forEach(s =>
      console.log(`    ${s.from}→${s.to} ${s.km.toFixed(3)}km counted=${s.counted}`),
    );
  }
  console.groupEnd();

  return {
    tid, completionPct, scheduledKm, lostKm, penaltyPct, tier,
    schedStartTime: sts.length > 0 ? (sts[0].departure_time  || sts[0].arrival_time).slice(0, 5)            : '',
    schedEndTime:   sts.length > 0 ? (sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time).slice(0, 5) : '',
    startPing:  stopMatches[0]?.matchedPing    ?? null,
    endPing:    stopMatches.at(-1)?.matchedPing ?? null,
    startStop:  firstStopRaw ? { stop_lat: firstStopRaw.stop_lat, stop_lon: firstStopRaw.stop_lon, stop_name: firstStopRaw.stop_name } : null,
    endStop:    lastStopRaw  ? { stop_lat: lastStopRaw.stop_lat,  stop_lon: lastStopRaw.stop_lon,  stop_name: lastStopRaw.stop_name  } : null,
    stopMatches,
  };
}

// ── Punctuality scoring ────────────────────────────────────────────────────────

export function computePunctualityFromCompletions(
  completions: TripCompletionResult[],
  settings:    PunctualitySettings,
  gtfsData:    GtfsData,
): PunctualityMetrics {
  const trips: TripPunctualityDetail[] = completions.map(c => {
    const sts         = gtfsData.stopTimesByTrip.get(c.tid) ?? [];
    const schedStart  = sts.length > 0 ? parseTimeMin(sts[0].departure_time  || sts[0].arrival_time)          : 0;
    const schedEnd    = sts.length > 0 ? parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time) : 0;
    const durationMin = Math.max(1, schedEnd - schedStart);
    const startDevMin   = c.stopMatches[0]?.devMin    ?? null;
    const arrivalDevMin = c.stopMatches.at(-1)?.devMin ?? null;
    const startOnTime   = c.startPing ? Math.abs(startDevMin!)   <= settings.startThresholdMin : null;
    const endOnTime     = c.endPing   ? Math.abs(arrivalDevMin!) <= settings.endThresholdMin   : null;
    console.log(
      `[punctuality] ${c.tid}` +
      `  startDev=${startDevMin?.toFixed(1) ?? 'null'}min (onTime=${startOnTime ?? 'no-data'}, threshold±${settings.startThresholdMin}min)` +
      `  endDev=${arrivalDevMin?.toFixed(1) ?? 'null'}min (onTime=${endOnTime ?? 'no-data'}, threshold±${settings.endThresholdMin}min)`,
    );
    return { tid: c.tid, durationMin, startDevMin, arrivalDevMin, startOnTime, endOnTime };
  });

  const startOnTimeCount = trips.filter(t => t.startOnTime === true).length;
  const startLateCount   = trips.filter(t => t.startOnTime === false).length;
  const startNoDataCount = trips.filter(t => t.startOnTime === null).length;
  const endOnTimeCount   = trips.filter(t => t.endOnTime === true).length;
  const endLateCount     = trips.filter(t => t.endOnTime === false).length;
  const endNoDataCount   = trips.filter(t => t.endOnTime === null).length;
  const startPenaltyPct  = startLateCount * settings.startPenaltyPct;
  const endPenaltyPct    = endLateCount   * settings.endPenaltyPct;

  console.log(
    `[punctuality] summary` +
    `  start: onTime=${startOnTimeCount} late=${startLateCount} noData=${startNoDataCount} penalty=${startPenaltyPct}%` +
    `  end: onTime=${endOnTimeCount} late=${endLateCount} noData=${endNoDataCount} penalty=${endPenaltyPct}%` +
    `  total=${startPenaltyPct + endPenaltyPct}%`,
  );

  return {
    trips, startOnTimeCount, startLateCount, startNoDataCount,
    endOnTimeCount, endLateCount, endNoDataCount,
    startPenaltyPct, endPenaltyPct,
    totalNetPct: startPenaltyPct + endPenaltyPct, settings,
  };
}

// ── Data availability scoring ──────────────────────────────────────────────────

export function computeDataAvailability(
  sortedTripIds: string[],
  allPings:      VehiclePosition[],
  gtfsData:      GtfsData,
): DataAvailabilityMetrics {
  const byTrip = new Map<string, number>();
  for (const p of allPings) {
    if (p.trip_id) byTrip.set(p.trip_id, (byTrip.get(p.trip_id) ?? 0) + 1);
  }

  const trips: TripDataAvailability[] = sortedTripIds.map(tid => {
    const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
    if (sts.length === 0)
      return { tid, durationMin: 0, pingCount: 0, expectedPings: 0, availabilityPct: 0, penalized: true };

    const firstMin      = parseTimeMin(sts[0].departure_time  || sts[0].arrival_time);
    const lastMin       = parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time);
    const durationMin   = Math.max(0, lastMin - firstMin);
    const expectedPings = Math.ceil(durationMin * EXPECTED_PINGS_PER_MIN);
    const pingCount     = byTrip.get(tid) ?? 0;
    const availabilityPct = expectedPings > 0
      ? Math.min(100, (pingCount / expectedPings) * 100)
      : (pingCount > 0 ? 100 : 0);

    return { tid, durationMin, pingCount, expectedPings, availabilityPct, penalized: availabilityPct < DATA_AVAIL_THRESHOLD };
  });

  return { trips, totalPenaltyPct: trips.filter(t => t.penalized).length * DATA_AVAIL_PENALTY_PCT };
}

// ── computeBlockMetrics ────────────────────────────────────────────────────────

/**
 * Score a prepared `BlockPingData` (from `matchBlockPings`) into full metrics.
 *   1. Score each trip's completion from its stop matches
 *   2. Derive punctuality from the same endpoint deviations
 *   3. Compute data availability from tagged ping counts
 */
export function computeBlockMetrics(
  pingData:    BlockPingData,
  taggedPings: VehiclePosition[],
  gtfsData:    GtfsData,
): BlockMetrics {
  const { tripRecords, skippedCount } = pingData;
  const sortedTripIds = tripRecords.map(r => r.tid);

  console.group(`[computeBlockMetrics] ${sortedTripIds.length} trips, skipped=${skippedCount}`);

  const completions = tripRecords.map(r =>
    computeTripCompletionFromStopMatches(r.tid, r.stopMatches, gtfsData),
  );

  console.log('[computeBlockMetrics] completion summary:');
  completions.forEach(c =>
    console.log(
      `  ${c.tid}  tier=${c.tier}  ${c.completionPct.toFixed(1)}%` +
      `  served=${(c.scheduledKm - c.lostKm).toFixed(2)}/${c.scheduledKm.toFixed(2)}km` +
      `  penalty=${c.penaltyPct}%`,
    ),
  );

  const punctuality      = computePunctualityFromCompletions(completions, DEFAULT_PUNCT_SETTINGS, gtfsData);
  const dataAvailability = computeDataAvailability(sortedTripIds, taggedPings, gtfsData);

  console.log('[computeBlockMetrics] data availability:');
  dataAvailability.trips.forEach(t =>
    console.log(
      `  ${t.tid}  pings=${t.pingCount}/${t.expectedPings} (${t.availabilityPct.toFixed(1)}%)` +
      `  penalized=${t.penalized}`,
    ),
  );

  console.groupEnd();
  return { tripRecords, completions, punctuality, dataAvailability, skippedCount };
}