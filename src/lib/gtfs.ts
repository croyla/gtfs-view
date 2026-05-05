import { unzipSync, strFromU8 } from 'fflate';
import type {
  Agency, AgencyTreeNode, GtfsData, Route, RouteTreeNode,
  ShapeGroup, ShapePoint, Stop, StopTime, Trip,
} from './types';

// ── CSV parser ────────────────────────────────────────────────────────────────

function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const result: string[] = [];
  let i = 0, current = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { current += '"'; i += 2; }
          else { i++; break; }
        } else { current += line[i++]; }
      }
    } else if (ch === ',') {
      result.push(current); current = ''; i++;
    } else { current += ch; i++; }
  }
  result.push(current);
  return result;
}

function parseCSV(text: string): Record<string, string>[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map(h => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = splitLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

// ── Tree builder ──────────────────────────────────────────────────────────────

function buildTree(
  agencies: Map<string, Agency>,
  routes: Map<string, Route>,
  trips: Map<string, Trip>,
  shapeLabels: Map<string, string>,
): { tree: AgencyTreeNode[]; allShapeKeys: Set<string> } {
  // Group trips by route
  const tripsByRoute = new Map<string, Trip[]>();
  for (const trip of trips.values()) {
    const arr = tripsByRoute.get(trip.route_id);
    if (arr) arr.push(trip); else tripsByRoute.set(trip.route_id, [trip]);
  }

  // Group routes by agency. If only one agency, assign all routes to it.
  const singleAgencyId = agencies.size === 1 ? [...agencies.keys()][0] : null;
  const routesByAgency = new Map<string, Route[]>();
  for (const route of routes.values()) {
    const agencyId = route.agency_id || singleAgencyId || '__unknown__';
    const arr = routesByAgency.get(agencyId);
    if (arr) arr.push(route); else routesByAgency.set(agencyId, [route]);
  }

  const allShapeKeys = new Set<string>();
  const tree: AgencyTreeNode[] = [];

  for (const [agencyId, agencyRoutes] of routesByAgency) {
    const agency: Agency = agencies.get(agencyId) ?? {
      agency_id: agencyId,
      agency_name: agencyId === '__unknown__' ? 'Unknown Agency' : agencyId,
    };

    const sortedRoutes = agencyRoutes.slice().sort((a, b) =>
      a.route_short_name.localeCompare(b.route_short_name, undefined, { numeric: true }),
    );

    const routeNodes: RouteTreeNode[] = [];
    for (const route of sortedRoutes) {
      const routeTrips = tripsByRoute.get(route.route_id) ?? [];

      const byShape = new Map<string, Trip[]>();
      for (const trip of routeTrips) {
        const key = trip.shape_id ?? `__noshape__:${route.route_id}`;
        const arr = byShape.get(key);
        if (arr) arr.push(trip); else byShape.set(key, [trip]);
      }

      const shapeGroups: ShapeGroup[] = [];
      for (const [key, groupTrips] of byShape) {
        const isNoShape = key.startsWith('__noshape__:');
        let label: string;
        if (isNoShape) {
          label = '(No shape)';
        } else if (shapeLabels.has(key)) {
          label = shapeLabels.get(key)!;
        } else {
          const headsigns = [...new Set(groupTrips.map(t => t.trip_headsign).filter((h): h is string => !!h))];
          label = headsigns.length === 1 ? headsigns[0] : `Shape ${key}`;
        }
        shapeGroups.push({
          key,
          shapeId: isNoShape ? undefined : key,
          label,
          tripIds: groupTrips.map(t => t.trip_id),
        });
        allShapeKeys.add(key);
      }

      // Real shapes first (by trip count desc), no-shape groups last
      shapeGroups.sort((a, b) => {
        if (!!a.shapeId !== !!b.shapeId) return a.shapeId ? -1 : 1;
        return b.tripIds.length - a.tripIds.length;
      });

      routeNodes.push({ route, shapeGroups, allKeys: shapeGroups.map(g => g.key) });
    }

    tree.push({
      agency,
      routes: routeNodes,
      allKeys: routeNodes.flatMap(r => r.allKeys),
    });
  }

  tree.sort((a, b) => a.agency.agency_name.localeCompare(b.agency.agency_name));
  return { tree, allShapeKeys };
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loadGtfsFromBlob(blob: Blob): Promise<GtfsData> {
  const buffer = await blob.arrayBuffer();
  const files = unzipSync(new Uint8Array(buffer));

  const getText = (name: string): string | null => {
    for (const key of Object.keys(files)) {
      if (key.toLowerCase() === name || key.toLowerCase().endsWith('/' + name))
        return strFromU8(files[key]);
    }
    return null;
  };

  const require = (name: string) => {
    const text = getText(name);
    if (!text) throw new Error(`${name} not found in GTFS zip`);
    return text;
  };

  const stopsRaw     = parseCSV(require('stops.txt'));
  const tripsRaw     = parseCSV(require('trips.txt'));
  const routesRaw    = parseCSV(require('routes.txt'));
  const stopTimesRaw = parseCSV(require('stop_times.txt'));
  const shapesRaw    = getText('shapes.txt') ? parseCSV(getText('shapes.txt')!) : [];
  const agenciesRaw  = getText('agency.txt') ? parseCSV(getText('agency.txt')!) : [];

  // Agencies
  const agencies = new Map<string, Agency>();
  for (const r of agenciesRaw) {
    const id = r.agency_id ?? '';
    agencies.set(id, {
      agency_id: id,
      agency_name: r.agency_name,
      agency_url: r.agency_url || undefined,
      agency_timezone: r.agency_timezone || undefined,
    });
  }

  // Stops
  const allStops = new Map<string, Stop>();
  for (const r of stopsRaw) {
    const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    allStops.set(r.stop_id, {
      stop_id: r.stop_id, stop_name: r.stop_name,
      stop_lat: lat, stop_lon: lon,
      stop_code: r.stop_code || undefined,
      stop_desc: r.stop_desc || undefined,
    });
  }

  // Trips
  const allTrips = new Map<string, Trip>();
  for (const r of tripsRaw) {
    allTrips.set(r.trip_id, {
      trip_id: r.trip_id, route_id: r.route_id,
      shape_id: r.shape_id || undefined,
      trip_headsign: r.trip_headsign || undefined,
      direction_id: r.direction_id || undefined,
    });
  }

  // Routes
  const allRoutes = new Map<string, Route>();
  for (const r of routesRaw) {
    allRoutes.set(r.route_id, {
      route_id: r.route_id,
      agency_id: r.agency_id ?? '',
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      route_color: r.route_color ? `#${r.route_color}` : undefined,
      route_text_color: r.route_text_color ? `#${r.route_text_color}` : undefined,
      route_type: r.route_type || undefined,
    });
  }

  // Stop times
  const stopTimes: StopTime[] = stopTimesRaw.map(r => ({
    trip_id: r.trip_id, stop_id: r.stop_id,
    arrival_time: r.arrival_time, departure_time: r.departure_time,
    stop_sequence: parseInt(r.stop_sequence, 10),
  }));

  // Orphan removal
  const referencedTripIds = new Set(stopTimes.map(st => st.trip_id));
  const referencedStopIds = new Set(stopTimes.map(st => st.stop_id));

  const trips  = new Map([...allTrips].filter(([id]) => referencedTripIds.has(id)));
  const stops  = new Map([...allStops].filter(([id]) => referencedStopIds.has(id)));

  const referencedRouteIds = new Set([...trips.values()].map(t => t.route_id));
  const routes = new Map([...allRoutes].filter(([id]) => referencedRouteIds.has(id)));

  const referencedShapeIds = new Set(
    [...trips.values()].map(t => t.shape_id).filter(Boolean) as string[],
  );

  // Real shapes from shapes.txt
  const shapes = new Map<string, ShapePoint[]>();
  for (const r of shapesRaw) {
    if (!referencedShapeIds.has(r.shape_id)) continue;
    const lat = parseFloat(r.shape_pt_lat), lon = parseFloat(r.shape_pt_lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    const pt: ShapePoint = { shape_pt_lat: lat, shape_pt_lon: lon, shape_pt_sequence: parseInt(r.shape_pt_sequence, 10) };
    const arr = shapes.get(r.shape_id);
    if (arr) arr.push(pt); else shapes.set(r.shape_id, [pt]);
  }

  // trip_id → ordered unique stop_ids index (needed for synthetic shapes)
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
      .map(([, stopId]) => stopId)
      .filter(s => seen.has(s) ? false : (seen.add(s), true));
    tripStops.set(tripId, ordered);
  }

  // Synthetic shapes: for trips with no shapes.txt entry, generate a polyline from stop coords
  const shapeLabels = new Map<string, string>();
  const seqToSyntheticId = new Map<string, string>();
  let synCount = 0;
  for (const trip of trips.values()) {
    if (trip.shape_id) continue;
    const stopList = tripStops.get(trip.trip_id) ?? [];
    if (stopList.length < 2) continue;
    const seqKey = stopList.join('|');
    let synId = seqToSyntheticId.get(seqKey);
    if (!synId) {
      synId = `__syn__${++synCount}`;
      seqToSyntheticId.set(seqKey, synId);
      const pts = stopList
        .map((sid, i) => {
          const s = stops.get(sid);
          return s ? { shape_pt_lat: s.stop_lat, shape_pt_lon: s.stop_lon, shape_pt_sequence: i } : null;
        })
        .filter((p): p is ShapePoint => p !== null);
      if (pts.length >= 2) {
        shapes.set(synId, pts);
        const firstStop = stops.get(stopList[0]);
        const lastStop  = stops.get(stopList[stopList.length - 1]);
        if (firstStop && lastStop)
          shapeLabels.set(synId, `${firstStop.stop_name} → ${lastStop.stop_name}`);
      }
    }
    if (synId && shapes.has(synId)) trip.shape_id = synId;
  }

  // shape_id → route color (runs after synthetic shape_ids are assigned to trips)
  const shapeToRoute = new Map<string, string>();
  for (const trip of trips.values()) {
    if (trip.shape_id && !shapeToRoute.has(trip.shape_id))
      shapeToRoute.set(trip.shape_id, trip.route_id);
  }
  const shapeColors = new Map<string, string>();
  for (const [shapeId, routeId] of shapeToRoute) {
    const color = routes.get(routeId)?.route_color;
    if (color) shapeColors.set(shapeId, color);
  }

  const { tree, allShapeKeys } = buildTree(agencies, routes, trips, shapeLabels);

  return { agencies, stops, trips, routes, shapes, stopTimes, shapeColors, tripStops, tree, allShapeKeys };
}

// Rewrite github.com raw/blob URLs to raw.githubusercontent.com to avoid
// CORS issues that arise from following cross-origin redirects.
function resolveUrl(url: string): string {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(raw|blob)\/(.+)$/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[3]}`;
  return url;
}

export async function loadGtfsFromUrl(url: string): Promise<GtfsData> {
  const resolved = resolveUrl(url.trim());
  let response: Response;
  try {
    response = await fetch(resolved, { redirect: 'follow' });
  } catch {
    throw new Error(
      'Network error — this may be a CORS restriction. Try downloading the file and uploading it instead.',
    );
  }
  if (!response.ok) throw new Error(`Server returned ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return loadGtfsFromBlob(blob);
}