import { matchBlockPings, makeEpochToMin, buildSortedPings } from './schedulePings';
import { computeBlockMetrics } from './scheduleMetrics';
import type { GtfsData, StopTime, Stop } from '../../types/types';
import type { VehiclePosition } from '../../types/liveTypes';

interface RawPosition {
  lat:        number;
  lon:        number;
  timestamp:  number;  // Unix epoch seconds
  vehicle_id: string;
}

interface TaggedPosition {
  lat:        number;
  lon:        number;
  timestamp:  number;
  vehicle_id: string;
  trip_id:    string | null;
}

interface WorkerInput {
  sortedTripIds:    string[];
  rawPositions:     RawPosition[];
  taggedPositions:  TaggedPosition[];
  timezone:         string;
  stopTimesByTrip:  Record<string, StopTime[]>;
  stops:            Record<string, Stop>;
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  try {
    const { sortedTripIds, rawPositions, taggedPositions, timezone, stopTimesByTrip, stops } = e.data;

    const gtfsSubset = {
      stopTimesByTrip: new Map(Object.entries(stopTimesByTrip)),
      stops:           new Map(Object.entries(stops)),
    } as unknown as GtfsData;

    const epochToMin = makeEpochToMin(timezone);
    const vehiclePositions: VehiclePosition[] = rawPositions.map((p, i) => ({
      id: i, vehicle_id: p.vehicle_id, trip_id: null, route_id: null,
      lat: p.lat, lon: p.lon, bearing: null, speed: null, status: '',
      timestamp: p.timestamp,
    }));

    const pingData = matchBlockPings(sortedTripIds, buildSortedPings(vehiclePositions, epochToMin), gtfsSubset);

    // Reconstruct tagged VehiclePosition[] for data-availability accounting
    const livePositions: VehiclePosition[] = taggedPositions.map((p, i) => ({
      id: i, vehicle_id: p.vehicle_id, trip_id: p.trip_id, route_id: null,
      lat: p.lat, lon: p.lon, bearing: null, speed: null, status: '',
      timestamp: p.timestamp,
    }));

    const metrics = computeBlockMetrics(pingData, livePositions, gtfsSubset);

    self.postMessage({ ok: true, pingData, metrics });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};