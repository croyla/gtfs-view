<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';

  export interface RawPingPoint {
    lat:     number;
    lon:     number;
    timeMin: number;
  }

  export interface ScheduleTripLine {
    tid:      string;
    stops:    Array<{ lat: number; lon: number; name: string; stopId: string }>;
    startMin: number;
    endMin:   number;
  }

  let {
    blockId,
    pings,
    schedTrips,
    onClose,
  }: {
    blockId:    string;
    pings:      RawPingPoint[];
    schedTrips: ScheduleTripLine[];
    onClose:    () => void;
  } = $props();

  const STYLE      = 'https://api.protomaps.com/styles/v5/dark/en.json?key=e01868f0b5821d40';
  const FOLLOW_WIN = 60;  // sliding window width in minutes
  const STEP_MIN   = 1;   // minutes advanced per tick

  // Compute overall time range from pings + schedule
  const pingTimes   = pings.map(p => p.timeMin).filter(Number.isFinite);
  const schedStarts = schedTrips.map(t => t.startMin).filter(Number.isFinite);
  const schedEnds   = schedTrips.map(t => t.endMin).filter(Number.isFinite);
  const dataMin     = Math.max(0,       Math.min(...pingTimes, ...schedStarts) - 15);
  const dataMax     = Math.min(30 * 60, Math.max(...pingTimes, ...schedEnds)   + 15);
  const totalMin    = dataMax - dataMin || 60;

  // Sorted pings for ordered rendering
  const sortedPings = [...pings]
    .filter(p => p.lat !== 0 && p.lon !== 0 && Number.isFinite(p.timeMin))
    .sort((a, b) => a.timeMin - b.timeMin);

  let fromMin  = $state(dataMin);
  let toMin    = $state(Math.min(dataMin + FOLLOW_WIN, dataMax));
  let playing  = $state(false);
  let speed    = $state(8);   // steps per second (1–30)

  let container: HTMLDivElement;
  let map: maplibregl.Map;
  let mapReady = $state(false);

  const filteredPings = $derived(
    sortedPings.filter(p => p.timeMin >= fromMin && p.timeMin <= toMin)
  );

  function fmtMin(m: number): string {
    const h   = Math.floor(m / 60) % 24;
    const min = Math.floor(m % 60);
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Keep toMin always >= fromMin + 5
  $effect(() => {
    if (toMin < fromMin + 5) toMin = Math.min(fromMin + 5, dataMax);
  });

  // Push map updates whenever filtered pings or map readiness changes
  $effect(() => {
    if (!mapReady) return;
    const fps = filteredPings;
    pushPingData(fps);
  });

  function pushPingData(fps: RawPingPoint[]) {
    const coords = fps.map(p => [p.lon, p.lat] as [number, number]);

    const lineGeo: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: coords.length >= 2
        ? { type: 'LineString', coordinates: coords }
        : { type: 'LineString', coordinates: [] },
    };
    const dotsGeo: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: fps.map(p => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      })),
    };
    // Head dot: most recent ping in window
    const head = fps.at(-1);
    const headGeo: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: head
        ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [head.lon, head.lat] } }]
        : [],
    };

    (map.getSource('ping-line') as maplibregl.GeoJSONSource)?.setData(lineGeo);
    (map.getSource('ping-dots') as maplibregl.GeoJSONSource)?.setData(dotsGeo);
    (map.getSource('ping-head') as maplibregl.GeoJSONSource)?.setData(headGeo);
  }

  // Reactive follow loop — re-runs whenever playing or speed changes
  $effect(() => {
    if (!playing) return;
    const ms = Math.round(1000 / speed);
    const timer = setInterval(() => {
      if (toMin >= dataMax) { playing = false; return; }
      const newFrom = clamp(fromMin + STEP_MIN, dataMin, dataMax - FOLLOW_WIN);
      const newTo   = clamp(newFrom + FOLLOW_WIN, dataMin + FOLLOW_WIN, dataMax);
      fromMin = newFrom;
      toMin   = newTo;
    }, ms);
    return () => clearInterval(timer);
  });

  function toggleFollow() {
    if (!playing && toMin >= dataMax) {
      fromMin = dataMin;
      toMin   = Math.min(dataMin + FOLLOW_WIN, dataMax);
    }
    playing = !playing;
  }

  function resetWindow() {
    playing = false;
    fromMin = dataMin;
    toMin   = dataMax;
  }

  onMount(() => {
    const proto = new Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);

    map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [0, 20],
      zoom: 2,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      // ── Unique stops across all trips (keyed by stop_id) ─────────────────
      const stopMap = new Map<string, { lat: number; lon: number; name: string }>();
      for (const trip of schedTrips)
        for (const s of trip.stops)
          if (!stopMap.has(s.stopId) && s.lat !== 0 && s.lon !== 0)
            stopMap.set(s.stopId, { lat: s.lat, lon: s.lon, name: s.name });
      const uniqueStops = [...stopMap.values()];

      // ── Scheduled route lines (one LineString per trip) ───────────────────
      const tripLines = schedTrips
        .filter(t => t.stops.length >= 2)
        .map(t => ({
          type: 'Feature' as const,
          properties: { tid: t.tid },
          geometry: {
            type: 'LineString' as const,
            coordinates: t.stops
              .filter(s => s.lat !== 0 && s.lon !== 0)
              .map(s => [s.lon, s.lat]),
          },
        }));

      map.addSource('sched-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: tripLines },
      });
      map.addLayer({
        id: 'sched-line', type: 'line', source: 'sched-lines',
        paint: { 'line-color': '#818cf8', 'line-width': 2, 'line-opacity': 0.55 },
      });

      // ── Scheduled stop dots ───────────────────────────────────────────────
      map.addSource('sched-stops', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: uniqueStops.map(s => ({
            type: 'Feature' as const,
            properties: { name: s.name },
            geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
          })),
        },
      });
      map.addLayer({
        id: 'sched-stops', type: 'circle', source: 'sched-stops',
        paint: {
          'circle-radius': 4,
          'circle-color': '#818cf8',
          'circle-opacity': 0.75,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.5,
        },
      });

      // ── Ping path (updated reactively) ────────────────────────────────────
      map.addSource('ping-line', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      });
      map.addLayer({
        id: 'ping-line', type: 'line', source: 'ping-line',
        paint: { 'line-color': '#34d399', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.75 },
      });

      // ── Ping trail dots ───────────────────────────────────────────────────
      map.addSource('ping-dots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'ping-dots', type: 'circle', source: 'ping-dots',
        paint: {
          'circle-radius': 2.5,
          'circle-color': '#ffffff',
          'circle-opacity': 0.7,
          'circle-stroke-color': '#34d399',
          'circle-stroke-width': 1.2,
        },
      });

      // ── Head dot (most recent in window) ─────────────────────────────────
      map.addSource('ping-head', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'ping-head', type: 'circle', source: 'ping-head',
        paint: {
          'circle-radius': 6,
          'circle-color': '#34d399',
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 2,
        },
      });

      // ── Fit bounds ────────────────────────────────────────────────────────
      const allCoords: [number, number][] = [
        ...uniqueStops.map(s => [s.lon, s.lat] as [number, number]),
        ...sortedPings.map(p => [p.lon, p.lat] as [number, number]),
      ];
      if (allCoords.length > 0) {
        const bounds = allCoords.reduce(
          (b, c) => b.extend(c),
          new maplibregl.LngLatBounds(allCoords[0], allCoords[0]),
        );
        map.fitBounds(bounds, { padding: 52, maxZoom: 14, duration: 0 });
      }

      mapReady = true;
      pushPingData(sortedPings.filter(p => p.timeMin >= fromMin && p.timeMin <= toMin));
    });
  });

  onDestroy(() => {
    playing = false;
    map?.remove();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    if (e.key === ' ') { e.preventDefault(); toggleFollow(); }
  }

  // Progress bar position
  const fromPct = $derived(totalMin > 0 ? ((fromMin - dataMin) / totalMin) * 100 : 0);
  const toPct   = $derived(totalMin > 0 ? ((toMin   - dataMin) / totalMin) * 100 : 100);
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex items-center justify-center">
  <div
    class="absolute inset-0 bg-black/75 backdrop-blur-sm"
    role="button" tabindex="-1"
    onclick={onClose} onkeydown={() => {}}
  ></div>

  <div class="relative z-10 flex h-[640px] max-h-[92vh] w-[900px] max-w-[96vw] flex-col
              overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">

    <!-- Header -->
    <div class="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-3">
      <div class="flex items-center gap-2.5">
        <svg class="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"/>
        </svg>
        <span class="text-sm font-semibold text-slate-200">Raw Pings</span>
        <span class="font-mono text-xs text-slate-500">Block {blockId}</span>
        <span class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          {sortedPings.length} pings · {schedTrips.length} trips
        </span>
      </div>
      <button
        onclick={onClose}
        class="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400
               hover:bg-slate-700 hover:text-slate-200 transition-colors"
        aria-label="Close"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4l8 8M12 4l-8 8"/>
        </svg>
      </button>
    </div>

    <!-- Map -->
    <div bind:this={container} class="min-h-0 flex-1"></div>

    <!-- Controls -->
    <div class="shrink-0 space-y-3 border-t border-slate-800 bg-slate-900/95 px-4 py-3">

      <!-- Time range display + buttons -->
      <div class="flex items-center gap-3">
        <!-- Play / Pause -->
        <button
          onclick={toggleFollow}
          class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors
                 {playing
                   ? 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30'
                   : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}"
        >
          {#if playing}
            <!-- Pause icon -->
            <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
              <rect x="3" y="2" width="4" height="12" rx="1"/>
              <rect x="9" y="2" width="4" height="12" rx="1"/>
            </svg>
            Pause
          {:else}
            <!-- Play icon -->
            <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16">
              <path d="M3 2.5l10 5.5-10 5.5V2.5z"/>
            </svg>
            Follow
          {/if}
        </button>

        <!-- Reset -->
        <button
          onclick={resetWindow}
          class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-slate-400
                 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          title="Show all pings"
        >
          <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2 8a6 6 0 1 0 12 0A6 6 0 0 0 2 8zM8 5v3l2 2"/>
          </svg>
          All
        </button>

        <div class="h-3.5 w-px bg-slate-700"></div>

        <!-- Time display -->
        <span class="font-mono text-xs text-slate-200">
          {fmtMin(fromMin)}<span class="mx-1 text-slate-600">–</span>{fmtMin(toMin)}
        </span>
        <span class="text-xs text-slate-500">
          {filteredPings.length} / {sortedPings.length} pings
        </span>

        {#if playing}
          <span class="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-400/80">
            <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span>
            Following
          </span>
        {/if}
      </div>

      <!-- Timeline: progress bar showing window position + sliders -->
      <div class="space-y-1.5">
        <!-- Visual timeline bar -->
        <div class="relative h-5">
          <!-- Track -->
          <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-800"></div>
          <!-- Active window highlight -->
          <div
            class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-indigo-500/40 transition-all"
            style="left: {fromPct}%; width: {toPct - fromPct}%;"
          ></div>
          <!-- From handle label -->
          <span
            class="pointer-events-none absolute -top-0.5 text-[9px] text-slate-500"
            style="left: {fromPct}%; transform: translateX(-50%)"
          >{fmtMin(fromMin)}</span>
          <!-- To handle label -->
          <span
            class="pointer-events-none absolute bottom-0 text-[9px] text-slate-500"
            style="left: {toPct}%; transform: translateX(-50%)"
          >{fmtMin(toMin)}</span>
        </div>

        <!-- From slider -->
        <div class="flex items-center gap-2">
          <span class="w-9 shrink-0 text-right text-[10px] text-slate-500">Start</span>
          <input
            type="range"
            min={dataMin} max={dataMax} step="1"
            bind:value={fromMin}
            oninput={() => { if (toMin < fromMin + 5) toMin = Math.min(fromMin + 5, dataMax); }}
            class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-indigo-400 [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span class="w-12 shrink-0 text-right font-mono text-[10px] text-slate-400">{fmtMin(fromMin)}</span>
        </div>

        <!-- To slider -->
        <div class="flex items-center gap-2">
          <span class="w-9 shrink-0 text-right text-[10px] text-slate-500">End</span>
          <input
            type="range"
            min={dataMin} max={dataMax} step="1"
            bind:value={toMin}
            oninput={() => { if (toMin < fromMin + 5) fromMin = Math.max(toMin - 5, dataMin); }}
            class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span class="w-12 shrink-0 text-right font-mono text-[10px] text-slate-400">{fmtMin(toMin)}</span>
        </div>

        <!-- Speed slider -->
        <div class="flex items-center gap-2 border-t border-slate-800/60 pt-2">
          <span class="w-9 shrink-0 text-right text-[10px] text-slate-500">Speed</span>
          <span class="text-[9px] text-slate-600">slow</span>
          <input
            type="range"
            min="1" max="30" step="1"
            bind:value={speed}
            class="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-slate-400 [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span class="text-[9px] text-slate-600">fast</span>
          <span class="w-12 shrink-0 text-right font-mono text-[10px] text-slate-400">{speed}×/s</span>
        </div>
      </div>
    </div>

    <!-- Legend -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-800
                bg-slate-900/80 px-4 py-2 text-[11px] text-slate-400">
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-5 rounded" style="background:#818cf8; opacity:0.6"></span>
        Schedule
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-full border border-slate-900" style="background:#818cf8; opacity:0.75"></span>
        Stop
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-5 rounded" style="background:#34d399"></span>
        Raw pings
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-full border-2" style="background:#34d399; border-color:#0f172a"></span>
        Latest in window
      </span>
      <span class="ml-auto text-[10px] text-slate-600">Space to play/pause</span>
    </div>

  </div>
</div>