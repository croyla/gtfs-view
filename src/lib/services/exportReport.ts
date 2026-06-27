import { haversineKm, parseTimeMin } from './popupUtils';
import type { GtfsData } from '../types/types';
import type { LiveProcessed } from './live/liveStopTimes';

export type ExportScope =
  | { kind: 'all' }
  | { kind: 'trip'; tripId: string }
  | { kind: 'route'; routeId: string }
  | { kind: 'stop'; stopId: string };

export type ReportType = 'trip-completion' | 'data-availability' | 'punctuality';
export type ExportFormat = 'json' | 'html' | 'pdf';

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

export function scopeLabel(scope: ExportScope, gtfsData: GtfsData): string {
  switch (scope.kind) {
    case 'all': return 'All data';
    case 'trip': {
      const trip = gtfsData.trips.get(scope.tripId);
      return trip?.trip_headsign ? `Trip — ${trip.trip_headsign}` : `Trip ${scope.tripId}`;
    }
    case 'route': {
      const r = gtfsData.routes.get(scope.routeId);
      return r ? `Route ${r.route_short_name || scope.routeId}` : `Route ${scope.routeId}`;
    }
    case 'stop': {
      const s = gtfsData.stops.get(scope.stopId);
      return s?.stop_name ? `Stop — ${s.stop_name}` : `Stop ${scope.stopId}`;
    }
  }
}

function resolveTrips(scope: ExportScope, lp: LiveProcessed): {
  scheduled: Set<string>;
  observed: Set<string>;
} {
  switch (scope.kind) {
    case 'all':
      return { scheduled: lp.scheduledTripIds, observed: lp.observedTripIds };
    case 'trip': {
      const sched = lp.scheduledTripIds.has(scope.tripId) ? new Set([scope.tripId]) : new Set<string>();
      const obs = lp.observedTripIds.has(scope.tripId) ? new Set([scope.tripId]) : new Set<string>();
      return { scheduled: sched, observed: obs };
    }
    case 'route': {
      const obs = new Set((lp.byRoute.get(scope.routeId) ?? []).map(s => s.trip_id));
      return { scheduled: lp.scheduledByRoute.get(scope.routeId) ?? new Set(), observed: obs };
    }
    case 'stop': {
      const obs = new Set((lp.byStop.get(scope.stopId) ?? []).map(s => s.trip_id));
      return { scheduled: lp.scheduledByStop.get(scope.stopId) ?? new Set(), observed: obs };
    }
  }
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

function fmtSeconds(s: number | null): string {
  if (s === null) return '—';
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  const sec = Math.round(abs % 60);
  const sign = s < 0 ? '-' : '+';
  if (m === 0) return `${sign}${sec}s`;
  return sec === 0 ? `${sign}${m}m` : `${sign}${m}m ${sec}s`;
}

function fmtUnixTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Trip Completion ────────────────────────────────────────────────────────────

export interface TripCompletionSettings { radialDistanceM: number; }

export interface TripCompletionTripRow {
  tripId: string;
  routeId: string | null;
  headsign: string | null;
  totalStops: number;
  touchedStops: number;
  completionPct: number | null;
  hasLiveData: boolean;
}

export interface TripCompletionReport {
  type: 'trip-completion';
  scope: string;
  generatedAt: string;
  settings: TripCompletionSettings;
  summary: {
    tripsScheduled: number;
    tripsWithData: number;
    totalStops: number;
    touchedStops: number;
    avgCompletionPct: number | null;
  };
  trips: TripCompletionTripRow[];
}

export function computeTripCompletion(
  scope: ExportScope,
  gtfsData: GtfsData,
  lp: LiveProcessed,
  settings: TripCompletionSettings,
): TripCompletionReport {
  const { scheduled } = resolveTrips(scope, lp);

  const rows: TripCompletionTripRow[] = [];
  for (const tripId of scheduled) {
    const trip = gtfsData.trips.get(tripId);
    const stopIds = gtfsData.tripStops.get(tripId) ?? [];
    const totalStops = stopIds.length;
    const track = lp.tracks.get(tripId);

    if (!track || track.positions.length === 0) {
      rows.push({
        tripId, routeId: trip?.route_id ?? null, headsign: trip?.trip_headsign ?? null,
        totalStops, touchedStops: 0, completionPct: null, hasLiveData: false,
      });
      continue;
    }

    let touchedStops = 0;
    for (const stopId of stopIds) {
      const stop = gtfsData.stops.get(stopId);
      if (!stop) continue;
      let minDist = Infinity;
      for (const pos of track.positions) {
        const d = haversineM(stop.stop_lat, stop.stop_lon, pos.lat, pos.lon);
        if (d < minDist) minDist = d;
      }
      if (minDist <= settings.radialDistanceM) touchedStops++;
    }

    rows.push({
      tripId, routeId: trip?.route_id ?? null, headsign: trip?.trip_headsign ?? null,
      totalStops, touchedStops,
      completionPct: totalStops > 0 ? (touchedStops / totalStops) * 100 : null,
      hasLiveData: true,
    });
  }

  const pcts = rows.filter(r => r.hasLiveData && r.completionPct !== null).map(r => r.completionPct!);
  return {
    type: 'trip-completion',
    scope: scopeLabel(scope, gtfsData),
    generatedAt: new Date().toISOString(),
    settings,
    summary: {
      tripsScheduled: scheduled.size,
      tripsWithData: rows.filter(r => r.hasLiveData).length,
      totalStops: rows.reduce((a, r) => a + r.totalStops, 0),
      touchedStops: rows.reduce((a, r) => a + r.touchedStops, 0),
      avgCompletionPct: pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    },
    trips: rows.sort((a, b) => (a.completionPct ?? -1) - (b.completionPct ?? -1)),
  };
}

// ── Data Availability ─────────────────────────────────────────────────────────

export interface DataAvailabilitySettings { expectedIntervalS: number; }

export interface DataAvailabilityTripRow {
  tripId: string;
  routeId: string | null;
  headsign: string | null;
  pingCount: number;
  firstPingTime: number | null;
  lastPingTime: number | null;
  durationS: number | null;
  maxGapS: number | null;
  gapsExceedingThreshold: number;
  coveragePct: number | null;
}

export interface DataAvailabilityReport {
  type: 'data-availability';
  scope: string;
  generatedAt: string;
  settings: DataAvailabilitySettings;
  summary: {
    tripsObserved: number;
    tripsWithGaps: number;
    avgMaxGapS: number | null;
    avgCoveragePct: number | null;
  };
  trips: DataAvailabilityTripRow[];
}

export function computeDataAvailability(
  scope: ExportScope,
  gtfsData: GtfsData,
  lp: LiveProcessed,
  settings: DataAvailabilitySettings,
): DataAvailabilityReport {
  const { observed } = resolveTrips(scope, lp);

  const rows: DataAvailabilityTripRow[] = [];
  for (const tripId of observed) {
    const trip = gtfsData.trips.get(tripId);
    const track = lp.tracks.get(tripId);
    if (!track || track.positions.length === 0) continue;

    const sorted = [...track.positions].sort((a, b) => a.timestamp - b.timestamp);
    const pingCount = sorted.length;
    const firstPingTime = sorted[0].timestamp;
    const lastPingTime = sorted[sorted.length - 1].timestamp;
    const durationS = lastPingTime - firstPingTime;

    let maxGapS = 0;
    let gapsExceedingThreshold = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
      if (gap > maxGapS) maxGapS = gap;
      if (gap > settings.expectedIntervalS) gapsExceedingThreshold++;
    }

    const totalIntervals = pingCount - 1;
    const goodIntervals = totalIntervals - gapsExceedingThreshold;
    const coveragePct = totalIntervals > 0 ? (goodIntervals / totalIntervals) * 100 : 100;

    rows.push({
      tripId, routeId: trip?.route_id ?? null, headsign: trip?.trip_headsign ?? null,
      pingCount, firstPingTime, lastPingTime, durationS,
      maxGapS: pingCount > 1 ? maxGapS : null,
      gapsExceedingThreshold, coveragePct,
    });
  }

  const maxGaps = rows.map(r => r.maxGapS).filter((g): g is number => g !== null);
  const coverages = rows.map(r => r.coveragePct).filter((p): p is number => p !== null);
  return {
    type: 'data-availability',
    scope: scopeLabel(scope, gtfsData),
    generatedAt: new Date().toISOString(),
    settings,
    summary: {
      tripsObserved: observed.size,
      tripsWithGaps: rows.filter(r => r.gapsExceedingThreshold > 0).length,
      avgMaxGapS: maxGaps.length > 0 ? maxGaps.reduce((a, b) => a + b, 0) / maxGaps.length : null,
      avgCoveragePct: coverages.length > 0 ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null,
    },
    trips: rows.sort((a, b) => b.gapsExceedingThreshold - a.gapsExceedingThreshold),
  };
}

// ── Punctuality ───────────────────────────────────────────────────────────────

export interface PunctualitySettings { radialDistanceM: number; bufferMinutes: number; }

export type PunctualityStatus = 'on-time' | 'late' | 'early' | 'skipped' | 'no-data';

export interface PunctualityStopRow {
  stopId: string;
  stopName: string | null;
  sequence: number;
  scheduledTime: string | null;
  estimatedArrivalTime: number | null;
  deviationS: number | null;
  status: PunctualityStatus;
}

export interface PunctualityTripRow {
  tripId: string;
  routeId: string | null;
  headsign: string | null;
  hasLiveData: boolean;
  stops: PunctualityStopRow[];
  onTimePct: number | null;
}

export interface PunctualityReport {
  type: 'punctuality';
  scope: string;
  generatedAt: string;
  settings: PunctualitySettings;
  summary: {
    tripsScheduled: number;
    tripsWithData: number;
    totalStops: number;
    onTimeStops: number;
    lateStops: number;
    earlyStops: number;
    skippedStops: number;
    noDataStops: number;
    avgOnTimePct: number | null;
  };
  trips: PunctualityTripRow[];
}

export function computePunctuality(
  scope: ExportScope,
  gtfsData: GtfsData,
  lp: LiveProcessed,
  settings: PunctualitySettings,
): PunctualityReport {
  const { scheduled } = resolveTrips(scope, lp);
  const bufferS = settings.bufferMinutes * 60;
  const svcStart = lp.serviceDateStart;

  const rows: PunctualityTripRow[] = [];
  for (const tripId of scheduled) {
    const trip = gtfsData.trips.get(tripId);
    const staticSTs = gtfsData.stopTimesByTrip.get(tripId) ?? [];
    const track = lp.tracks.get(tripId);

    if (!track || track.positions.length === 0) {
      rows.push({
        tripId, routeId: trip?.route_id ?? null, headsign: trip?.trip_headsign ?? null,
        hasLiveData: false,
        stops: staticSTs.map(st => ({
          stopId: st.stop_id, stopName: gtfsData.stops.get(st.stop_id)?.stop_name ?? null,
          sequence: st.stop_sequence, scheduledTime: st.arrival_time || st.departure_time,
          estimatedArrivalTime: null, deviationS: null, status: 'no-data' as const,
        })),
        onTimePct: null,
      });
      continue;
    }

    const stopRows: PunctualityStopRow[] = [];
    for (const st of staticSTs) {
      const stop = gtfsData.stops.get(st.stop_id);
      const scheduledTime = st.arrival_time || st.departure_time;

      let minDistM = Infinity;
      let nearestTs: number | null = null;
      for (const pos of track.positions) {
        const d = haversineM(stop?.stop_lat ?? 0, stop?.stop_lon ?? 0, pos.lat, pos.lon);
        if (d < minDistM) { minDistM = d; nearestTs = pos.timestamp; }
      }

      if (minDistM > settings.radialDistanceM) {
        stopRows.push({
          stopId: st.stop_id, stopName: stop?.stop_name ?? null,
          sequence: st.stop_sequence, scheduledTime,
          estimatedArrivalTime: null, deviationS: null, status: 'skipped',
        });
        continue;
      }

      let deviationS: number | null = null;
      let status: PunctualityStatus = 'on-time';
      if (scheduledTime && nearestTs !== null) {
        deviationS = nearestTs - (svcStart + parseTimeMin(scheduledTime) * 60);
        status = Math.abs(deviationS) <= bufferS ? 'on-time' : deviationS > 0 ? 'late' : 'early';
      }

      stopRows.push({
        stopId: st.stop_id, stopName: stop?.stop_name ?? null,
        sequence: st.stop_sequence, scheduledTime,
        estimatedArrivalTime: nearestTs, deviationS, status,
      });
    }

    const withSchedule = stopRows.filter(r => r.scheduledTime && r.status !== 'no-data');
    const onTime = withSchedule.filter(r => r.status === 'on-time').length;

    rows.push({
      tripId, routeId: trip?.route_id ?? null, headsign: trip?.trip_headsign ?? null,
      hasLiveData: true, stops: stopRows,
      onTimePct: withSchedule.length > 0 ? (onTime / withSchedule.length) * 100 : null,
    });
  }

  const pcts = rows.map(r => r.onTimePct).filter((p): p is number => p !== null);
  const count = (status: PunctualityStatus) => rows.reduce((a, r) => a + r.stops.filter(s => s.status === status).length, 0);
  return {
    type: 'punctuality',
    scope: scopeLabel(scope, gtfsData),
    generatedAt: new Date().toISOString(),
    settings,
    summary: {
      tripsScheduled: scheduled.size,
      tripsWithData: rows.filter(r => r.hasLiveData).length,
      totalStops: rows.reduce((a, r) => a + r.stops.length, 0),
      onTimeStops: count('on-time'), lateStops: count('late'), earlyStops: count('early'),
      skippedStops: count('skipped'), noDataStops: count('no-data'),
      avgOnTimePct: pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    },
    trips: rows.sort((a, b) => (a.onTimePct ?? -1) - (b.onTimePct ?? -1)),
  };
}

// ── Download helpers ──────────────────────────────────────────────────────────

export type AnyReport = TripCompletionReport | DataAvailabilityReport | PunctualityReport;

export function downloadJson(report: AnyReport) {
  const filename = `${report.type}-${Date.now()}.json`;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── HTML generation ───────────────────────────────────────────────────────────

const CSS = `
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
  h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 4px; }
  .meta { font-size: 0.75rem; color: #64748b; margin-bottom: 20px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 8px; padding: 12px 14px; }
  .card-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 4px; }
  .card-value { font-size: 1.1rem; font-weight: 700; }
  .green { color: #34d399; } .yellow { color: #fbbf24; } .red { color: #f87171; }
  .blue { color: #60a5fa; } .gray { color: #94a3b8; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; padding: 6px 10px; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; border-bottom: 1px solid #334155; }
  td { padding: 6px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  tr:hover td { background: #1e293b; }
  .badge { display: inline-block; border-radius: 4px; padding: 2px 6px; font-size: 0.65rem; font-weight: 600; }
  .badge-green { background: #052e16; color: #34d399; }
  .badge-red { background: #450a0a; color: #f87171; }
  .badge-yellow { background: #422006; color: #fbbf24; }
  .badge-blue { background: #082f49; color: #60a5fa; }
  .badge-gray { background: #1e293b; color: #94a3b8; }
  .section-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin: 20px 0 10px; }
  @media print { body { background: white; color: black; } .card { background: #f1f5f9; } th,td { border-color: #e2e8f0; } }
`;

function pctColor(v: number | null): string {
  if (v === null) return 'gray';
  if (v >= 80) return 'green';
  if (v >= 60) return 'yellow';
  return 'red';
}

function htmlDoc(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function summaryCards(pairs: [string, string, string?][]): string {
  return `<div class="summary">${pairs.map(([label, value, color]) =>
    `<div class="card"><div class="card-label">${label}</div><div class="card-value ${color ?? ''}">${value}</div></div>`
  ).join('')}</div>`;
}

export function generateHtml(report: AnyReport): string {
  const date = new Date(report.generatedAt).toLocaleString();

  if (report.type === 'trip-completion') {
    const s = report.summary;
    const header = `<h1>Trip Completion Report</h1><div class="meta">Scope: ${report.scope} &nbsp;·&nbsp; Generated: ${date} &nbsp;·&nbsp; Radius: ${report.settings.radialDistanceM}m</div>`;
    const cards = summaryCards([
      ['Trips Scheduled', String(s.tripsScheduled)],
      ['Trips with Data', String(s.tripsWithData)],
      ['Total Stops', String(s.totalStops)],
      ['Touched Stops', String(s.touchedStops)],
      ['Avg Completion', fmtPct(s.avgCompletionPct), pctColor(s.avgCompletionPct)],
    ]);
    const rows = report.trips.map(r => {
      const pct = r.completionPct;
      const badge = !r.hasLiveData ? `<span class="badge badge-gray">No data</span>` :
        pct === null ? `<span class="badge badge-gray">—</span>` :
        pct >= 80 ? `<span class="badge badge-green">${fmtPct(pct)}</span>` :
        pct >= 60 ? `<span class="badge badge-yellow">${fmtPct(pct)}</span>` :
        `<span class="badge badge-red">${fmtPct(pct)}</span>`;
      return `<tr><td>${r.tripId}</td><td>${r.headsign ?? '—'}</td><td>${r.routeId ?? '—'}</td><td>${r.touchedStops}/${r.totalStops}</td><td>${badge}</td></tr>`;
    }).join('');
    const table = `<p class="section-title">Trips</p><table><thead><tr><th>Trip ID</th><th>Headsign</th><th>Route</th><th>Stops touched</th><th>Completion</th></tr></thead><tbody>${rows}</tbody></table>`;
    return htmlDoc('Trip Completion Report', header + cards + table);
  }

  if (report.type === 'data-availability') {
    const s = report.summary;
    const fmtGap = (g: number | null) => g === null ? '—' : g < 60 ? `${g}s` : `${(g / 60).toFixed(1)}m`;
    const header = `<h1>Data Availability Report</h1><div class="meta">Scope: ${report.scope} &nbsp;·&nbsp; Generated: ${date} &nbsp;·&nbsp; Expected interval: ${report.settings.expectedIntervalS}s</div>`;
    const cards = summaryCards([
      ['Trips Observed', String(s.tripsObserved)],
      ['Trips with Gaps', String(s.tripsWithGaps), s.tripsWithGaps > 0 ? 'yellow' : 'green'],
      ['Avg Max Gap', fmtGap(s.avgMaxGapS), s.avgMaxGapS && s.avgMaxGapS > report.settings.expectedIntervalS * 2 ? 'red' : 'green'],
      ['Avg Coverage', fmtPct(s.avgCoveragePct), pctColor(s.avgCoveragePct)],
    ]);
    const rows = report.trips.map(r => {
      const gapBadge = r.gapsExceedingThreshold === 0
        ? `<span class="badge badge-green">None</span>`
        : `<span class="badge badge-red">${r.gapsExceedingThreshold}</span>`;
      return `<tr><td>${r.tripId}</td><td>${r.headsign ?? '—'}</td><td>${r.pingCount}</td><td>${fmtUnixTime(r.firstPingTime)}</td><td>${fmtUnixTime(r.lastPingTime)}</td><td>${fmtGap(r.maxGapS)}</td><td>${gapBadge}</td><td><span class="${pctColor(r.coveragePct)}">${fmtPct(r.coveragePct)}</span></td></tr>`;
    }).join('');
    const table = `<p class="section-title">Trips</p><table><thead><tr><th>Trip ID</th><th>Headsign</th><th>Pings</th><th>First ping</th><th>Last ping</th><th>Max gap</th><th>Gaps &gt; threshold</th><th>Coverage</th></tr></thead><tbody>${rows}</tbody></table>`;
    return htmlDoc('Data Availability Report', header + cards + table);
  }

  // punctuality
  const s = report.summary;
  const header = `<h1>Punctuality Report</h1><div class="meta">Scope: ${report.scope} &nbsp;·&nbsp; Generated: ${date} &nbsp;·&nbsp; Radius: ${report.settings.radialDistanceM}m &nbsp;·&nbsp; Buffer: ${report.settings.bufferMinutes}min</div>`;
  const cards = summaryCards([
    ['Trips Scheduled', String(s.tripsScheduled)],
    ['Trips with Data', String(s.tripsWithData)],
    ['On Time', String(s.onTimeStops), 'green'],
    ['Late', String(s.lateStops), s.lateStops > 0 ? 'red' : 'green'],
    ['Early', String(s.earlyStops), s.earlyStops > 0 ? 'blue' : 'green'],
    ['Skipped', String(s.skippedStops), s.skippedStops > 0 ? 'yellow' : 'green'],
    ['Avg On-time', fmtPct(s.avgOnTimePct), pctColor(s.avgOnTimePct)],
  ]);

  const statusBadge = (status: PunctualityStatus, dev: number | null) => {
    switch (status) {
      case 'on-time': return `<span class="badge badge-green">On time${dev !== null ? ` (${fmtSeconds(dev)})` : ''}</span>`;
      case 'late': return `<span class="badge badge-red">Late ${fmtSeconds(dev)}</span>`;
      case 'early': return `<span class="badge badge-blue">Early ${fmtSeconds(dev)}</span>`;
      case 'skipped': return `<span class="badge badge-yellow">Skipped</span>`;
      case 'no-data': return `<span class="badge badge-gray">No data</span>`;
    }
  };

  const tripSections = report.trips.map(r => {
    const tripHeader = `<p class="section-title">${r.tripId}${r.headsign ? ` — ${r.headsign}` : ''} ${r.onTimePct !== null ? `· ${fmtPct(r.onTimePct)} on-time` : '(no data)'}</p>`;
    if (!r.hasLiveData) return tripHeader + `<p style="color:#64748b;font-size:0.8rem">No live data for this trip.</p>`;
    const stopRows = r.stops.map(st =>
      `<tr><td>${st.sequence}</td><td>${st.stopName ?? st.stopId}</td><td>${st.scheduledTime ?? '—'}</td><td>${fmtUnixTime(st.estimatedArrivalTime)}</td><td>${statusBadge(st.status, st.deviationS)}</td></tr>`
    ).join('');
    return tripHeader + `<table><thead><tr><th>#</th><th>Stop</th><th>Scheduled</th><th>Actual</th><th>Status</th></tr></thead><tbody>${stopRows}</tbody></table>`;
  }).join('');

  return htmlDoc('Punctuality Report', header + cards + tripSections);
}

export function openHtmlOrPdf(report: AnyReport, pdf: boolean) {
  const html = generateHtml(report);
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  if (pdf) win.setTimeout(() => win.print(), 600);
}