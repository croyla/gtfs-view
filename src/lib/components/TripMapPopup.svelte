<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';

  let {
    tripIdx,
    tripId,
    stops,
    pings,
    matchedPings = [],
    onClose,
  }: {
    tripIdx:      number;
    tripId:       string;
    stops:        Array<{ lat: number; lon: number; name: string; visited: boolean }>;
    pings:        Array<{ lat: number; lon: number }>;
    matchedPings: Array<{ lat: number; lon: number } | null>;
    onClose:      () => void;
  } = $props();

  // Assign each stop a hue evenly spread across the spectrum (rainbow: first → last)
  function stopColor(i: number, total: number): string {
    const hue = total <= 1 ? 200 : Math.round((i / total) * 360);
    return `hsl(${hue},78%,62%)`;
  }

  let container: HTMLDivElement;
  let map: maplibregl.Map;

  const STYLE = 'https://api.protomaps.com/styles/v5/dark/en.json?key=e01868f0b5821d40';

  // Approximate a geographic circle as a GeoJSON ring (closed coordinate array)
  function geoCircle(lat: number, lon: number, radiusM: number, steps = 48): number[][] {
    const coords: number[][] = [];
    const dLat = (radiusM / 6_371_000) * (180 / Math.PI);
    const dLon = dLat / Math.cos(lat * Math.PI / 180);
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      coords.push([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)]);
    }
    coords.push(coords[0]); // close ring
    return coords;
  }

  function makeArrow(size = 12): { width: number; height: number; data: Uint8Array } {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(size,          size / 2);       // tip
    ctx.lineTo(0,             0);              // top-left
    ctx.lineTo(size * 0.35,   size / 2);       // indent
    ctx.lineTo(0,             size);           // bottom-left
    ctx.closePath();
    ctx.fill();
    return { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer) };
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
      map.addImage('trip-arrow', makeArrow(), { sdf: true });

      // Pair each stop with its matched ping and assigned color before filtering,
      // so indices stay aligned after filtering out 0,0 coordinates.
      const stopsWithMeta = stops
        .map((s, i) => ({
          ...s,
          color:       stopColor(i, stops.length),
          matchedPing: matchedPings[i] ?? null,
        }))
        .filter(s => s.lat !== 0 && s.lon !== 0);

      const missedStops = stopsWithMeta.filter(s => !s.visited);
      const validPings  = pings.filter(p => p.lat !== 0 && p.lon !== 0);

      // ── 150 m radius circles around missed stops (bottom layer) ──────────
      if (missedStops.length > 0) {
        map.addSource('missed-radii', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: missedStops.map(s => ({
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'Polygon' as const, coordinates: [geoCircle(s.lat, s.lon, 150)] },
            })),
          },
        });
        map.addLayer({
          id: 'missed-radii-fill', type: 'fill', source: 'missed-radii',
          paint: { 'fill-color': '#fb923c', 'fill-opacity': 0.08 },
        });
        map.addLayer({
          id: 'missed-radii-stroke', type: 'line', source: 'missed-radii',
          paint: { 'line-color': '#fb923c', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [4, 3] },
        });
      }

      // ── Scheduled path ────────────────────────────────────────────────────
      if (stopsWithMeta.length >= 2) {
        map.addSource('sched-path', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: stopsWithMeta.map(s => [s.lon, s.lat]) },
          },
        });
        map.addLayer({
          id: 'sched-line', type: 'line', source: 'sched-path',
          paint: { 'line-color': '#818cf8', 'line-width': 2, 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: 'sched-arrows', type: 'symbol', source: 'sched-path',
          layout: {
            'symbol-placement': 'line',
            'icon-image': 'trip-arrow',
            'symbol-spacing': 60,
            'icon-rotation-alignment': 'map',
          },
          paint: { 'icon-color': '#818cf8', 'icon-opacity': 0.9 },
        });
      }

      // ── Ping path + individual ping dots ──────────────────────────────────
      if (validPings.length >= 2) {
        map.addSource('ping-path', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: validPings.map(p => [p.lon, p.lat]) },
          },
        });
        map.addLayer({
          id: 'ping-line', type: 'line', source: 'ping-path',
          paint: { 'line-color': '#34d399', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.7 },
        });
        map.addLayer({
          id: 'ping-arrows', type: 'symbol', source: 'ping-path',
          layout: {
            'symbol-placement': 'line',
            'icon-image': 'trip-arrow',
            'symbol-spacing': 60,
            'icon-rotation-alignment': 'map',
          },
          paint: { 'icon-color': '#34d399', 'icon-opacity': 0.9 },
        });

        // Individual ping dots — white fill with green stroke, visually distinct from the green line
        map.addSource('ping-dots', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: validPings.map(p => ({
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
            })),
          },
        });
        map.addLayer({
          id: 'ping-dots', type: 'circle', source: 'ping-dots',
          paint: {
            'circle-radius': 3,
            'circle-color': '#ffffff',
            'circle-opacity': 0.9,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#34d399',
          },
        });
      } else if (validPings.length === 1) {
        map.addSource('ping-dots', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [validPings[0].lon, validPings[0].lat] },
          },
        });
        map.addLayer({
          id: 'ping-dots', type: 'circle', source: 'ping-dots',
          paint: {
            'circle-radius': 4,
            'circle-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#34d399',
          },
        });
      }

      // ── Matched ping markers (colored, below stop circles) ───────────────
      const matchedFeatures = stopsWithMeta
        .filter(s => s.visited && s.matchedPing && s.matchedPing.lat !== 0 && s.matchedPing.lon !== 0)
        .map(s => ({
          type: 'Feature' as const,
          properties: { color: s.color },
          geometry: { type: 'Point' as const, coordinates: [s.matchedPing!.lon, s.matchedPing!.lat] },
        }));

      if (matchedFeatures.length > 0) {
        map.addSource('matched', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: matchedFeatures },
        });
        map.addLayer({
          id: 'matched-circles', type: 'circle', source: 'matched',
          paint: {
            'circle-radius': 6,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 2,
          },
        });
      }

      // ── Stop markers (color-coded, on top) ───────────────────────────────
      if (stopsWithMeta.length > 0) {
        map.addSource('stops', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: stopsWithMeta.map(s => ({
              type: 'Feature' as const,
              properties: { color: s.color, visited: s.visited },
              geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
            })),
          },
        });
        map.addLayer({
          id: 'stop-circles', type: 'circle', source: 'stops',
          paint: {
            'circle-radius': 5,
            'circle-color': ['get', 'color'],
            'circle-opacity': ['case', ['==', ['get', 'visited'], true], 1.0, 0.3],
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1.5,
          },
        });
      }

      // ── Fit bounds ────────────────────────────────────────────────────────
      const all: [number, number][] = [
        ...stopsWithMeta.map(s => [s.lon, s.lat] as [number, number]),
        ...validPings.map(p => [p.lon, p.lat] as [number, number]),
      ];
      if (all.length > 0) {
        const bounds = all.reduce(
          (b, c) => b.extend(c),
          new maplibregl.LngLatBounds(all[0], all[0]),
        );
        map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
      }
    });
  });

  onDestroy(() => { map?.remove(); });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Overlay -->
<div class="fixed inset-0 z-50 flex items-center justify-center">
  <div
    class="absolute inset-0 bg-black/75 backdrop-blur-sm"
    role="button"
    tabindex="-1"
    onclick={onClose}
    onkeydown={() => {}}
  ></div>

  <!-- Card -->
  <div class="relative z-10 flex h-[560px] max-h-[90vh] w-[780px] max-w-[95vw] flex-col
              overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">

    <!-- Header -->
    <div class="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-3">
      <div class="flex items-center gap-2.5">
        <svg class="h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.159.69.159 1.006 0Z"/>
        </svg>
        <span class="text-sm font-semibold text-slate-200">Trip {tripIdx}</span>
        <span class="font-mono text-xs text-slate-500">{tripId}</span>
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

    <!-- Legend -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-800 bg-slate-900/80 px-4 py-2 text-[11px] text-slate-400">
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-5 rounded bg-indigo-400"></span>
        Schedule
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-5 rounded bg-emerald-400 opacity-80"></span>
        Pings
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-full border-2 border-slate-800"
              style="background: linear-gradient(135deg, hsl(0,78%,62%), hsl(180,78%,62%), hsl(340,78%,62%))"></span>
        Stop (color = sequence · dim = missed)
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-full border-2 border-slate-900"
              style="background: hsl(90,78%,62%)"></span>
        Matched ping
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block h-3 w-3 rounded-full border border-dashed border-orange-400 opacity-60"></span>
        150 m radius
      </span>
    </div>

  </div>
</div>
