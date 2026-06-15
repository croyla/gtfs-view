/// <reference types="vite/client" />

const BASE_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080').replace(/\/$/, '');

let _token: string | null = sessionStorage.getItem('dvg_token');

export function getToken(): string | null { return _token; }

export function setToken(t: string): void {
  _token = t;
  sessionStorage.setItem('dvg_token', t);
}

export function clearToken(): void {
  _token = null;
  sessionStorage.removeItem('dvg_token');
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!_token) throw new Error('AUTH_REQUIRED');
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: _token,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function authenticate(password: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) throw new Error('Incorrect password');
  if (!res.ok) throw new Error(`Auth error: HTTP ${res.status}`);
  const body = await res.json() as { token: string; expires_at: string };
  setToken(body.token);
}

export interface ApiAgency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_phone: string;
}

export interface ApiRoute {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: string;
}

export interface ApiStop {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
}

export interface ApiTrip {
  route_id: string;
  service_id: string;
  trip_id: string;
}

export interface ApiStopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: string;
}

export interface ApiVehicleAssignment {
  trip_id: string;
  vehicle_id: string;
  block_id: string;
}

export interface ApiPosition {
  vehicle_id: string;
  license_no: string;
  lat: number;
  lon: number;
  timestamp: string;
}

export interface ApiPositionUpdate extends ApiPosition {
  id: number;
}

export type WsMessage =
  | { type: 'snapshot'; positions: ApiPosition[] }
  | { type: 'update';   positions: ApiPositionUpdate[] };

export interface ApiGtfsBundle {
  agency: ApiAgency[];
  routes: ApiRoute[];
  stops: ApiStop[];
  trips: ApiTrip[];
  stopTimes: ApiStopTime[];
  vehicleAssignments: ApiVehicleAssignment[];
}

export async function fetchDates(): Promise<string[]> {
  return apiFetch<string[]>('/v1/dates');
}

export async function fetchGtfsBundle(date: string): Promise<ApiGtfsBundle> {
  const [agency, routes, stops, trips, stopTimes, vehicleAssignments] = await Promise.all([
    apiFetch<ApiAgency[]>(`/v1/${date}/agency`),
    apiFetch<ApiRoute[]>(`/v1/${date}/routes`),
    apiFetch<ApiStop[]>(`/v1/${date}/stops`),
    apiFetch<ApiTrip[]>(`/v1/${date}/trips`),
    apiFetch<ApiStopTime[]>(`/v1/${date}/stop_times`),
    apiFetch<ApiVehicleAssignment[]>(`/v1/${date}/vehicle_assignments`),
  ]);
  return { agency, routes, stops, trips, stopTimes, vehicleAssignments };
}

export async function fetchPositions(date: string): Promise<ApiPosition[]> {
  return apiFetch<ApiPosition[]>(`/v1/${date}/positions`);
}

export function openPositionStream(date: string): WebSocket {
  if (!_token) throw new Error('Not authenticated');
  const wsBase = BASE_URL.replace(/^http/, 'ws');
  // Browsers cannot set Authorization headers on WebSocket upgrades; pass via query param
  return new WebSocket(`${wsBase}/v1/${date}/positions/stream?token=${encodeURIComponent(_token)}`);
}
