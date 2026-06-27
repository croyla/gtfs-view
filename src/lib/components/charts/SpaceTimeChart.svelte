<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Chart from 'chart.js/auto';
  import type { Scale, ChartConfiguration } from 'chart.js';
  import type { GtfsData } from '../../types/types';
  import type { VehiclePosition } from '../../types/liveTypes';
  import type { BlockPingData } from '../../services/schedule/schedulePings';
  import { haversineKm, parseTimeMin } from '../../services/popupUtils';

  let {
    blockTripIds = [],
    gtfsData,
    pingData = null,
    onPingSelect = undefined,
  }: {
    blockTripIds: string[];
    gtfsData: GtfsData;
    pingData?: BlockPingData | null;
    onPingSelect?: (ping: VehiclePosition) => void;
  } = $props();

  let showStops = $state(true);
  let selectedPairKey = $state('');
  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  const TRIP_PALETTE = ['#818cf8','#34d399','#fb923c','#f472b6','#38bdf8','#a78bfa','#4ade80','#facc15','#f87171','#2dd4bf'];
  function tripColor(blockIdx: number): string { return TRIP_PALETTE[blockIdx % TRIP_PALETTE.length]; }

  const tz = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');
  const pingDataByTid = $derived(new Map((pingData?.tripRecords ?? []).map(r => [r.tid, r])));

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

  interface LiveDot {
    x: number; y: number;
    vehicleId: string; stopName: string; tripId: string;
    schedMin: number | null;
    stopIndex: number;
    totalStops: number;
    distFromStopM: number;
    rawPing: VehiclePosition;
  }

  interface StopMeta { stopName: string; schedMin: number; stopIndex: number; totalStops: number }

  // Mutable ref read by Chart.js callbacks — avoids stale closures
  const cfg = {
    showStops:        true,
    stops:            [] as typeof canonicalStops,
    maxDist:          0.001,
    tripDatasetCount: 0,
    tripDatasetStops: [] as StopMeta[][],
    liveDotsByTrip:   [] as LiveDot[][],  // [tripRelIdx][dotIdx]
    onPingSelect:     undefined as ((ping: VehiclePosition) => void) | undefined,
  };

  function buildConfig(): ChartConfiguration {
    cfg.tripDatasetStops = [];

    const tripDatasets = visibleTripIds.map((tid, _) => {
      const color   = tripColor(blockTripIds.indexOf(tid));
      const sts     = gtfsData.stopTimesByTrip.get(tid) ?? [];
      const total   = sts.length;
      const stopMeta: StopMeta[] = [];
      const data = sts
        .map((st, i) => {
          const d = stopDistMap.get(st.stop_id);
          if (d === undefined) return null;
          stopMeta.push({
            stopName:   gtfsData.stops.get(st.stop_id)?.stop_name ?? st.stop_id,
            schedMin:   parseTimeMin(st.departure_time || st.arrival_time),
            stopIndex:  i + 1,
            totalStops: total,
          });
          return { x: parseTimeMin(st.departure_time || st.arrival_time), y: d };
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      cfg.tripDatasetStops.push(stopMeta);
      return {
        type: 'line' as const,
        label: `Trip ${tid}`,
        data,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        showLine: true,
        tension: 0,
      };
    });

    cfg.tripDatasetCount = tripDatasets.length;

    // One scatter dataset per trip so dots share the trip's color
    const liveDatasets = visibleTripIds.map((tid, _) => {
      const color = tripColor(blockTripIds.indexOf(tid));
      return {
        type: 'scatter' as const,
        label: `Live ${tid}`,
        data: [] as { x: number; y: number }[],
        backgroundColor: color,
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    });

    return {
      type: 'scatter',
      data: { datasets: [...tripDatasets, ...liveDatasets] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick(_event, elements) {
          if (!cfg.onPingSelect) return;
          const liveEl = elements.find(el => el.datasetIndex >= cfg.tripDatasetCount);
          if (!liveEl) return;
          const tripRelIdx = liveEl.datasetIndex - cfg.tripDatasetCount;
          const dot = cfg.liveDotsByTrip[tripRelIdx]?.[liveEl.index];
          if (dot) cfg.onPingSelect(dot.rawPing);
        },
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
            backgroundColor: '#0f172a',
            borderColor: '#334155',
            borderWidth: 1,
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            padding: 10,
            callbacks: {
              title(items) {
                const t = items[0]?.parsed.x;
                return t != null ? `⏱  ${fmtMin(t)}` : '';
              },
              label(item) {
                const km    = item.parsed.y;
                const dsIdx = item.datasetIndex;

                // Scheduled trip line
                if (dsIdx < cfg.tripDatasetCount) {
                  const meta = cfg.tripDatasetStops[dsIdx]?.[item.dataIndex];
                  if (meta) {
                    return [
                      `${meta.stopName}`,
                      `Stop ${meta.stopIndex}/${meta.totalStops}  ·  ${km.toFixed(2)} km  ·  ${fmtMin(meta.schedMin)}`,
                    ];
                  }
                  return `${km.toFixed(2)} km`;
                }

                // Live scatter dot
                const tripRelIdx = dsIdx - cfg.tripDatasetCount;
                const dot = cfg.liveDotsByTrip[tripRelIdx]?.[item.dataIndex];
                if (!dot) return `${km.toFixed(2)} km`;

                const lines: string[] = [];
                lines.push(`Vehicle  ${dot.vehicleId}`);

                if (dot.stopName) {
                  const distStr = dot.distFromStopM < 1000
                    ? `${Math.round(dot.distFromStopM)} m`
                    : `${(dot.distFromStopM / 1000).toFixed(1)} km`;
                  lines.push(`Near  ${dot.stopName}  (${distStr})`);
                  lines.push(`Stop ${dot.stopIndex}/${dot.totalStops}`);
                }

                lines.push(`Actual    ${fmtMin(dot.x)}`);

                if (dot.schedMin !== null) {
                  const devMin = dot.x - dot.schedMin;
                  const devRnd = Math.round(devMin);
                  const sign   = devRnd >= 0 ? '+' : '';
                  const label  = Math.abs(devRnd) <= 1
                    ? 'on time'
                    : devRnd > 0
                      ? `${sign}${devRnd} min  —  late`
                      : `${devRnd} min  —  early`;
                  lines.push(`Scheduled ${fmtMin(dot.schedMin)}`);
                  lines.push(`Deviation  ${label}`);
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

  function computeLiveDots(): LiveDot[][] {
    return visibleTripIds.map(tid => {
      const record = pingDataByTid.get(tid);
      const pings  = record?.pings ?? [];

      return pings.map(p => {
        const tMin = epochToMin(p.timestamp);

        // Find closest stop in canonical list
        let closestIdx = -1, closestDist = Infinity;
        for (let i = 0; i < cfg.stops.length; i++) {
          const s    = cfg.stops[i];
          const stop = gtfsData.stops.get(s.stop_id);
          if (!stop) continue;
          const d = haversineKm(stop.stop_lat, stop.stop_lon, p.lat, p.lon);
          if (d < closestDist) { closestDist = d; closestIdx = i; }
        }

        let km = closestIdx >= 0 ? cfg.stops[closestIdx].cumDistKm : 0;
        const snappedStop = closestIdx >= 0 ? cfg.stops[closestIdx] : null;

        // Interpolate km between closest stop and nearest neighbor
        if (closestIdx >= 0) {
          const candidates: number[] = [];
          if (closestIdx - 1 >= 0) candidates.push(closestIdx - 1);
          if (closestIdx + 1 < cfg.stops.length) candidates.push(closestIdx + 1);

          let neighborIdx = -1, neighborDist = Infinity;
          for (const ni of candidates) {
            const ns    = cfg.stops[ni];
            const nStop = gtfsData.stops.get(ns.stop_id);
            if (!nStop) continue;
            const nd = haversineKm(nStop.stop_lat, nStop.stop_lon, p.lat, p.lon);
            if (nd < neighborDist) { neighborDist = nd; neighborIdx = ni; }
          }

          if (neighborIdx >= 0 && (closestDist + neighborDist) > 0) {
            km = (cfg.stops[closestIdx].cumDistKm * neighborDist + cfg.stops[neighborIdx].cumDistKm * closestDist)
              / (closestDist + neighborDist);
          }
        }

        let schedMin: number | null = null;
        let stopIndex = 0, totalStops = 0;
        if (snappedStop) {
          const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
          totalStops = sts.length;
          const idx  = sts.findIndex(s => s.stop_id === snappedStop.stop_id);
          if (idx !== -1) {
            stopIndex = idx + 1;
            schedMin  = parseTimeMin(sts[idx].arrival_time || sts[idx].departure_time);
          }
        }

        return {
          x: tMin, y: km,
          vehicleId:     p.vehicle_id ?? '',
          stopName:      snappedStop?.stop_name ?? '',
          tripId:        tid,
          schedMin,
          stopIndex,
          totalStops,
          distFromStopM: isFinite(closestDist) ? closestDist * 1000 : 0,
          rawPing:       p,
        };
      });
    });
  }

  function updateLiveData() {
    if (!chart) return;
    cfg.liveDotsByTrip = computeLiveDots();
    for (let i = 0; i < visibleTripIds.length; i++) {
      const ds = chart.data.datasets[cfg.tripDatasetCount + i];
      if (ds) (ds as { data: unknown[] }).data = cfg.liveDotsByTrip[i];
    }
    chart.update('none');
  }

  $effect(() => {
    const _v = visibleTripIds; const _s = showStops; const _c = canonicalStops; const _t = timeRange;
    cfg.stops       = canonicalStops;
    cfg.maxDist     = maxDist;
    cfg.showStops   = showStops;
    cfg.onPingSelect = onPingSelect;
    if (!canvas) return;
    chart?.destroy();
    chart = new Chart(canvas, buildConfig());
    untrack(() => updateLiveData());
  });

  $effect(() => {
    cfg.onPingSelect = onPingSelect;
    if (canvas) canvas.style.cursor = onPingSelect ? 'crosshair' : 'default';
  });

  $effect(() => {
    const _p = pingData;
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

    <!-- Per-trip colour legend -->
    <div class="ml-auto flex flex-wrap items-center gap-3 text-[10px]">
      {#each visibleTripIds as tid}
        {@const c = tripColor(blockTripIds.indexOf(tid))}
        <span class="flex items-center gap-1.5" style:color={c}>
          <span class="inline-block h-px w-5" style:background={c}></span>
          <span class="inline-block h-2 w-2 rounded-full" style:background={c}></span>
          {tid}
        </span>
      {/each}
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

  {#if onPingSelect}
    <div class="mb-2 flex items-center gap-2 rounded-lg border border-violet-700/50 bg-violet-950/40 px-3 py-2 text-xs text-violet-300">
      <svg class="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 0v2m0 8v2M2 8H4m8 0h2"/>
      </svg>
      Click a live dot to assign it to the selected stop
    </div>
  {/if}

  {#if canonicalStops.length === 0}
    <div class="flex h-48 items-center justify-center text-sm text-slate-500">No stop data for this block.</div>
  {:else}
    <div class="h-[450px] {onPingSelect ? 'ring-1 ring-violet-600/40 rounded-lg overflow-hidden' : ''}">
      <canvas bind:this={canvas}></canvas>
    </div>
  {/if}
</div>