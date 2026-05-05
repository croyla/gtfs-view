<script lang="ts">
  import { onMount } from 'svelte';
  import { loadGtfsFromBlob, loadGtfsFromUrl } from './lib/gtfs';
  import { loadLiveDataFromBlob } from './lib/liveDataLoader';
  import { buildLiveStopTimes, applyInterpolation } from './lib/liveStopTimes';
  import type { GtfsData } from './lib/types';
  import type { LiveData } from './lib/liveTypes';
  import MapView from './lib/Map.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import SourcePrompt from './lib/SourcePrompt.svelte';
  import Popup from './lib/Popup.svelte';
  import type { CardEntry } from './lib/popupTypes';

  // ── Data ─────────────────────────────────────────────────────────────────────

  let gtfsData  = $state<GtfsData | null>(null);
  let liveData  = $state<LiveData | null>(null);
  let loading   = $state(false);
  let error     = $state<string | null>(null);
  let showPrompt = $state(false);

  // ── Visibility toggles ────────────────────────────────────────────────────────

  let showShapes          = $state(true);
  let showStops           = $state(true);
  let showHeatmap         = $state(false);
  let interpolateSkipped  = $state(false);

  // ── Checked state (shape group keys) ─────────────────────────────────────────

  let checkedKeys = $state(new Set<string>());

  // When new data loads, default all keys to checked
  $effect(() => {
    if (gtfsData) checkedKeys = new Set(gtfsData.allShapeKeys);
  });

  function toggleKeys(keys: string[], on: boolean) {
    const next = new Set(checkedKeys);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    checkedKeys = next;
  }

  // ── Derived active sets ───────────────────────────────────────────────────────

  const activeTripIds = $derived.by(() => {
    if (!gtfsData) return new Set<string>();
    const result = new Set<string>();
    for (const trip of gtfsData.trips.values()) {
      const key = trip.shape_id ?? `__noshape__:${trip.route_id}`;
      if (checkedKeys.has(key)) result.add(trip.trip_id);
    }
    return result;
  });

  const activeShapeIds = $derived.by(() => {
    const result = new Set<string>();
    for (const key of checkedKeys) {
      if (!key.startsWith('__noshape__:')) result.add(key);
    }
    return result;
  });

  const activeStopIds = $derived.by(() => {
    if (!gtfsData) return new Set<string>();
    const result = new Set<string>();
    for (const tripId of activeTripIds) {
      for (const stopId of gtfsData.tripStops.get(tripId) ?? []) {
        result.add(stopId);
      }
    }
    return result;
  });

  // Heatmap weights: only computed when heatmap is visible (stop_times can be huge).
  // Recomputes active trips inline to avoid referencing another $derived inside this one,
  // which causes Svelte 5 to fail tracking the conditional dependency.
  const stopWeights = $derived.by(() => {
    if (!showHeatmap || !gtfsData) return new Map<string, number>();
    const activeTrips = new Set<string>();
    for (const trip of gtfsData.trips.values()) {
      const key = trip.shape_id ?? `__noshape__:${trip.route_id}`;
      if (checkedKeys.has(key)) activeTrips.add(trip.trip_id);
    }
    const weights = new Map<string, number>();
    for (const tripId of activeTrips) {
      for (const st of gtfsData.stopTimesByTrip.get(tripId) ?? [])
        weights.set(st.stop_id, (weights.get(st.stop_id) ?? 0) + 1);
    }
    return weights;
  });

  // ── Live stop times (computed when both datasets are present) ────────────────

  const liveProcessed = $derived.by(() => {
    if (!liveData || !gtfsData) return null;
    return buildLiveStopTimes(liveData, gtfsData);
  });

  const effectiveLiveProcessed = $derived.by(() => {
    if (!liveProcessed || !interpolateSkipped) return liveProcessed;
    return applyInterpolation(liveProcessed);
  });

  // ── Popup ─────────────────────────────────────────────────────────────────────

  let popupCard = $state<CardEntry | null>(null);

  function handleStopClick(stopId: string) {
    popupCard = { type: 'stop', stopId };
  }

  function handleShapeClick(shapeId: string) {
    if (!gtfsData) return;
    for (const trip of gtfsData.trips.values()) {
      if (trip.shape_id === shapeId) {
        popupCard = { type: 'route', routeId: trip.route_id };
        return;
      }
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────────

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const source = params.get('source');
    if (source) fetchAndLoad(source);
    else showPrompt = true;
  });

  async function fetchAndLoad(url: string) {
    loading = true; error = null;
    try {
      gtfsData = await loadGtfsFromUrl(url);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load GTFS from URL';
    } finally { loading = false; }
  }

  async function handleFileSelect(blob: Blob) {
    loading = true; error = null;
    try {
      gtfsData = await loadGtfsFromBlob(blob);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to parse GTFS file';
    } finally { loading = false; }
  }

  async function handleLiveDbSelect(blob: Blob) {
    loading = true; error = null;
    try {
      liveData = await loadLiveDataFromBlob(blob);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load live data database';
    } finally { loading = false; }
  }
</script>

<div class="flex h-screen w-screen overflow-hidden bg-slate-950 text-white">
  <Sidebar
    {gtfsData}
    {liveData}
    {liveProcessed}
    {checkedKeys}
    bind:showShapes
    bind:showStops
    bind:showHeatmap
    bind:interpolateSkipped
    onToggleKeys={toggleKeys}
    onOpenLoader={() => { showPrompt = true; error = null; }}
  />

  <div class="relative flex-1">
    <MapView
      {gtfsData}
      {activeShapeIds}
      {activeStopIds}
      {stopWeights}
      {showShapes}
      {showStops}
      {showHeatmap}
      onStopClick={handleStopClick}
      onShapeClick={handleShapeClick}
    />

    {#if loading}
      <div class="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
        <div class="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm text-slate-300">
          <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
          Parsing GTFS data…
        </div>
      </div>
    {/if}

    {#if showPrompt}
      <SourcePrompt
        {loading}
        {error}
        gtfsLoaded={gtfsData !== null}
        liveLoaded={liveData !== null}
        onFileSelect={handleFileSelect}
        onUrlSubmit={fetchAndLoad}
        onLiveDbSelect={handleLiveDbSelect}
        onClose={() => { showPrompt = false; error = null; }}
      />
    {/if}
  </div>

  {#if popupCard && gtfsData}
    <Popup
      initialCard={popupCard}
      {gtfsData}
      liveProcessed={effectiveLiveProcessed}
      onClose={() => (popupCard = null)}
    />
  {/if}
</div>
