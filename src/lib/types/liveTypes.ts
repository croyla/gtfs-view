export interface VehiclePosition {
  id: number;
  vehicle_id: string;
  trip_id: string | null;
  route_id: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  timestamp: number;    // Unix epoch seconds
  speed: number | null; // m/s from source (null in this dataset — derived instead)
  status: string;
  interpolated?: boolean; // true for ephemeral points synthesized between real pings
}

// Vehicle position enriched with derived speed (computed from consecutive position deltas)
export interface TrackedPosition {
  timestamp: number;
  lat: number;
  lon: number;
  bearing: number | null;
  speed_ms: number; // derived m/s
}

// Speed time-series + positions for a single trip run, used for visualisation later
export interface VehicleTrack {
  trip_id: string;
  route_id: string | null;
  vehicle_id: string;
  positions: TrackedPosition[];
}

export interface LiveStopTime {
  stop_id: string;
  trip_id: string;
  route_id: string | null;
  stop_sequence: number;
  // Static schedule (null if trip not found in GTFS)
  scheduled_arrival: string | null;
  scheduled_departure: string | null;
  // Live observation
  estimated_arrival: number | null; // Unix epoch seconds
  visited: boolean;
  skipped: boolean;     // vehicle passed within range but did not stop
  min_distance_m: number; // closest the vehicle got to this stop
  // Timeliness (null when not visited or no schedule)
  deviation_s: number | null;  // positive = late, negative = early
  on_time: boolean | null;
}

export interface LiveData {
  vehiclePositions: VehiclePosition[];
  minTimestamp: number;
  maxTimestamp: number;
  vehicleCount: number;
  routeCount: number;
}
