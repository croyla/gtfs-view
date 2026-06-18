<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Chart from 'chart.js/auto';
  import type { ChartConfiguration } from 'chart.js';
  import type { GtfsData } from '../types';
  import type { VehiclePosition } from '../liveTypes';
  import type { BlockPingData } from '../schedulePings';
  import { haversineKm, parseTimeMin } from '../popupUtils';

  let {
    blockTripIds = [],
    gtfsData,
    pingData = null,
  }: {
    blockTripIds: string[];
    gtfsData: GtfsData;
    pingData?: BlockPingData | null;
  } = $props();

  let showTripSegments = $state(true);
  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  const TRIP_PALETTE = ['#818cf8','#34d399','#fb923c','#f472b6','#38bdf8','#a78bfa','#4ade80','#facc15','#f87171','#2dd4bf'];
  function tripColor(i: number): string { return TRIP_PALETTE[i % TRIP_PALETTE.length]; }

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

  // Pings pre-assigned per trip from BlockPingData
  const liveByTrip = $derived.by(() => {
    const map = new Map<string, VehiclePosition[]>();
    for (const record of pingData?.tripRecords ?? []) {
      const sorted = [...record.pings].sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length > 0) map.set(record.tid, sorted);
    }
    return map;
  });

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

  // Scheduled points per trip (cumulative distance continues across trips)
  const scheduledPointsByTrip = $derived.by(() => {
    const result = new Map<string, { x: number; y: number }[]>();
    let cumDist = 0;
    for (const { tid } of sortedTrips) {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const pts: { x: number; y: number }[] = [];
      let tripCum = 0;
      for (let i = 0; i < sts.length; i++) {
        if (i > 0) {
          const a = gtfsData.stops.get(sts[i - 1].stop_id);
          const b = gtfsData.stops.get(sts[i].stop_id);
          if (a && b) tripCum += haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon);
        }
        pts.push({ x: parseTimeMin(sts[i].departure_time || sts[i].arrival_time), y: cumDist + tripCum });
      }
      result.set(tid, pts);
      cumDist += tripDistKm(tid);
    }
    return result;
  });

  // GPS-measured distance per trip (stop-windowed)
  const blockGpsDists = $derived.by(() => {
    const result = new Map<string, number>();
    for (const { tid } of sortedTrips) {
      const sts    = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const tPings = liveByTrip.get(tid) ?? [];
      let tripTotal = 0;
      for (let i = 0; i < sts.length - 1; i++) {
        const t0 = parseTimeMin(sts[i].departure_time || sts[i].arrival_time);
        const t1 = parseTimeMin(sts[i + 1].arrival_time || sts[i + 1].departure_time);
        const segPings = tPings.filter(p => { const pm = epochToMin(p.timestamp); return pm >= t0 && pm <= t1; });
        if (segPings.length >= 2) {
          for (let j = 1; j < segPings.length; j++)
            tripTotal += haversineKm(segPings[j-1].lat, segPings[j-1].lon, segPings[j].lat, segPings[j].lon);
        } else {
          const stopA = gtfsData.stops.get(sts[i].stop_id);
          const stopB = gtfsData.stops.get(sts[i+1].stop_id);
          if (stopA && stopB) tripTotal += haversineKm(stopA.stop_lat, stopA.stop_lon, stopB.stop_lat, stopB.stop_lon);
        }
      }
      result.set(tid, tripTotal);
    }
    return result;
  });

  // Actual GPS points per trip (cumulative distance continues across trips)
  const actualPointsByTrip = $derived.by(() => {
    const result = new Map<string, { x: number; y: number }[]>();
    let cumDist = 0;
    for (const { tid } of sortedTrips) {
      const sts    = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const tPings = liveByTrip.get(tid) ?? [];
      const pts: { x: number; y: number }[] = [];
      let tripCum = 0;

      for (let i = 0; i < sts.length - 1; i++) {
        const t0 = parseTimeMin(sts[i].departure_time || sts[i].arrival_time);
        const t1 = parseTimeMin(sts[i + 1].arrival_time || sts[i + 1].departure_time);
        const segPings = tPings.filter(p => { const pm = epochToMin(p.timestamp); return pm >= t0 && pm <= t1; });

        if (segPings.length >= 2) {
          let segCum = 0;
          for (let j = 0; j < segPings.length; j++) {
            if (j > 0) segCum += haversineKm(segPings[j-1].lat, segPings[j-1].lon, segPings[j].lat, segPings[j].lon);
            pts.push({ x: epochToMin(segPings[j].timestamp), y: cumDist + tripCum + segCum });
          }
          let segGpsDist = 0;
          for (let j = 1; j < segPings.length; j++)
            segGpsDist += haversineKm(segPings[j-1].lat, segPings[j-1].lon, segPings[j].lat, segPings[j].lon);
          tripCum += segGpsDist;
        } else {
          const stopA = gtfsData.stops.get(sts[i].stop_id);
          const stopB = gtfsData.stops.get(sts[i+1].stop_id);
          const segDist = stopA && stopB ? haversineKm(stopA.stop_lat, stopA.stop_lon, stopB.stop_lat, stopB.stop_lon) : 0;
          pts.push({ x: t0, y: cumDist + tripCum });
          tripCum += segDist;
        }
      }
      if (sts.length > 0) {
        const lastSt = sts[sts.length - 1];
        pts.push({ x: parseTimeMin(lastSt.arrival_time || lastSt.departure_time), y: cumDist + tripCum });
      }

      result.set(tid, pts);
      cumDist += (blockGpsDists.get(tid) ?? tripDistKm(tid));
    }
    return result;
  });

  // Combined arrays for interpolation + axis range
  const allScheduledPts = $derived(
    sortedTrips.flatMap(({ tid }) => scheduledPointsByTrip.get(tid) ?? [])
  );
  const allActualPts = $derived(
    sortedTrips.flatMap(({ tid }) => actualPointsByTrip.get(tid) ?? [])
  );

  // Trip boundary info for segment grid lines
  const tripBoundaries = $derived.by(() => {
    let cumDist = 0;
    return sortedTrips.map(({ tid, firstMin }) => {
      const sts     = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const lastMin = sts.at(-1) ? parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time) : firstMin;
      const dist    = blockGpsDists.get(tid) ?? tripDistKm(tid);
      const b       = { tid, startMin: firstMin, endMin: lastMin, cumDistStart: cumDist, cumDistEnd: cumDist + dist };
      cumDist += dist;
      return b;
    });
  });

  const timeRange = $derived.by(() => {
    const all = [...allScheduledPts, ...allActualPts].map(p => p.x);
    if (all.length === 0) return { lo: 0, hi: 24 * 60 };
    return { lo: Math.max(0, Math.min(...all) - 5), hi: Math.min(30 * 60, Math.max(...all) + 5) };
  });

  const maxY = $derived(Math.max(
    0.001,
    ...allScheduledPts.map(p => p.y),
    ...allActualPts.map(p => p.y),
  ) * 1.05);

  function schedDistAtTime(tMin: number): number | null {
    const pts = allScheduledPts;
    if (pts.length === 0) return null;
    if (tMin <= pts[0].x) return pts[0].y;
    if (tMin >= pts.at(-1)!.x) return pts.at(-1)!.y;
    for (let i = 1; i < pts.length; i++) {
      if (tMin <= pts[i].x) {
        const frac = (tMin - pts[i-1].x) / (pts[i].x - pts[i-1].x);
        return pts[i-1].y + frac * (pts[i].y - pts[i-1].y);
      }
    }
    return null;
  }

  function schedTimeForDist(dist: number): number | null {
    const pts = allScheduledPts;
    if (pts.length === 0) return null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y >= dist && pts[i-1].y <= dist) {
        if (pts[i].y === pts[i-1].y) return pts[i-1].x;
        const frac = (dist - pts[i-1].y) / (pts[i].y - pts[i-1].y);
        return pts[i-1].x + frac * (pts[i].x - pts[i-1].x);
      }
    }
    return null;
  }

  function tripForDist(cumKm: number): { tid: string; localKm: number; totalKm: number } | null {
    for (const b of tripBoundaries) {
      if (cumKm >= b.cumDistStart && cumKm <= b.cumDistEnd + 0.001)
        return { tid: b.tid, localKm: cumKm - b.cumDistStart, totalKm: b.cumDistEnd - b.cumDistStart };
    }
    return null;
  }

  const pluginCfg = { showSegments: true, boundaries: [] as typeof tripBoundaries };

  function buildConfig(): ChartConfiguration {
    // Datasets: [trip0_sched, trip0_actual, trip1_sched, trip1_actual, ...]
    const datasets = sortedTrips.flatMap(({ tid }, i) => {
      const color     = tripColor(i);
      const schedPts  = scheduledPointsByTrip.get(tid) ?? [];
      const actualPts = actualPointsByTrip.get(tid) ?? [];
      return [
        {
          label: `${tid} scheduled`,
          data: schedPts,
          borderColor: color + 'aa',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 0,
          tension: 0,
        },
        {
          label: `${tid} actual`,
          data: actualPts,
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
        },
      ];
    });

    return {
      type: 'line',
      data: { datasets },
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
          legend: { display: false },
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
                const tMin  = item.parsed.x;
                const dist  = item.parsed.y;
                const lbl   = item.dataset.label ?? '';
                const isAct = lbl.endsWith(' actual');

                if (!isAct) {
                  const seg    = tripForDist(dist);
                  const segStr = seg ? `  (${seg.localKm.toFixed(2)} / ${seg.totalKm.toFixed(2)} km)` : '';
                  return `Sched: ${dist.toFixed(2)} km${segStr}`;
                }

                const schedDist = schedDistAtTime(tMin);
                const distDev   = schedDist != null ? dist - schedDist : null;
                const schedTime = schedTimeForDist(dist);
                const timeDev   = schedTime != null ? tMin - schedTime : null;
                const seg       = tripForDist(dist);

                const lines: string[] = [`Actual: ${dist.toFixed(2)} km`];
                if (distDev != null) lines.push(`  vs schedule: ${distDev >= 0 ? '+' : ''}${distDev.toFixed(2)} km`);
                if (timeDev != null) lines.push(`  time dev: ${timeDev >= 0 ? '+' : ''}${Math.round(timeDev)} min`);
                if (seg) lines.push(`  on trip ${seg.tid}: ${seg.localKm.toFixed(2)} / ${seg.totalKm.toFixed(2)} km`);
                return lines;
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
            const ctx = c.ctx;
            const xSc = c.scales['x'];
            const ySc = c.scales['y'];
            if (!xSc || !ySc) return;
            const top = ySc.top, bottom = ySc.bottom;

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

            ctx.save();
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            for (let i = 1; i < pluginCfg.boundaries.length; i++) {
              const x = xSc.getPixelForValue(pluginCfg.boundaries[i].startMin);
              ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.font = '10px system-ui';
            ctx.fillStyle = '#475569';
            ctx.textAlign = 'left';
            for (const b of pluginCfg.boundaries) {
              const x = xSc.getPixelForValue(b.startMin) + 3;
              if (x > xSc.left && x < xSc.right - 20)
                ctx.fillText(b.tid.length > 10 ? b.tid.slice(0, 9) + '…' : b.tid, x, top + 11);
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
    // Update actual dataset for each trip (at index i*2 + 1)
    for (let i = 0; i < sortedTrips.length; i++) {
      const ds = chart.data.datasets[i * 2 + 1];
      if (ds) ds.data = (actualPointsByTrip.get(sortedTrips[i].tid) ?? []) as never;
    }
    (chart.options.scales!.x as { min: number; max: number }).min = timeRange.lo;
    (chart.options.scales!.x as { min: number; max: number }).max = timeRange.hi;
    (chart.options.scales!.y as { max: number }).max = maxY;
    chart.update('none');
  }

  $effect(() => {
    const _trips = sortedTrips; const _sched = allScheduledPts; const _t = timeRange; const _y = maxY;
    const _seg = showTripSegments; const _b = tripBoundaries;
    createChart();
    untrack(() => refreshData());
  });

  $effect(() => {
    const _live = pingData;
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
      Scheduled (dashed) vs. actual GPS distance per stop segment.
    </p>

    <!-- Per-trip colour legend -->
    <div class="flex flex-wrap items-center gap-3 text-[10px]">
      {#each sortedTrips as { tid }, i}
        {@const c = tripColor(i)}
        <span class="flex items-center gap-2" style:color={c}>
          <span class="inline-flex items-center gap-0.5">
            <span class="inline-block h-px w-4 opacity-60" style:background={c} style:border-top="2px dashed {c}"></span>
          </span>
          <span class="inline-block h-px w-3" style:background={c}></span>
          {tid}
        </span>
      {/each}
    </div>

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
    {#if allActualPts.length === 0}
      <p class="text-center text-[11px] text-slate-600">No live position data received yet for this block.</p>
    {/if}
  {/if}
</div>