import type { ApiAgency, ApiRoute, ApiStop, ApiTrip, ApiStopTime } from './api';
import type { Agency, Route, Stop, StopTime, Trip, ShapePoint, GtfsData } from './types';
import { buildTree } from './gtfsCore';

export function buildGtfsFromApi(
  apiAgency: ApiAgency[],
  apiRoutes: ApiRoute[],
  apiStops: ApiStop[],
  apiTrips: ApiTrip[],
  apiStopTimes: ApiStopTime[],
): GtfsData {
  // Agencies
  const agencies = new Map<string, Agency>();
  for (const a of apiAgency) {
    agencies.set(a.agency_id, {
      agency_id: a.agency_id,
      agency_name: a.agency_name,
      agency_url: a.agency_url || undefined,
      agency_timezone: a.agency_timezone || undefined,
    });
  }

  // Stops
  const stops = new Map<string, Stop>();
  for (const s of apiStops) {
    const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    stops.set(s.stop_id, { stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: lat, stop_lon: lon });
  }

  // Trips (no shape_id or headsign from API)
  const trips = new Map<string, Trip>();
  for (const t of apiTrips) {
    trips.set(t.trip_id, { trip_id: t.trip_id, route_id: t.route_id });
  }

  // Routes
  const routes = new Map<string, Route>();
  for (const r of apiRoutes) {
    routes.set(r.route_id, {
      route_id: r.route_id,
      agency_id: r.agency_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      route_type: r.route_type,
    });
  }

  // Stop times
  const stopTimes: StopTime[] = apiStopTimes.map(st => ({
    trip_id: st.trip_id,
    stop_id: st.stop_id,
    arrival_time: st.arrival_time,
    departure_time: st.departure_time,
    stop_sequence: parseInt(st.stop_sequence, 10),
  }));

  // tripStops: trip_id → ordered unique stop_ids
  const tripStopSeqs = new Map<string, Map<number, string>>();
  for (const st of stopTimes) {
    let seqMap = tripStopSeqs.get(st.trip_id);
    if (!seqMap) { seqMap = new Map(); tripStopSeqs.set(st.trip_id, seqMap); }
    seqMap.set(st.stop_sequence, st.stop_id);
  }
  const tripStops = new Map<string, string[]>();
  for (const [tripId, seqMap] of tripStopSeqs) {
    const seen = new Set<string>();
    const ordered = [...seqMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, sid]) => sid)
      .filter(s => seen.has(s) ? false : (seen.add(s), true));
    tripStops.set(tripId, ordered);
  }

  // Synthetic shapes from stop sequences (API has no shapes.txt)
  const shapes = new Map<string, ShapePoint[]>();
  const shapeLabels = new Map<string, string>();
  const seqToSynId = new Map<string, string>();
  let synCount = 0;

  for (const trip of trips.values()) {
    const stopList = tripStops.get(trip.trip_id) ?? [];
    if (stopList.length < 2) continue;
    const seqKey = stopList.join('|');
    let synId = seqToSynId.get(seqKey);
    if (!synId) {
      synId = `__syn__${++synCount}`;
      seqToSynId.set(seqKey, synId);
      const pts = stopList
        .map((sid, i) => {
          const s = stops.get(sid);
          return s ? { shape_pt_lat: s.stop_lat, shape_pt_lon: s.stop_lon, shape_pt_sequence: i } : null;
        })
        .filter((p): p is ShapePoint => p !== null);
      if (pts.length >= 2) {
        shapes.set(synId, pts);
        const first = stops.get(stopList[0]);
        const last  = stops.get(stopList[stopList.length - 1]);
        if (first && last) shapeLabels.set(synId, `${first.stop_name} → ${last.stop_name}`);
      }
    }
    if (synId && shapes.has(synId)) trip.shape_id = synId;
  }

  // Shape colours (routes have no route_color from this API)
  const shapeColors = new Map<string, string>();

  // Build sidebar tree
  const { tree, allShapeKeys } = buildTree(agencies, routes, trips, shapeLabels);

  // Stop time indices
  const stopTimesByTrip = new Map<string, StopTime[]>();
  const stopTimesByStop = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    let byTrip = stopTimesByTrip.get(st.trip_id);
    if (!byTrip) { byTrip = []; stopTimesByTrip.set(st.trip_id, byTrip); }
    byTrip.push(st);

    let byStop = stopTimesByStop.get(st.stop_id);
    if (!byStop) { byStop = []; stopTimesByStop.set(st.stop_id, byStop); }
    byStop.push(st);
  }
  for (const sts of stopTimesByTrip.values())
    sts.sort((a, b) => a.stop_sequence - b.stop_sequence);

  return {
    agencies,
    stops,
    trips,
    routes,
    shapes,
    shapeColors,
    tripStops,
    stopTimesByTrip,
    stopTimesByStop,
    tree,
    allShapeKeys: new Set(allShapeKeys),
  };
}