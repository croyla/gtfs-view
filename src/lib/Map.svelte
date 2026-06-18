<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import type { FilterSpecification } from 'maplibre-gl';
  import { Protocol } from 'pmtiles';
  import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
  import type { GtfsData, ShapePoint } from './types';
  import type { VehiclePosition } from './liveTypes';

  let {
    gtfsData     = null,
    activeShapeIds = new Set<string>(),
    activeStopIds  = new Set<string>(),
    stopWeights    = new Map<string, number>(),
    showShapes  = true,
    showStops   = true,
    showHeatmap = false,
    vehiclePositions = [] as VehiclePosition[],
    tripPingLayers = [] as Array<{ tid: string; color: string; pings: VehiclePosition[] }>,
    isLatestDate = true,
    onStopClick,
    onShapeClick,
  }: {
    gtfsData?: GtfsData | null;
    activeShapeIds?: Set<string>;
    activeStopIds?: Set<string>;
    stopWeights?: Map<string, number>;
    showShapes?: boolean;
    showStops?: boolean;
    showHeatmap?: boolean;
    vehiclePositions?: VehiclePosition[];
    tripPingLayers?: Array<{ tid: string; color: string; pings: VehiclePosition[] }>;
    isLatestDate?: boolean;
    onStopClick?: (stopId: string) => void;
    onShapeClick?: (shapeId: string) => void;
  } = $props();

  let container: HTMLDivElement;
  let map: maplibregl.Map;
  let mapReady = $state(false);

  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const STYLE = 'https://api.protomaps.com/styles/v5/dark/en.json?key=e01868f0b5821d40';

  onMount(() => {
    map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [0, 20],
      zoom: 2,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.on('load', () => {
      mapReady = true;

      // Live vehicle source and layers
      map.addSource('live-vehicles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'live-vehicles',
        type: 'circle',
        source: 'live-vehicles',
        paint: {
          'circle-color': '#34d399',
          'circle-radius': 6,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1.5,
        },
      });

      map.addLayer({
        id: 'live-vehicles-labels',
        type: 'symbol',
        source: 'live-vehicles',
        layout: {
          'text-field': ['get', 'vehicle_id'],
          'text-size': 10,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#94a3b8',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1.5,
        },
      });

      // Per-trip ping trails (coloured lines)
      map.addSource('trip-trails', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'trip-trails',
        type: 'line',
        source: 'trip-trails',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5,
          'line-opacity': 0.55,
        },
      });

      // Per-trip ping dots (coloured circles on top of trails)
      map.addSource('trip-pings', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'trip-pings',
        type: 'circle',
        source: 'trip-pings',
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });
    });

    map.on('click', 'gtfs-stops', (e) => {
      const stopId = e.features?.[0]?.properties?.stop_id as string | undefined;
      if (stopId) onStopClick?.(stopId);
    });

    map.on('click', 'gtfs-shapes', (e) => {
      if (showStops) return;
      const shapeId = e.features?.[0]?.properties?.shape_id as string | undefined;
      if (shapeId) onShapeClick?.(shapeId);
    });

    map.on('mouseenter', 'gtfs-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'gtfs-stops', () => { map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'gtfs-shapes', () => { if (!showStops) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'gtfs-shapes', () => { map.getCanvas().style.cursor = ''; });
  });

  // Track previous gtfsData reference to detect dataset swaps
  let prevGtfsData: GtfsData | null = null;

  $effect(() => {
    if (!mapReady) return;

    const data        = gtfsData;
    const shapeIds    = activeShapeIds;
    const stopIds     = activeStopIds;
    const weights     = stopWeights;
    const _showShapes  = showShapes;
    const _showStops   = showStops;
    const _showHeatmap = showHeatmap;

    if (data !== prevGtfsData) {
      // Remove stale GTFS layers and sources
      for (const id of ['gtfs-heatmap', 'gtfs-stops', 'gtfs-shapes']) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
      prevGtfsData = data;

      if (data) {
        // Heatmap layer (below shapes and stops)
        map.addSource('gtfs-heatmap', { type: 'geojson', data: buildHeatmapGeoJSON(data, weights) });
        map.addLayer({
          id: 'gtfs-heatmap',
          type: 'heatmap',
          source: 'gtfs-heatmap',
          layout: { visibility: _showHeatmap ? 'visible' : 'none' },
          paint: {
            'heatmap-weight': ['get', 'weight'],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 3],
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0,   'rgba(0,0,0,0)',
              0.2, '#4ade80',
              0.4, '#facc15',
              0.6, '#f97316',
              0.8, '#ef4444',
              1,   '#7c3aed',
            ],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 10, 14, 30],
            'heatmap-opacity': 0.85,
          },
        });

        // Shapes layer
        map.addSource('gtfs-shapes', { type: 'geojson', data: buildShapesGeoJSON(data) });
        map.addLayer({
          id: 'gtfs-shapes',
          type: 'line',
          source: 'gtfs-shapes',
          filter: makeFilter('shape_id', shapeIds),
          layout: {
            'line-join': 'round', 'line-cap': 'round',
            visibility: _showShapes ? 'visible' : 'none',
          },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#818cf8'],
            'line-width': 1.8,
            'line-opacity': 0.75,
          },
        });

        // Stops layer (topmost)
        map.addSource('gtfs-stops', { type: 'geojson', data: buildStopsGeoJSON(data) });
        map.addLayer({
          id: 'gtfs-stops',
          type: 'circle',
          source: 'gtfs-stops',
          filter: makeFilter('stop_id', stopIds),
          layout: { visibility: _showStops ? 'visible' : 'none' },
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 5],
            'circle-color': '#ffffff',
            'circle-stroke-color': '#1e293b',
            'circle-stroke-width': 1,
            'circle-opacity': 0.85,
          },
        });

        fitBounds(data);
      }
      return;
    }

    // Same data — only update filters, heatmap, and visibility
    if (map.getLayer('gtfs-shapes')) {
      map.setFilter('gtfs-shapes', makeFilter('shape_id', shapeIds));
      map.setLayoutProperty('gtfs-shapes', 'visibility', _showShapes ? 'visible' : 'none');
    }
    if (map.getLayer('gtfs-stops')) {
      map.setFilter('gtfs-stops', makeFilter('stop_id', stopIds));
      map.setLayoutProperty('gtfs-stops', 'visibility', _showStops ? 'visible' : 'none');
    }
    if (map.getLayer('gtfs-heatmap')) {
      map.setLayoutProperty('gtfs-heatmap', 'visibility', _showHeatmap ? 'visible' : 'none');
    }
    if (data && map.getSource('gtfs-heatmap')) {
      (map.getSource('gtfs-heatmap') as maplibregl.GeoJSONSource)
        .setData(buildHeatmapGeoJSON(data, weights));
    }
  });

  // ── Vehicle positions effect ──────────────────────────────────────────────────

  $effect(() => {
    const positions = vehiclePositions;
    const latest    = isLatestDate;
    if (!mapReady) return;

    const liveSource = map.getSource('live-vehicles') as maplibregl.GeoJSONSource | undefined;
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const show = latest ? 'visible' : 'none';

    liveSource?.setData(latest ? buildVehicleGeoJSON(positions) : empty);
    if (map.getLayer('live-vehicles'))        map.setLayoutProperty('live-vehicles',        'visibility', show);
    if (map.getLayer('live-vehicles-labels')) map.setLayoutProperty('live-vehicles-labels', 'visibility', show);
  });

  // ── Trip ping layers effect ───────────────────────────────────────────────────

  $effect(() => {
    const layers = tripPingLayers;
    if (!mapReady) return;
    const dotSrc   = map.getSource('trip-pings')  as maplibregl.GeoJSONSource | undefined;
    const trailSrc = map.getSource('trip-trails') as maplibregl.GeoJSONSource | undefined;
    if (!dotSrc || !trailSrc) return;

    const dotFeatures:   Feature<Point>[]      = [];
    const trailFeatures: Feature<LineString>[] = [];

    for (const { tid, color, pings } of layers) {
      const sorted = [...pings].sort((a, b) => a.timestamp - b.timestamp);
      for (const p of sorted) {
        dotFeatures.push({
          type: 'Feature',
          properties: { color, trip_id: tid },
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        });
      }
      if (sorted.length >= 2) {
        trailFeatures.push({
          type: 'Feature',
          properties: { color, trip_id: tid },
          geometry: { type: 'LineString', coordinates: sorted.map(p => [p.lon, p.lat]) },
        });
      }
    }

    dotSrc.setData({ type: 'FeatureCollection', features: dotFeatures });
    trailSrc.setData({ type: 'FeatureCollection', features: trailFeatures });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function buildVehicleGeoJSON(positions: VehiclePosition[]): FeatureCollection {
    const latest = new Map<string, VehiclePosition>();
    for (const p of positions) {
      const existing = latest.get(p.vehicle_id);
      if (!existing || p.timestamp > existing.timestamp) latest.set(p.vehicle_id, p);
    }
    const features: Feature<Point>[] = [...latest.values()].map(p => ({
      type: 'Feature',
      properties: { vehicle_id: p.vehicle_id, trip_id: p.trip_id ?? null },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    }));
    return { type: 'FeatureCollection', features };
  }

  function makeFilter(prop: string, ids: Set<string>): FilterSpecification {
    if (ids.size === 0) return ['boolean', false] as FilterSpecification;
    return ['in', ['get', prop], ['literal', [...ids]]] as FilterSpecification;
  }

  function fitBounds(data: GtfsData) {
    if (data.stops.size === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const stop of data.stops.values())
      bounds.extend([stop.stop_lon, stop.stop_lat]);
    map.fitBounds(bounds, { padding: 60, duration: 1000, maxZoom: 14 });
  }

  function buildShapesGeoJSON(data: GtfsData): FeatureCollection {
    const features: Feature<LineString>[] = [];
    for (const [shapeId, points] of data.shapes) {
      const sorted = (points as ShapePoint[]).slice()
        .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
      features.push({
        type: 'Feature',
        properties: { shape_id: shapeId, color: data.shapeColors.get(shapeId) ?? null },
        geometry: { type: 'LineString', coordinates: sorted.map(p => [p.shape_pt_lon, p.shape_pt_lat]) },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildStopsGeoJSON(data: GtfsData): FeatureCollection {
    const features: Feature<Point>[] = [];
    for (const stop of data.stops.values()) {
      features.push({
        type: 'Feature',
        properties: { stop_id: stop.stop_id, stop_name: stop.stop_name, stop_code: stop.stop_code ?? null },
        geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildHeatmapGeoJSON(data: GtfsData, weights: Map<string, number>): FeatureCollection {
    const features: Feature<Point>[] = [];
    const maxWeight = Math.max(1, ...weights.values());
    for (const [stopId, count] of weights) {
      const stop = data.stops.get(stopId);
      if (!stop) continue;
      features.push({
        type: 'Feature',
        properties: { weight: count / maxWeight },
        geometry: { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  onDestroy(() => { map?.remove(); });
</script>

<div bind:this={container} class="absolute inset-0 h-full w-full"></div>