import type { ShapePoint } from '../types/types';

export function localMidnightEpoch(dateStr: string, timezone: string): number {
  if (dateStr.length !== 8) return 0;
  const y = dateStr.slice(0, 4), mo = dateStr.slice(4, 6), d = dateStr.slice(6, 8);
  const noonUtcMs = Date.parse(`${y}-${mo}-${d}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(noonUtcMs));
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '12');
  const mi = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  const s  = parseInt(parts.find(p => p.type === 'second')?.value ?? '0');
  return (noonUtcMs - (h * 3600 + mi * 60 + s) * 1000) / 1000;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseTimeMin(t: string): number {
  if (!t) return 0;
  const [h = '0', m = '0', s = '0'] = t.split(':');
  return parseInt(h) * 60 + parseInt(m) + parseInt(s) / 60;
}

export function formatTime(t: string): string {
  if (!t) return '—';
  const [h = '0', m = '00'] = t.split(':');
  return `${(parseInt(h) % 24).toString().padStart(2, '0')}:${m}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h === 0 ? `${m} min` : `${h}h ${m}m`;
}

export function shapeDistanceKm(points: ShapePoint[]): number {
  const sorted = [...points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
  let dist = 0;
  for (let i = 1; i < sorted.length; i++) {
    dist += haversineKm(
      sorted[i - 1].shape_pt_lat, sorted[i - 1].shape_pt_lon,
      sorted[i].shape_pt_lat,     sorted[i].shape_pt_lon,
    );
  }
  return dist;
}