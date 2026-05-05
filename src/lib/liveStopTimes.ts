import type { GtfsData } from './types';
import type { LiveData, LiveStopTime, TrackedPosition, VehiclePosition, VehicleTrack } from './liveTypes';
import { haversineKm, parseTimeMin } from './popupUtils';

// ── Thresholds ────────────────────────────────────────────────────────────────

const STOP_RADIUS_M = 20;
const SLOW_RADIUS_M = 100;
const SLOW_SPEED_MS = 3;
const SKIP_RADIUS_M = 300;
const ON_TIME_THRESHOLD_S = 180; // ±3 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

/**
 * Returns the Unix timestamp (seconds) for local midnight of whichever calendar
 * date `unixSeconds` falls on in `timezone`.
 *
 * Strategy: noon UTC of the formatted date is always within ±12 h of local
 * midnight, so subtracting the local HH:MM:SS at that probe time gives us the
 * correct UTC epoch for 00:00:00 local — even across DST boundaries.
 */
function localMidnightUnix(unixSeconds: number, timezone: string): number {
  const d = new Date(unixSeconds * 1000);
  // YYYY-MM-DD in the target timezone
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d);
  // Probe: noon UTC of that calendar date
  const noonUtcMs = new Date(ymd + 'T12:00:00Z').getTime();
  // What local time does that probe correspond to?
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(noonUtcMs));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '12');
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  const s = parseInt(parts.find(p => p.type === 'second')?.value ?? '0');
  // Subtract local H:M:S → gives local midnight expressed as UTC
  return (noonUtcMs - (h * 3600 + m * 60 + s) * 1000) / 1000;
}

function computeSpeeds(positions: VehiclePosition[]): number[] {
  const n = positions.length;
  const speeds = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = positions[i].timestamp - positions[i - 1].timestamp;
    if (dt <= 0) { speeds[i] = speeds[i - 1]; continue; }
    speeds[i] = haversineM(
      positions[i - 1].lat, positions[i - 1].lon,
      positions[i].lat,     positions[i].lon,
    ) / dt;
  }
  speeds[0] = n > 1 ? speeds[1] : 0;
  return speeds;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface LiveMetrics {
  operationPct: number | null;
  timelinessPct: number | null;
  reliabilityPct: number | null;
}

export interface LiveProcessed {
  stopTimes: LiveStopTime[];
  tracks: Map<string, VehicleTrack>;
  // Indices (keyed by trip_id / stop_id / route_id)
  byTrip: Map<string, LiveStopTime[]>;
  byStop: Map<string, LiveStopTime[]>;
  byRoute: Map<string, LiveStopTime[]>;
  // Trips that appeared in live data
  observedTripIds: Set<string>;
  // GTFS trips whose first departure falls within the live data window
  scheduledTripIds: Set<string>;
  scheduledByRoute: Map<string, Set<string>>;  // route_id → scheduled trip IDs
  scheduledByStop: Map<string, Set<string>>;   // stop_id → scheduled trip IDs
  serviceDateStart: number; // Unix epoch seconds of midnight on the live-data date
}

// ── Metrics helper ────────────────────────────────────────────────────────────

export function computeMetrics(
  liveSTs: LiveStopTime[],
  scheduledTripIds: Set<string>,
  observedTripIds: Set<string>,
): LiveMetrics {
  // Operation: scheduled trips that were actually observed
  let observedScheduled = 0;
  for (const id of scheduledTripIds) {
    if (observedTripIds.has(id)) observedScheduled++;
  }
  const operationPct = scheduledTripIds.size > 0
    ? (observedScheduled / scheduledTripIds.size) * 100
    : null;

  // Reliability: stops visited / stops scheduled (live stop-time rows)
  const visited = liveSTs.filter(s => s.visited).length;
  const reliabilityPct = liveSTs.length > 0
    ? (visited / liveSTs.length) * 100
    : null;

  // Timeliness: on-time / visited stops that have a schedule
  const withSchedule = liveSTs.filter(s => s.on_time !== null);
  const onTime = withSchedule.filter(s => s.on_time).length;
  const timelinessPct = withSchedule.length > 0
    ? (onTime / withSchedule.length) * 100
    : null;

  return { operationPct, timelinessPct, reliabilityPct };
}

// ── Interpolation pass ────────────────────────────────────────────────────────

/**
 * Returns a new LiveProcessed where every non-visited stop in an observed trip
 * has its arrival time linearly interpolated from the nearest visited neighbours.
 * Stops that have no visited neighbours in the same trip are left unchanged.
 * The original LiveProcessed is never mutated.
 */
export function applyInterpolation(lp: LiveProcessed): LiveProcessed {
  // Shallow-clone every stop time so originals are untouched
  const newStopTimes: LiveStopTime[] = lp.stopTimes.map(s => ({ ...s }));

  // Group clones by trip and sort by stop_sequence
  const newByTrip = new Map<string, LiveStopTime[]>();
  for (const st of newStopTimes) {
    let arr = newByTrip.get(st.trip_id);
    if (!arr) { arr = []; newByTrip.set(st.trip_id, arr); }
    arr.push(st);
  }
  for (const arr of newByTrip.values())
    arr.sort((a, b) => a.stop_sequence - b.stop_sequence);

  const svc = lp.serviceDateStart;

  for (const tripSTs of newByTrip.values()) {
    for (let i = 0; i < tripSTs.length; i++) {
      const st = tripSTs[i];
      if (st.visited) continue;

      const scheduledTime = st.scheduled_arrival || st.scheduled_departure;
      if (!scheduledTime) continue;
      const thisScheduledUnix = svc + parseTimeMin(scheduledTime) * 60;

      // Nearest visited predecessor with a known arrival time
      let prev: { scheduledUnix: number; actualUnix: number } | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const s = tripSTs[j];
        if (!s.visited || s.estimated_arrival === null) continue;
        const t = s.scheduled_arrival || s.scheduled_departure;
        if (t) prev = { scheduledUnix: svc + parseTimeMin(t) * 60, actualUnix: s.estimated_arrival };
        break;
      }

      // Nearest visited successor with a known arrival time
      let next: { scheduledUnix: number; actualUnix: number } | null = null;
      for (let j = i + 1; j < tripSTs.length; j++) {
        const s = tripSTs[j];
        if (!s.visited || s.estimated_arrival === null) continue;
        const t = s.scheduled_arrival || s.scheduled_departure;
        if (t) next = { scheduledUnix: svc + parseTimeMin(t) * 60, actualUnix: s.estimated_arrival };
        break;
      }

      if (!prev && !next) continue;

      let estimatedArrival: number;
      if (prev && next) {
        const span = next.scheduledUnix - prev.scheduledUnix;
        const frac = span > 0 ? (thisScheduledUnix - prev.scheduledUnix) / span : 0;
        estimatedArrival = prev.actualUnix + frac * (next.actualUnix - prev.actualUnix);
      } else if (prev) {
        estimatedArrival = thisScheduledUnix + (prev.actualUnix - prev.scheduledUnix);
      } else {
        estimatedArrival = thisScheduledUnix + (next!.actualUnix - next!.scheduledUnix);
      }

      const deviation_s = Math.round(estimatedArrival - thisScheduledUnix);
      st.visited = true;
      st.skipped = false;
      st.estimated_arrival = Math.round(estimatedArrival);
      st.deviation_s = deviation_s;
      st.on_time = Math.abs(deviation_s) <= ON_TIME_THRESHOLD_S;
    }
  }

  // Rebuild byStop and byRoute from the (possibly mutated) clones
  const newByStop = new Map<string, LiveStopTime[]>();
  const newByRoute = new Map<string, LiveStopTime[]>();
  for (const st of newStopTimes) {
    let b = newByStop.get(st.stop_id);
    if (!b) { b = []; newByStop.set(st.stop_id, b); }
    b.push(st);
    if (st.route_id) {
      let c = newByRoute.get(st.route_id);
      if (!c) { c = []; newByRoute.set(st.route_id, c); }
      c.push(st);
    }
  }

  return { ...lp, stopTimes: newStopTimes, byTrip: newByTrip, byStop: newByStop, byRoute: newByRoute };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildLiveStopTimes(liveData: LiveData, gtfsData: GtfsData): LiveProcessed {
  // GTFS scheduled times are in the agency's local timezone, not UTC.
  const timezone = [...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC';
  const serviceDateStart = localMidnightUnix(liveData.minTimestamp, timezone);

  // ── Group positions by trip_id, sort by timestamp ─────────────────────────
  const positionsByTrip = new Map<string, VehiclePosition[]>();
  for (const pos of liveData.vehiclePositions) {
    if (!pos.trip_id) continue;
    let arr = positionsByTrip.get(pos.trip_id);
    if (!arr) { arr = []; positionsByTrip.set(pos.trip_id, arr); }
    arr.push(pos);
  }
  for (const arr of positionsByTrip.values())
    arr.sort((a, b) => a.timestamp - b.timestamp);

  const stopTimes: LiveStopTime[] = [];
  const tracks = new Map<string, VehicleTrack>();

  for (const [tripId, positions] of positionsByTrip) {
    const stopList = gtfsData.tripStops.get(tripId);
    const staticSTs = gtfsData.stopTimesByTrip.get(tripId) ?? [];

    const speeds = computeSpeeds(positions);

    const trackPositions: TrackedPosition[] = positions.map((p, i) => ({
      timestamp: p.timestamp,
      lat:       p.lat,
      lon:       p.lon,
      bearing:   p.bearing,
      speed_ms:  speeds[i],
    }));
    tracks.set(tripId, {
      trip_id:    tripId,
      route_id:   positions[0]?.route_id ?? null,
      vehicle_id: positions[0]?.vehicle_id ?? '',
      positions:  trackPositions,
    });

    if (!stopList || stopList.length === 0) continue;

    for (let si = 0; si < stopList.length; si++) {
      const stopId = stopList[si];
      const stop   = gtfsData.stops.get(stopId);
      if (!stop) continue;

      const staticSt = staticSTs[si];

      let minDistM   = Infinity;
      let minDistIdx = -1;
      for (let pi = 0; pi < positions.length; pi++) {
        const d = haversineM(stop.stop_lat, stop.stop_lon, positions[pi].lat, positions[pi].lon);
        if (d < minDistM) { minDistM = d; minDistIdx = pi; }
      }

      const speedAtClosest = minDistIdx >= 0 ? speeds[minDistIdx] : Infinity;
      const visited =
        minDistM <= STOP_RADIUS_M ||
        (minDistM <= SLOW_RADIUS_M && speedAtClosest <= SLOW_SPEED_MS);
      const skipped = !visited && minDistM <= SKIP_RADIUS_M;

      // Deviation from schedule
      let deviation_s: number | null = null;
      let on_time: boolean | null = null;
      if (visited && minDistIdx >= 0) {
        const scheduledTime = staticSt?.arrival_time || staticSt?.departure_time;
        if (scheduledTime) {
          const scheduledUnix = serviceDateStart + parseTimeMin(scheduledTime) * 60;
          deviation_s = positions[minDistIdx].timestamp - scheduledUnix;
          on_time = Math.abs(deviation_s) <= ON_TIME_THRESHOLD_S;
        }
      }

      stopTimes.push({
        stop_id:              stopId,
        trip_id:              tripId,
        route_id:             positions[0]?.route_id ?? null,
        stop_sequence:        staticSt?.stop_sequence ?? si,
        scheduled_arrival:    staticSt?.arrival_time   ?? null,
        scheduled_departure:  staticSt?.departure_time ?? null,
        estimated_arrival:    visited && minDistIdx >= 0
                                ? positions[minDistIdx].timestamp
                                : null,
        visited,
        skipped,
        min_distance_m: minDistM === Infinity ? -1 : Math.round(minDistM),
        deviation_s,
        on_time,
      });
    }
  }

  // ── Build indices ─────────────────────────────────────────────────────────
  const byTrip = new Map<string, LiveStopTime[]>();
  const byStop = new Map<string, LiveStopTime[]>();
  const byRoute = new Map<string, LiveStopTime[]>();

  for (const st of stopTimes) {
    let a = byTrip.get(st.trip_id);
    if (!a) { a = []; byTrip.set(st.trip_id, a); }
    a.push(st);

    let b = byStop.get(st.stop_id);
    if (!b) { b = []; byStop.set(st.stop_id, b); }
    b.push(st);

    if (st.route_id) {
      let c = byRoute.get(st.route_id);
      if (!c) { c = []; byRoute.set(st.route_id, c); }
      c.push(st);
    }
  }

  const observedTripIds = new Set<string>(byTrip.keys());

  // ── Scheduled trips: GTFS trips whose first stop departs in the live window
  const scheduledTripIds = new Set<string>();
  const scheduledByRoute = new Map<string, Set<string>>();
  const scheduledByStop  = new Map<string, Set<string>>();

  const windowStart = liveData.minTimestamp - 3600;
  const windowEnd   = liveData.maxTimestamp + 3600;

  for (const trip of gtfsData.trips.values()) {
    const sts = gtfsData.stopTimesByTrip.get(trip.trip_id);
    if (!sts || sts.length === 0) continue;
    const firstTime = sts[0].departure_time || sts[0].arrival_time;
    if (!firstTime) continue;
    const tripStartUnix = serviceDateStart + parseTimeMin(firstTime) * 60;
    if (tripStartUnix < windowStart || tripStartUnix > windowEnd) continue;

    scheduledTripIds.add(trip.trip_id);

    let rs = scheduledByRoute.get(trip.route_id);
    if (!rs) { rs = new Set(); scheduledByRoute.set(trip.route_id, rs); }
    rs.add(trip.trip_id);

    for (const stopId of gtfsData.tripStops.get(trip.trip_id) ?? []) {
      let ss = scheduledByStop.get(stopId);
      if (!ss) { ss = new Set(); scheduledByStop.set(stopId, ss); }
      ss.add(trip.trip_id);
    }
  }

  return {
    stopTimes,
    tracks,
    byTrip,
    byStop,
    byRoute,
    observedTripIds,
    scheduledTripIds,
    scheduledByRoute,
    scheduledByStop,
    serviceDateStart,
  };
}
