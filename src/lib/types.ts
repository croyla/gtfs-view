export interface Agency {
  agency_id: string;
  agency_name: string;
  agency_url?: string;
  agency_timezone?: string;
}

export interface Stop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  stop_code?: string;
  stop_desc?: string;
}

export interface Trip {
  trip_id: string;
  route_id: string;
  shape_id?: string;
  trip_headsign?: string;
  direction_id?: string;
}

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color?: string;
  route_text_color?: string;
  route_type?: string;
}

export interface ShapePoint {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
}

export interface StopTime {
  trip_id: string;
  stop_id: string;
  arrival_time: string;
  departure_time: string;
  stop_sequence: number;
}

// ── Sidebar tree ──────────────────────────────────────────────────────────────

export interface ShapeGroup {
  key: string;       // shape_id or `__noshape__:${route_id}`
  shapeId?: string;  // undefined for no-shape groups
  label: string;
  tripIds: string[];
}

export interface RouteTreeNode {
  route: Route;
  shapeGroups: ShapeGroup[];
  allKeys: string[];
}

export interface AgencyTreeNode {
  agency: Agency;
  routes: RouteTreeNode[];
  allKeys: string[];
}

// ── GtfsData ──────────────────────────────────────────────────────────────────

export interface GtfsData {
  agencies: Map<string, Agency>;
  stops: Map<string, Stop>;
  trips: Map<string, Trip>;
  routes: Map<string, Route>;
  shapes: Map<string, ShapePoint[]>;
  stopTimes: StopTime[];
  shapeColors: Map<string, string>;
  tripStops: Map<string, string[]>; // trip_id → ordered unique stop_ids
  tree: AgencyTreeNode[];
  allShapeKeys: Set<string>;
}