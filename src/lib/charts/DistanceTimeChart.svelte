<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Chart from 'chart.js/auto';
  import type { ChartConfiguration } from 'chart.js';
  import type { GtfsData } from '../types';
  import type { VehiclePosition } from '../liveTypes';
  import { haversineKm, parseTimeMin } from '../popupUtils';

  let {
    blockTripIds = [],
    gtfsData,
    livePositions = [],
    selectedDate = '',
  }: {
    blockTripIds: string[];
    gtfsData: GtfsData;
    livePositions?: VehiclePosition[];
    selectedDate?: string;
  } = $props();

  let showTripSegments = $state(true);
  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  const tz = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');

  const sortedTrips = $derived.by(() =>
    [...blockTripIds]
      .map(tid => {
        const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
        const firstMin = sts[0] ? parseTimeMin(sts[0].departure_time || sts[0].arrival_time) : Infinity;
        return { tid, firstMin };
      })
      .sort((a, b) => a.firstMin - b.firstMin)
  );

  function tripDistKm(tid: string): number {
    const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
    let d = 0;
    for (let i = 1; i < sts.length; i++) {
      const a = gtfsData.stops.get(sts[i - 1].stop_id);
      const b = gtfsData.stops.get(sts[i].stop_id);
      if (a && b) d += haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon);
    }
    return d;
  }

  // Scheduled cumulative distance over the whole block day
  const scheduledPoints = $derived.by(() => {
    const pts: { x: number; y: number }[] = [];
    let cumDist = 0;
    for (const { tid } of sortedTrips) {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      let tripCum = 0;
      for (let i = 0; i < sts.length; i++) {
        if (i > 0) {
          const a = gtfsData.stops.get(sts[i - 1].stop_id);
          const b = gtfsData.stops.get(sts[i].stop_id);
          if (a && b) tripCum += haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon);
        }
        pts.push({ x: parseTimeMin(sts[i].departure_time || sts[i].arrival_time), y: cumDist + tripCum });
      }
      cumDist += tripDistKm(tid);
    }
    return pts;
  });

  // Trip boundary info for segment grid lines and tooltips
  const tripBoundaries = $derived.by(() => {
    let cumDist = 0;
    return sortedTrips.map(({ tid, firstMin }) => {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const lastMin = sts.at(-1) ? parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time) : firstMin;
      const dist = tripDistKm(tid);
      const boundary = { tid, startMin: firstMin, endMin: lastMin, cumDistStart: cumDist, cumDistEnd: cumDist + dist };
      cumDist += dist;
      return boundary;
    });
  });

  const blockSet = $derived(new Set(blockTripIds));

  const sortedLive = $derived(
    [...livePositions.filter(p => p.trip_id && blockSet.has(p.trip_id))]
      .sort((a, b) => a.timestamp - b.timestamp)
  );

  function epochToMin(epoch: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(epoch * 1000));
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0');
    const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
    const s = parseInt(parts.find(p => p.type === 'second')?.value ?? '0');
    return h * 60 + m + s / 60;
  }

  function fmtMin(min: number): string {
    const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function localMidnightEpoch(date: string, timezone: string): number {
    if (date.length !== 8) return 0;
    const y = date.slice(0, 4), mo = date.slice(4, 6), d = date.slice(6, 8);
    const noonUtcMs = Date.parse(`${y}-${mo}-${d}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(noonUtcMs));
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '12');
    const mi = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
    const s = parseInt(parts.find(p => p.type === 'second')?.value ?? '0');
    return (noonUtcMs - (h * 3600 + mi * 60 + s) * 1000) / 1000;
  }

  const actualPoints = $derived.by(() => {
    const positions = sortedLive;
    if (positions.length === 0) return [];
    let cum = 0;
    return positions.map((p, i) => {
      if (i > 0) cum += haversineKm(positions[i - 1].lat, positions[i - 1].lon, p.lat, p.lon);
      return { x: epochToMin(p.timestamp), y: cum };
    });
  });

  const adjustedPoints = $derived.by(() => {
    const positions = sortedLive;
    if (positions.length === 0) return [];
    const midnight = localMidnightEpoch(selectedDate, tz);

    let cumSched = 0;
    const tripStarts = sortedTrips.map(({ tid }) => {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const firstMin = sts[0] ? parseTimeMin(sts[0].departure_time || sts[0].arrival_time) : 0;
      const firstStopId = sts[0]?.stop_id ?? '';
      const start = { firstStopId, schedEpoch: midnight + firstMin * 60, schedCumDist: cumSched };
      cumSched += tripDistKm(tid);
      return start;
    });

    let cumActual = 0;
    let offset = 0;
    const pending = [...tripStarts];
    const result: { x: number; y: number }[] = [];

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      if (i > 0) cumActual += haversineKm(positions[i - 1].lat, positions[i - 1].lon, pos.lat, pos.lon);

      while (pending.length > 0) {
        const next = pending[0];
        const timeDiff = pos.timestamp - next.schedEpoch;
        const firstStop = gtfsData.stops.get(next.firstStopId);
        const spatialKm = firstStop
          ? haversineKm(firstStop.stop_lat, firstStop.stop_lon, pos.lat, pos.lon)
          : Infinity;
        if (timeDiff >= -3 * 60 && timeDiff <= 8 * 60 && spatialKm < 0.3) {
          offset = next.schedCumDist - cumActual;
          pending.shift();
          break;
        } else if (timeDiff > 15 * 60) {
          pending.shift();
        } else {
          break;
        }
      }
      result.push({ x: epochToMin(pos.timestamp), y: cumActual + offset });
    }
    return result;
  });

  const timeRange = $derived.by(() => {
    const all = [...scheduledPoints, ...actualPoints].map(p => p.x);
    if (all.length === 0) return { lo: 0, hi: 24 * 60 };
    return { lo: Math.max(0, Math.min(...all) - 5), hi: Math.min(30 * 60, Math.max(...all) + 5) };
  });

  const maxY = $derived(Math.max(
    0.001,
    ...scheduledPoints.map(p => p.y),
    ...actualPoints.map(p => p.y),
    ...adjustedPoints.map(p => p.y),
  ) * 1.05);

  // Interpolate the scheduled cumulative distance at a given time (minutes)
  function schedDistAtTime(tMin: number): number | null {
    const pts = scheduledPoints;
    if (pts.length === 0) return null;
    if (tMin <= pts[0].x) return pts[0].y;
    if (tMin >= pts.at(-1)!.x) return pts.at(-1)!.y;
    for (let i = 1; i < pts.length; i++) {
      if (tMin <= pts[i].x) {
        const frac = (tMin - pts[i - 1].x) / (pts[i].x - pts[i - 1].x);
        return pts[i - 1].y + frac * (pts[i].y - pts[i - 1].y);
      }
    }
    return null;
  }

  // Find the scheduled time (minutes) at which a given cumulative distance is reached
  function schedTimeForDist(dist: number): number | null {
    const pts = scheduledPoints;
    if (pts.length === 0) return null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y >= dist && pts[i - 1].y <= dist) {
        if (pts[i].y === pts[i - 1].y) return pts[i - 1].x;
        const frac = (dist - pts[i - 1].y) / (pts[i].y - pts[i - 1].y);
        return pts[i - 1].x + frac * (pts[i].x - pts[i - 1].x);
      }
    }
    return null;
  }

  // Which trip segment does a cumulative distance belong to?
  function tripForDist(cumKm: number): { tid: string; localKm: number; totalKm: number } | null {
    for (const b of tripBoundaries) {
      if (cumKm >= b.cumDistStart && cumKm <= b.cumDistEnd + 0.001) {
        return { tid: b.tid, localKm: cumKm - b.cumDistStart, totalKm: b.cumDistEnd - b.cumDistStart };
      }
    }
    return null;
  }

  // Mutable config for the custom plugin (avoids stale closures)
  const pluginCfg = { showSegments: true, boundaries: [] as typeof tripBoundaries };

  function buildConfig(): ChartConfiguration {
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Scheduled',
            data: scheduledPoints,
            borderColor: '#6366f1',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0,
          },
          {
            label: 'Actual',
            data: actualPoints,
            borderColor: '#34d399',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0,
          },
          {
            label: 'Adjusted',
            data: adjustedPoints,
            borderColor: '#f59e0b',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: 'linear',
            min: timeRange.lo,
            max: timeRange.hi,
            grid: { color: '#1e293b' },
            ticks: {
              color: '#64748b',
              stepSize: 30,
              callback(v) {
                const val = Number(v);
                if (val % 30 !== 0) return '';
                return fmtMin(val);
              },
            },
            border: { color: '#334155' },
            title: { display: true, text: 'Time of day', color: '#475569', font: { size: 11 } },
          },
          y: {
            type: 'linear',
            min: 0,
            max: maxY,
            grid: { color: '#1e293b' },
            ticks: {
              color: '#94a3b8',
              callback(v) { return `${Number(v).toFixed(1)} km`; },
            },
            border: { color: '#334155' },
            title: { display: true, text: 'Cumulative distance (km)', color: '#475569', font: { size: 11 } },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top' as const,
            align: 'end' as const,
            labels: {
              color: '#94a3b8',
              boxWidth: 20,
              boxHeight: 2,
              font: { size: 11 },
              padding: 16,
              usePointStyle: false,
            },
          },
          tooltip: {
            mode: 'index' as const,
            intersect: false,
            backgroundColor: '#1e293b',
            borderColor: '#475569',
            borderWidth: 1,
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            callbacks: {
              title(items) {
                const t = items[0]?.parsed.x;
                return t != null ? `Time: ${fmtMin(t)}` : '';
              },
              label(item) {
                const tMin = item.parsed.x;
                const dist  = item.parsed.y;
                const label = item.dataset.label ?? '';

                if (label === 'Scheduled') {
                  const seg = tripForDist(dist);
                  const segStr = seg ? `  (trip ${seg.tid}: ${seg.localKm.toFixed(2)} / ${seg.totalKm.toFixed(2)} km)` : '';
                  return `Scheduled: ${dist.toFixed(2)} km${segStr}`;
                }

                if (label === 'Actual' || label === 'Adjusted') {
                  const schedDist = schedDistAtTime(tMin);
                  const distDev   = schedDist != null ? dist - schedDist : null;

                  // Time deviation: when was this distance scheduled to be reached?
                  const schedTime = schedTimeForDist(dist);
                  const timeDev   = schedTime != null ? tMin - schedTime : null;

                  const seg = tripForDist(dist);
                  const localKm = seg ? seg.localKm : null;
                  const totalKm = seg ? seg.totalKm : null;

                  const lines: string[] = [];
                  lines.push(`${label}: ${dist.toFixed(2)} km`);
                  if (distDev != null) {
                    const sign = distDev >= 0 ? '+' : '';
                    lines.push(`  vs schedule: ${sign}${distDev.toFixed(2)} km`);
                  }
                  if (timeDev != null) {
                    const sign = timeDev >= 0 ? '+' : '';
                    lines.push(`  time dev: ${sign}${Math.round(timeDev)} min`);
                  }
                  if (localKm != null && totalKm != null && seg) {
                    lines.push(`  on trip ${seg.tid}: ${localKm.toFixed(2)} / ${totalKm.toFixed(2)} km`);
                  }
                  return lines;
                }

                return `${label}: ${dist.toFixed(2)} km`;
              },
            },
          },
        },
      },
      plugins: [
        {
          id: 'darkBg',
          beforeDraw(c) {
            c.ctx.fillStyle = '#0f172a';
            c.ctx.fillRect(0, 0, c.width, c.height);
          },
        },
        {
          id: 'tripSegments',
          beforeDraw(c) {
            if (!pluginCfg.showSegments || pluginCfg.boundaries.length === 0) return;
            const ctx  = c.ctx;
            const xSc  = c.scales['x'];
            const ySc  = c.scales['y'];
            if (!xSc || !ySc) return;
            const top    = ySc.top;
            const bottom = ySc.bottom;

            // Alternating shaded bands
            pluginCfg.boundaries.forEach((b, i) => {
              const x1 = xSc.getPixelForValue(b.startMin);
              const x2 = xSc.getPixelForValue(b.endMin);
              if (i % 2 === 1) {
                ctx.save();
                ctx.fillStyle = 'rgba(99,102,241,0.04)';
                ctx.fillRect(x1, top, x2 - x1, bottom - top);
                ctx.restore();
              }
            });

            // Vertical lines at trip boundaries (skip first)
            ctx.save();
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            for (let i = 1; i < pluginCfg.boundaries.length; i++) {
              const x = xSc.getPixelForValue(pluginCfg.boundaries[i].startMin);
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, bottom);
              ctx.stroke();
            }
            // Labels at top of each band
            ctx.setLineDash([]);
            ctx.font = '10px system-ui';
            ctx.fillStyle = '#475569';
            ctx.textAlign = 'left';
            for (const b of pluginCfg.boundaries) {
              const x = xSc.getPixelForValue(b.startMin) + 3;
              if (x > xSc.left && x < xSc.right - 20) {
                ctx.fillText(b.tid.length > 10 ? b.tid.slice(0, 9) + '…' : b.tid, x, top + 11);
              }
            }
            ctx.restore();
          },
        },
      ],
    };
  }

  function createChart() {
    if (!canvas) return;
    pluginCfg.boundaries  = tripBoundaries;
    pluginCfg.showSegments = showTripSegments;
    chart?.destroy();
    chart = new Chart(canvas, buildConfig());
  }

  function refreshData() {
    if (!chart) return;
    pluginCfg.boundaries   = tripBoundaries;
    pluginCfg.showSegments = showTripSegments;
    chart.data.datasets[1].data = actualPoints   as never;
    chart.data.datasets[2].data = adjustedPoints as never;
    (chart.options.scales!.x as { min: number; max: number }).min = timeRange.lo;
    (chart.options.scales!.x as { min: number; max: number }).max = timeRange.hi;
    (chart.options.scales!.y as { max: number }).max = maxY;
    chart.update('none');
  }

  // Recreate when scheduled structure changes
  $effect(() => {
    const _trips = sortedTrips; const _sched = scheduledPoints; const _t = timeRange; const _y = maxY;
    const _seg = showTripSegments; const _b = tripBoundaries;
    createChart();
    untrack(() => refreshData());
  });

  // Lightweight update for live positions
  $effect(() => {
    const _live = livePositions;
    untrack(() => refreshData());
  });

  onDestroy(() => chart?.destroy());

  function exportPng() {
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'distance-time.png';
    a.click();
  }
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center gap-4">
    <p class="text-xs text-slate-500 flex-1">
      Scheduled vs. actual GPS distance. Adjusted line resets to schedule at each detected trip start.
    </p>

    <label class="flex cursor-pointer items-center gap-2">
      <input type="checkbox" class="h-3 w-3 accent-indigo-500" bind:checked={showTripSegments} />
      <span class="text-xs text-slate-400">Trip segments</span>
    </label>

    <button
      onclick={exportPng}
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400
             hover:border-slate-500 hover:text-slate-200 transition-colors"
    >
      <svg class="h-3 w-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2 10.5v1.75A1.75 1.75 0 003.75 14h8.5A1.75 1.75 0 0014 12.25V10.5M8 2v8m-3-3l3 3 3-3"/>
      </svg>
      Export PNG
    </button>
  </div>

  {#if sortedTrips.length === 0}
    <div class="flex h-40 items-center justify-center text-sm text-slate-500">No trip data for this block.</div>
  {:else}
    <div class="h-[350px]">
      <canvas bind:this={canvas}></canvas>
    </div>
    {#if actualPoints.length === 0}
      <p class="text-center text-[11px] text-slate-600">No live position data received yet for this block.</p>
    {/if}
  {/if}
</div>