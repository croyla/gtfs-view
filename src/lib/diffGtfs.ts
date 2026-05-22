import { haversineKm } from './popupUtils';
import type { GtfsData, Stop, Route, Trip, ShapePoint } from './types';

export type StopDiffKind   = 'added' | 'removed' | 'moved';
export type RouteDiffKind  = 'added' | 'removed' | 'changed';
export type TripDiffKind   = 'added' | 'removed' | 'changed';
export type ShapeDiffKind  = 'added' | 'removed' | 'changed';

export const DIFF_COLORS: Record<StopDiffKind | 'unchanged', string> = {
  added:     '#22c55e',
  removed:   '#ef4444',
  moved:     '#60a5fa',
  unchanged: '#ffffff',
};

export const SHAPE_DIFF_COLORS: Record<ShapeDiffKind | 'unchanged', string> = {
  added:     '#22c55e',
  removed:   '#ef4444',
  changed:   '#60a5fa',
  unchanged: '#818cf8',
};

export interface StopDiff {
  kind: StopDiffKind;
  stop: Stop;       // new position (or old if removed)
  oldStop?: Stop;   // old position (moved only)
  distanceM?: number;
}

export interface RouteDiff {
  kind: RouteDiffKind;
  route: Route;     // new (or old if removed)
  oldRoute?: Route;
  changes?: string[];
}

export interface TripStopChange {
  stopId: string;
  stopName: string | null;
  sequence: number;
  kind: 'stop-added' | 'stop-removed' | 'timing-changed';
  oldTime?: string | null;
  newTime?: string | null;
}

export interface TripDiff {
  kind: TripDiffKind;
  trip: Trip;       // new (or old if removed)
  routeId: string;
  stopChanges?: TripStopChange[];
}

export interface GtfsDiff {
  stops:  Map<string, StopDiff>;
  routes: Map<string, RouteDiff>;
  trips:  Map<string, TripDiff>;
  shapes: Map<string, ShapeDiffKind>;

  stopsAdded:     number;
  stopsRemoved:   number;
  stopsMoved:     number;
  stopsUnchanged: number;
  routesAdded:     number;
  routesRemoved:   number;
  routesChanged:   number;
  routesUnchanged: number;
  tripsAdded:     number;
  tripsRemoved:   number;
  tripsChanged:   number;
  tripsUnchanged: number;
  shapesAdded:   number;
  shapesRemoved: number;
  shapesChanged: number;
}

const MOVE_THRESHOLD_M = 10;

function shapesEqual(a: ShapePoint[], b: ShapePoint[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x.shape_pt_sequence - y.shape_pt_sequence);
  const sb = [...b].sort((x, y) => x.shape_pt_sequence - y.shape_pt_sequence);
  for (let i = 0; i < sa.length; i++) {
    if (Math.abs(sa[i].shape_pt_lat - sb[i].shape_pt_lat) > 1e-6) return false;
    if (Math.abs(sa[i].shape_pt_lon - sb[i].shape_pt_lon) > 1e-6) return false;
  }
  return true;
}

function computeTripStopChanges(
  oldSTs: import('./types').StopTime[],
  newSTs: import('./types').StopTime[],
  newData: GtfsData,
): TripStopChange[] {
  const changes: TripStopChange[] = [];
  const oldBySeq = new Map(oldSTs.map(s => [s.stop_sequence, s]));
  const newBySeq = new Map(newSTs.map(s => [s.stop_sequence, s]));

  const allSeqs = new Set([...oldBySeq.keys(), ...newBySeq.keys()]);
  for (const seq of [...allSeqs].sort((a, b) => a - b)) {
    const o = oldBySeq.get(seq);
    const n = newBySeq.get(seq);
    if (!o && n) {
      changes.push({ stopId: n.stop_id, stopName: newData.stops.get(n.stop_id)?.stop_name ?? null, sequence: seq, kind: 'stop-added' });
    } else if (o && !n) {
      changes.push({ stopId: o.stop_id, stopName: newData.stops.get(o.stop_id)?.stop_name ?? null, sequence: seq, kind: 'stop-removed' });
    } else if (o && n) {
      const timeChanged = o.arrival_time !== n.arrival_time || o.departure_time !== n.departure_time;
      if (o.stop_id !== n.stop_id) {
        changes.push({ stopId: o.stop_id, stopName: newData.stops.get(o.stop_id)?.stop_name ?? null, sequence: seq, kind: 'stop-removed' });
        changes.push({ stopId: n.stop_id, stopName: newData.stops.get(n.stop_id)?.stop_name ?? null, sequence: seq, kind: 'stop-added' });
      } else if (timeChanged) {
        changes.push({
          stopId: n.stop_id,
          stopName: newData.stops.get(n.stop_id)?.stop_name ?? null,
          sequence: seq,
          kind: 'timing-changed',
          oldTime: o.arrival_time || o.departure_time,
          newTime: n.arrival_time || n.departure_time,
        });
      }
    }
  }
  return changes;
}

export function computeDiff(oldData: GtfsData, newData: GtfsData): GtfsDiff {
  const stops  = new Map<string, StopDiff>();
  const routes = new Map<string, RouteDiff>();
  const trips  = new Map<string, TripDiff>();
  const shapes = new Map<string, ShapeDiffKind>();

  // Stops
  for (const [id, newStop] of newData.stops) {
    const oldStop = oldData.stops.get(id);
    if (!oldStop) {
      stops.set(id, { kind: 'added', stop: newStop });
    } else {
      const distanceM = haversineKm(oldStop.stop_lat, oldStop.stop_lon, newStop.stop_lat, newStop.stop_lon) * 1000;
      if (distanceM >= MOVE_THRESHOLD_M) {
        stops.set(id, { kind: 'moved', stop: newStop, oldStop, distanceM });
      }
    }
  }
  for (const [id, oldStop] of oldData.stops) {
    if (!newData.stops.has(id)) stops.set(id, { kind: 'removed', stop: oldStop });
  }

  // Routes
  for (const [id, newRoute] of newData.routes) {
    const oldRoute = oldData.routes.get(id);
    if (!oldRoute) {
      routes.set(id, { kind: 'added', route: newRoute });
    } else {
      const changes: string[] = [];
      if (oldRoute.route_short_name !== newRoute.route_short_name) changes.push('short name');
      if (oldRoute.route_long_name  !== newRoute.route_long_name)  changes.push('long name');
      if (oldRoute.route_color      !== newRoute.route_color)      changes.push('colour');
      if (changes.length) routes.set(id, { kind: 'changed', route: newRoute, oldRoute, changes });
    }
  }
  for (const [id, oldRoute] of oldData.routes) {
    if (!newData.routes.has(id)) routes.set(id, { kind: 'removed', route: oldRoute });
  }

  // Shapes
  for (const [id, newPts] of newData.shapes) {
    const oldPts = oldData.shapes.get(id);
    if (!oldPts) shapes.set(id, 'added');
    else if (!shapesEqual(oldPts, newPts)) shapes.set(id, 'changed');
  }
  for (const id of oldData.shapes.keys()) {
    if (!newData.shapes.has(id)) shapes.set(id, 'removed');
  }

  // Trips
  for (const [id, newTrip] of newData.trips) {
    const oldTrip = oldData.trips.get(id);
    if (!oldTrip) {
      trips.set(id, { kind: 'added', trip: newTrip, routeId: newTrip.route_id });
    } else {
      const stopChanges = computeTripStopChanges(
        oldData.stopTimesByTrip.get(id) ?? [],
        newData.stopTimesByTrip.get(id) ?? [],
        newData,
      );
      if (stopChanges.length) {
        trips.set(id, { kind: 'changed', trip: newTrip, routeId: newTrip.route_id, stopChanges });
      }
    }
  }
  for (const [id, oldTrip] of oldData.trips) {
    if (!newData.trips.has(id)) trips.set(id, { kind: 'removed', trip: oldTrip, routeId: oldTrip.route_id });
  }

  const countKind = <T extends { kind: string }>(m: Map<string, T>, k: string) =>
    [...m.values()].filter(v => v.kind === k).length;
  const countShape = (k: ShapeDiffKind) => [...shapes.values()].filter(v => v === k).length;

  const stopsAdded   = countKind(stops, 'added');
  const stopsRemoved = countKind(stops, 'removed');
  const stopsMoved   = countKind(stops, 'moved');
  const routesAdded   = countKind(routes, 'added');
  const routesRemoved = countKind(routes, 'removed');
  const routesChanged = countKind(routes, 'changed');
  const tripsAdded   = countKind(trips, 'added');
  const tripsRemoved = countKind(trips, 'removed');
  const tripsChanged = countKind(trips, 'changed');

  return {
    stops, routes, trips, shapes,
    stopsAdded, stopsRemoved, stopsMoved,
    stopsUnchanged: newData.stops.size - stopsAdded - stopsMoved,
    routesAdded, routesRemoved, routesChanged,
    routesUnchanged: newData.routes.size - routesAdded - routesChanged,
    tripsAdded, tripsRemoved, tripsChanged,
    tripsUnchanged: newData.trips.size - tripsAdded - tripsChanged,
    shapesAdded:   countShape('added'),
    shapesRemoved: countShape('removed'),
    shapesChanged: countShape('changed'),
  };
}

// ── GeoJSON helpers for the map ───────────────────────────────────────────────

import type { Feature, FeatureCollection, Point, LineString } from 'geojson';

export function buildDiffStopsGeoJSON(
  oldData: GtfsData,
  newData: GtfsData,
  diff: GtfsDiff,
): FeatureCollection {
  const features: Feature<Point>[] = [];

  // All stops from new feed (added / moved / unchanged)
  for (const [stopId, stop] of newData.stops) {
    const d = diff.stops.get(stopId);
    const color = d ? DIFF_COLORS[d.kind] : DIFF_COLORS.unchanged;
    features.push({
      type: 'Feature',
      properties: { stop_id: stopId, stop_name: stop.stop_name, diff_kind: d?.kind ?? null, diff_color: color },
      geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] },
    });
  }

  // Removed stops (only in old feed)
  for (const [stopId, sd] of diff.stops) {
    if (sd.kind !== 'removed') continue;
    const stop = oldData.stops.get(stopId)!;
    features.push({
      type: 'Feature',
      properties: { stop_id: stopId, stop_name: stop.stop_name, diff_kind: 'removed', diff_color: DIFF_COLORS.removed },
      geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] },
    });
  }

  return { type: 'FeatureCollection', features };
}

export function buildDiffShapesGeoJSON(
  oldData: GtfsData,
  newData: GtfsData,
  diff: GtfsDiff,
): FeatureCollection {
  const features: Feature<LineString>[] = [];

  function shapeFeature(shapeId: string, pts: ShapePoint[], color: string): Feature<LineString> {
    const sorted = [...pts].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    return {
      type: 'Feature',
      properties: { shape_id: shapeId, diff_color: color },
      geometry: { type: 'LineString', coordinates: sorted.map(p => [p.shape_pt_lon, p.shape_pt_lat]) },
    };
  }

  // All shapes from new feed
  for (const [shapeId, pts] of newData.shapes) {
    const kind = diff.shapes.get(shapeId);
    const color = kind ? SHAPE_DIFF_COLORS[kind] : SHAPE_DIFF_COLORS.unchanged;
    features.push(shapeFeature(shapeId, pts, color));
  }

  // Removed shapes (only in old feed)
  for (const [shapeId, kind] of diff.shapes) {
    if (kind !== 'removed') continue;
    const pts = oldData.shapes.get(shapeId);
    if (pts) features.push(shapeFeature(shapeId, pts, SHAPE_DIFF_COLORS.removed));
  }

  return { type: 'FeatureCollection', features };
}