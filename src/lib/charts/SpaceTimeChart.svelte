<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Chart from 'chart.js/auto';
  import type { Scale, ChartConfiguration } from 'chart.js';
  import type { GtfsData } from '../types';
  import type { VehiclePosition } from '../liveTypes';
  import { haversineKm, parseTimeMin } from '../popupUtils';

  let {
    blockTripIds = [],
    gtfsData,
    livePositions = [],
  }: {
    blockTripIds: string[];
    gtfsData: GtfsData;
    livePositions?: VehiclePosition[];
  } = $props();

  let showStops = $state(true);
  let selectedPairKey = $state('');
  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  const tz = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');

  // Canonical stop order: longest trip among the currently visible (termini-filtered) trips
  const canonicalStops = $derived.by(() => {
    const source = visibleTripIds.length > 0 ? visibleTripIds : blockTripIds;
    if (source.length === 0) return [];
    let bestId = source[0], bestLen = 0;
    for (const tid of source) {
      const n = (gtfsData.stopTimesByTrip.get(tid) ?? []).length;
      if (n > bestLen) { bestLen = n; bestId = tid; }
    }
    const sts = gtfsData.stopTimesByTrip.get(bestId) ?? [];
    const result: { stop_id: string; stop_name: string; cumDistKm: number }[] = [];
    let cum = 0;
    for (let i = 0; i < sts.length; i++) {
      if (i > 0) {
        const a = gtfsData.stops.get(sts[i - 1].stop_id);
        const b = gtfsData.stops.get(sts[i].stop_id);
        if (a && b) cum += haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon);
      }
      const s = gtfsData.stops.get(sts[i].stop_id);
      result.push({ stop_id: sts[i].stop_id, stop_name: s?.stop_name ?? sts[i].stop_id, cumDistKm: cum });
    }
    return result;
  });

  const stopDistMap = $derived(new Map(canonicalStops.map(s => [s.stop_id, s.cumDistKm])));
  const maxDist     = $derived(Math.max(0.001, canonicalStops.at(-1)?.cumDistKm ?? 0.001));

  const terminaPairs = $derived.by(() => {
    const seen = new Set<string>();
    const result: { key: string; label: string }[] = [];
    for (const tid of blockTripIds) {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      if (sts.length < 2) continue;
      const a = sts[0].stop_id, b = sts.at(-1)!.stop_id;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const na = gtfsData.stops.get(a)?.stop_name ?? a;
      const nb = gtfsData.stops.get(b)?.stop_name ?? b;
      result.push({ key, label: `${na} ↔ ${nb}` });
    }
    return result;
  });

  $effect(() => {
    if (terminaPairs.length > 0 && !terminaPairs.find(p => p.key === selectedPairKey))
      selectedPairKey = terminaPairs[0].key;
  });

  const visibleTripIds = $derived.by(() => {
    if (terminaPairs.length <= 1) return blockTripIds;
    const [aF, bF] = selectedPairKey.split('|');
    return blockTripIds.filter(tid => {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      if (sts.length < 2) return false;
      const first = sts[0].stop_id, last = sts.at(-1)!.stop_id;
      return (first === aF && last === bF) || (first === bF && last === aF);
    });
  });

  const timeRange = $derived.by(() => {
    let lo = Infinity, hi = -Infinity;
    for (const tid of visibleTripIds) {
      for (const st of gtfsData.stopTimesByTrip.get(tid) ?? []) {
        const t = parseTimeMin(st.departure_time || st.arrival_time);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    }
    if (!isFinite(lo)) return { lo: 0, hi: 24 * 60 };
    return { lo: Math.max(0, lo - 10), hi: Math.min(30 * 60, hi + 10) };
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

  // Per-dot metadata, referenced by the tooltip callback via index
  interface LiveDot { x: number; y: number; vehicleId: string; stopName: string; schedMin: number | null; tripId: string | null }
  let liveDotCache: LiveDot[] = [];

  // Mutable ref read by Chart.js callbacks — avoids stale closures
  const cfg = {
    showStops: true,
    stops: [] as typeof canonicalStops,
    maxDist: 0.001,
    tripDatasetCount: 0, // how many leading datasets are trip lines
  };

  function buildConfig(): ChartConfiguration {
    const tripDatasets = visibleTripIds.map(tid => ({
      type: 'line' as const,
      label: `Trip ${tid}`,
      data: (gtfsData.stopTimesByTrip.get(tid) ?? [])
        .map(st => {
          const d = stopDistMap.get(st.stop_id);
          return d !== undefined
            ? { x: parseTimeMin(st.departure_time || st.arrival_time), y: d }
            : null;
        })
        .filter((p): p is { x: number; y: number } => p !== null),
      borderColor: '#6366f1',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      showLine: true,
      tension: 0,
    }));

    cfg.tripDatasetCount = tripDatasets.length;

    return {
      type: 'scatter',
      data: {
        datasets: [
          ...tripDatasets,
          {
            type: 'scatter' as const,
            label: 'Live positions',
            data: [],
            backgroundColor: '#34d399',
            pointRadius: 4,
            pointHoverRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
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
                if (val % 60 !== 0 && val % 30 !== 0) return '';
                return fmtMin(val);
              },
            },
            border: { color: '#334155' },
            title: { display: true, text: 'Time of day', color: '#475569', font: { size: 11 } },
          },
          y: {
            type: 'linear',
            min: 0,
            max: cfg.maxDist,
            reverse: false,
            afterBuildTicks(scale: Scale) {
              scale.ticks = cfg.stops.map(s => ({ value: s.cumDistKm }));
            },
            grid: {
              color(ctx) {
                const v = ctx.tick?.value;
                if (v === undefined) return '#1e293b';
                const stop = cfg.stops.find(s => Math.abs(s.cumDistKm - v) < 0.001);
                if (!stop) return 'transparent';
                const isTerm = stop === cfg.stops[0] || stop === cfg.stops.at(-1);
                return (!cfg.showStops && !isTerm) ? 'transparent' : '#1e293b';
              },
            },
            ticks: {
              color: '#94a3b8',
              font: { size: 10 },
              callback(v) {
                const stop = cfg.stops.find(s => Math.abs(s.cumDistKm - Number(v)) < 0.001);
                if (!stop) return '';
                const isTerm = stop === cfg.stops[0] || stop === cfg.stops.at(-1);
                if (!cfg.showStops && !isTerm) return '';
                const name = stop.stop_name;
                return name.length > 22 ? name.slice(0, 21) + '…' : name;
              },
            },
            border: { color: '#334155' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            borderColor: '#475569',
            borderWidth: 1,
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            callbacks: {
              title(items) {
                const t = items[0]?.parsed.x;
                return t != null ? fmtMin(t) : '';
              },
              label(item) {
                const km = item.parsed.y;
                const dsIdx = item.datasetIndex;

                // Trip line dataset — show stop name + scheduled time
                if (dsIdx < cfg.tripDatasetCount) {
                  const stop = cfg.stops.find(s => Math.abs(s.cumDistKm - km) < 0.05);
                  const stopLabel = stop ? stop.stop_name : `${km.toFixed(2)} km`;
                  return `${stopLabel}  ·  ${fmtMin(item.parsed.x)}`;
                }

                // Live scatter dataset
                const dot = liveDotCache[item.dataIndex];
                if (!dot) return `${km.toFixed(2)} km`;
                const lines: string[] = [];
                lines.push(`Vehicle ${dot.vehicleId}`);
                lines.push(`Near: ${dot.stopName || `${km.toFixed(2)} km`}`);
                lines.push(`Actual time: ${fmtMin(dot.x)}`);
                if (dot.schedMin !== null) {
                  const dev = Math.round(dot.x - dot.schedMin);
                  const sign = dev >= 0 ? '+' : '';
                  lines.push(`Scheduled: ${fmtMin(dot.schedMin)}  (${sign}${dev} min)`);
                }
                return lines;
              },
            },
          },
        },
      },
      plugins: [{
        id: 'darkBg',
        beforeDraw(c) {
          c.ctx.fillStyle = '#0f172a';
          c.ctx.fillRect(0, 0, c.width, c.height);
        },
      }],
    };
  }

  function computeLiveDots(): LiveDot[] {
    const visible = new Set(visibleTripIds);
    return livePositions
      .filter(p => p.trip_id && visible.has(p.trip_id))
      .map(p => {
        const tMin = epochToMin(p.timestamp);
        let minD = Infinity, km = 0;
        let snappedStop: typeof canonicalStops[0] | null = null;
        for (const s of cfg.stops) {
          const stop = gtfsData.stops.get(s.stop_id);
          if (!stop) continue;
          const d = haversineKm(stop.stop_lat, stop.stop_lon, p.lat, p.lon);
          if (d < minD) { minD = d; km = s.cumDistKm; snappedStop = s; }
        }
        // Find scheduled time for the snapped stop on this trip
        let schedMin: number | null = null;
        if (snappedStop && p.trip_id) {
          const sts = gtfsData.stopTimesByTrip.get(p.trip_id) ?? [];
          const st = sts.find(s => s.stop_id === snappedStop!.stop_id);
          if (st) schedMin = parseTimeMin(st.arrival_time || st.departure_time);
        }
        return { x: tMin, y: km, vehicleId: p.vehicle_id, stopName: snappedStop?.stop_name ?? '', schedMin, tripId: p.trip_id };
      });
  }

  function updateLiveData() {
    if (!chart) return;
    const liveDs = chart.data.datasets.find(d => d.label === 'Live positions');
    if (liveDs) {
      liveDotCache = computeLiveDots();
      (liveDs as { data: unknown[] }).data = liveDotCache;
      chart.update('none');
    }
  }

  $effect(() => {
    const _v = visibleTripIds; const _s = showStops; const _c = canonicalStops; const _t = timeRange;
    cfg.stops    = canonicalStops;
    cfg.maxDist  = maxDist;
    cfg.showStops = showStops;
    if (!canvas) return;
    chart?.destroy();
    chart = new Chart(canvas, buildConfig());
    untrack(() => updateLiveData());
  });

  $effect(() => {
    const _l = livePositions;
    untrack(() => updateLiveData());
  });

  onDestroy(() => chart?.destroy());

  function exportPng() {
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'space-time.png';
    a.click();
  }
</script>

<div class="space-y-3">
  <!-- Controls bar -->
  <div class="flex flex-wrap items-center gap-3">
    {#if terminaPairs.length > 1}
      <div class="flex items-center gap-2">
        <span class="text-xs text-slate-500 shrink-0">Termini pair</span>
        <select
          class="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none"
          bind:value={selectedPairKey}
        >
          {#each terminaPairs as p (p.key)}
            <option value={p.key}>{p.label}</option>
          {/each}
        </select>
      </div>
    {/if}

    <label class="flex cursor-pointer items-center gap-2">
      <input type="checkbox" class="h-3 w-3 accent-indigo-500" bind:checked={showStops} />
      <span class="text-xs text-slate-400">Show stops</span>
    </label>

    <div class="ml-auto flex items-center gap-4 text-[10px] text-slate-500">
      <span class="flex items-center gap-1.5">
        <span class="h-px w-6 bg-indigo-400 inline-block"></span>Scheduled
      </span>
      <span class="flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full bg-emerald-400 inline-block"></span>Live
      </span>
    </div>

    <button
      onclick={exportPng}
      class="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400
             hover:border-slate-500 hover:text-slate-200 transition-colors"
    >
      <svg class="h-3 w-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2 10.5v1.75A1.75 1.75 0 003.75 14h8.5A1.75 1.75 0 0014 12.25V10.5M8 2v8m-3-3l3 3 3-3"/>
      </svg>
      Export PNG
    </button>
  </div>

  {#if canonicalStops.length === 0}
    <div class="flex h-48 items-center justify-center text-sm text-slate-500">No stop data for this block.</div>
  {:else}
    <div class="h-[450px]">
      <canvas bind:this={canvas}></canvas>
    </div>
  {/if}
</div>