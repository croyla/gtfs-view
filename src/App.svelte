<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    authenticate, fetchDates, fetchGtfsBundle, fetchPositions, openPositionStream,
    getToken, clearToken,
    type ApiVehicleAssignment, type ApiPosition, type WsMessage,
  } from './lib/api';
  import { buildGtfsFromApi } from './lib/gtfsFromApi';
  import { buildLiveStopTimes, applyInterpolation } from './lib/liveStopTimes';
  import { parseTimeMin } from './lib/popupUtils';
  import type { GtfsData } from './lib/types';
  import type { LiveData, VehiclePosition } from './lib/liveTypes';
  import MapView from './lib/Map.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import Dashboard from './lib/Dashboard.svelte';
  import Popup from './lib/Popup.svelte';
  import type { CardEntry } from './lib/popupTypes';

  // ── App screen ────────────────────────────────────────────────────────────────

  type AppScreen = 'password' | 'loading' | 'map' | 'dashboard';
  let screen = $state<AppScreen>('password');

  // ── Auth ──────────────────────────────────────────────────────────────────────

  let passwordInput = $state('');
  let passwordError = $state<string | null>(null);
  let passwordLoading = $state(false);

  // ── Data ──────────────────────────────────────────────────────────────────────

  let dates = $state<string[]>([]);
  let dateIndex = $state(0);
  let selectedDate = $derived(dates[dateIndex] ?? '');

  let gtfsData  = $state<GtfsData | null>(null);
  let liveData  = $state<LiveData | null>(null);
  let vehicleAssignments = $state<ApiVehicleAssignment[]>([]);
  let loadError = $state<string | null>(null);

  // ── WebSocket ─────────────────────────────────────────────────────────────────

  let ws: WebSocket | null = null;
  let wsError = $state<string | null>(null);

  let positionHistory: VehiclePosition[] = [];
  let positionById = new Map<string, VehiclePosition>(); // vehicle_id → latest for counts
  let posIdCounter = 0;

  function buildLiveData(): LiveData {
    const all = positionHistory;
    const ts = all.map(p => p.timestamp).filter(t => t > 0);
    return {
      vehiclePositions: [...all], // new array so $derived downstream re-evaluates
      minTimestamp: ts.length ? Math.min(...ts) : 0,
      maxTimestamp: ts.length ? Math.max(...ts) : 0,
      vehicleCount: positionById.size,
      routeCount: new Set(all.map(p => p.route_id).filter(Boolean)).size,
    };
  }

  // Compute local midnight (epoch seconds) for a YYYYMMDD date string + timezone.
  function localMidnightEpoch(dateStr: string, timezone: string): number {
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

  // Find which of a vehicle's trips is active at a given timestamp.
  // A block vehicle runs multiple trips, so we need time-based resolution.
  function resolveActiveTrip(
    vehicleId: string,
    timestamp: number,
    vehicleToTrips: Map<string, string[]>,
    gtfsData: GtfsData,
    midnight: number,
  ): string | null {
    const tripIds = vehicleToTrips.get(vehicleId);
    if (!tripIds) return null;
    for (const tid of tripIds) {
      const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
      if (sts.length === 0) continue;
      const firstMin = parseTimeMin(sts[0].departure_time || sts[0].arrival_time);
      const lastMin  = parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time);
      const firstEpoch = midnight + firstMin * 60;
      const lastEpoch  = midnight + lastMin  * 60;
      // Allow ±10 min slack around the trip window
      if (timestamp >= firstEpoch - 10 * 60 && timestamp <= lastEpoch + 10 * 60) {
        return tid;
      }
    }
    return null;
  }

  function apiPosToVehiclePos(
    pos: ApiPosition,
    id: number,
    vehicleToTrips: Map<string, string[]>,
    tripToRoute: Map<string, string>,
    gtfsData: GtfsData,
    midnight: number,
  ): VehiclePosition {
    const timestamp = Math.floor(new Date(pos.timestamp).getTime() / 1000);
    const tripId    = resolveActiveTrip(pos.vehicle_id, timestamp, vehicleToTrips, gtfsData, midnight);
    const routeId   = tripId ? (tripToRoute.get(tripId) ?? null) : null;
    return {
      id,
      vehicle_id: pos.vehicle_id,
      trip_id:    tripId,
      route_id:   routeId,
      lat:        pos.lat,
      lon:        pos.lon,
      bearing:    null,
      speed:      null,
      status:     '',
      timestamp,
    };
  }

  function setupLiveStream(date: string, assignments: ApiVehicleAssignment[], gtfs: GtfsData) {
    ws?.close();
    ws = null;
    wsError = null;
    positionHistory = [];
    positionById.clear();
    posIdCounter = 0;

    // One-to-many: a vehicle runs multiple trips in a block
    const vehicleToTrips = new Map<string, string[]>();
    for (const a of assignments) {
      const list = vehicleToTrips.get(a.vehicle_id);
      if (list) list.push(a.trip_id);
      else vehicleToTrips.set(a.vehicle_id, [a.trip_id]);
    }

    const tripToRoute = new Map([...gtfs.trips.entries()].map(([tid, t]) => [tid, t.route_id]));
    const timezone    = [...gtfs.agencies.values()][0]?.agency_timezone ?? 'UTC';
    const midnight    = localMidnightEpoch(date, timezone);

    try {
      const socket = openPositionStream(date);
      ws = socket;

      socket.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as WsMessage;
        const positions = msg.positions as ApiPosition[];

        if (msg.type === 'snapshot') {
          positionHistory = [];
          positionById.clear();
        }
        for (const p of positions) {
          const vp = apiPosToVehiclePos(p, ++posIdCounter, vehicleToTrips, tripToRoute, gtfs, midnight);
          positionHistory.push(vp);
          positionById.set(p.vehicle_id, vp);
        }
        liveData = buildLiveData();
      };

      socket.onerror = () => { wsError = 'Live position stream error — check server connectivity and token auth.'; };
      socket.onclose = (e) => { if (e.code !== 1000) wsError = `Stream closed unexpectedly (code ${e.code})`; };
    } catch (err) {
      wsError = err instanceof Error ? err.message : 'Failed to open position stream';
    }
  }

  // ── Load date ─────────────────────────────────────────────────────────────────

  async function loadDate(allDates: string[], idx: number, returnScreen: AppScreen = 'map') {
    screen = 'loading';
    loadError = null;
    dates = allDates;
    dateIndex = idx;
    const date = allDates[idx];

    try {
      const bundle = await fetchGtfsBundle(date);
      gtfsData = buildGtfsFromApi(bundle.agency, bundle.routes, bundle.stops, bundle.trips, bundle.stopTimes);
      vehicleAssignments = bundle.vehicleAssignments;

      // Seed live data with current positions snapshot
      const initialPositions = await fetchPositions(date).catch(() => [] as ApiPosition[]);
      const initVehicleToTrips = new Map<string, string[]>();
      for (const a of bundle.vehicleAssignments) {
        const list = initVehicleToTrips.get(a.vehicle_id);
        if (list) list.push(a.trip_id);
        else initVehicleToTrips.set(a.vehicle_id, [a.trip_id]);
      }
      const initTripToRoute = new Map([...gtfsData.trips.entries()].map(([tid, t]) => [tid, t.route_id]));
      const initTimezone    = [...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC';
      const initMidnight    = localMidnightEpoch(date, initTimezone);
      positionHistory = [];
      positionById.clear();
      posIdCounter = 0;
      for (const p of initialPositions) {
        const vp = apiPosToVehiclePos(p, ++posIdCounter, initVehicleToTrips, initTripToRoute, gtfsData, initMidnight);
        positionHistory.push(vp);
        positionById.set(p.vehicle_id, vp);
      }
      liveData = initialPositions.length > 0 ? buildLiveData() : null;

      setupLiveStream(date, bundle.vehicleAssignments, gtfsData);
      screen = returnScreen;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load data';
      if (msg === 'AUTH_EXPIRED') {
        screen = 'password';
        passwordError = 'Session expired. Please sign in again.';
      } else {
        loadError = msg;
        screen = returnScreen;
      }
    }
  }

  // ── Password submit ───────────────────────────────────────────────────────────

  async function handlePasswordSubmit(e: Event) {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    passwordLoading = true;
    passwordError = null;
    try {
      await authenticate(passwordInput.trim());
      const fetchedDates = await fetchDates();
      if (fetchedDates.length === 0) throw new Error('No data available on the server');
      await loadDate(fetchedDates, fetchedDates.length - 1);
    } catch (err) {
      passwordError = err instanceof Error ? err.message : 'Authentication failed';
      screen = 'password';
    } finally {
      passwordLoading = false;
    }
  }

  // ── Mount: try saved token ────────────────────────────────────────────────────

  onMount(async () => {
    if (!getToken()) { screen = 'password'; return; }
    try {
      const fetchedDates = await fetchDates();
      if (fetchedDates.length === 0) { screen = 'password'; return; }
      await loadDate(fetchedDates, fetchedDates.length - 1);
    } catch {
      clearToken();
      screen = 'password';
    }
  });

  onDestroy(() => { ws?.close(); });

  // ── Date navigation ───────────────────────────────────────────────────────────

  async function changeDate(date: string) {
    const idx = dates.indexOf(date);
    if (idx === -1) return;
    await loadDate(dates, idx, screen);
  }

  function formatDate(yyyymmdd: string): string {
    const y = yyyymmdd.slice(0, 4), m = yyyymmdd.slice(4, 6), d = yyyymmdd.slice(6, 8);
    return new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  }

  // ── Visibility toggles ────────────────────────────────────────────────────────

  let showShapes          = $state(true);
  let showStops           = $state(true);
  let showHeatmap         = $state(false);
  let interpolateSkipped  = $state(false);

  // ── Checked state (shape group keys) ─────────────────────────────────────────

  let checkedKeys = $state(new Set<string>());

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

  // ── Live stop times ───────────────────────────────────────────────────────────

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
</script>

<!-- ── Password screen ──────────────────────────────────────────────────────────── -->

{#if screen === 'password'}
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950">
    <div class="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
      <div class="mb-6 text-center">
        <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600/20 border border-indigo-500/30">
          <svg class="h-6 w-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <h1 class="text-lg font-semibold text-white">GTFS DataViz</h1>
        <p class="mt-1 text-sm text-slate-400">Enter your password to continue</p>
      </div>

      <form onsubmit={handlePasswordSubmit} class="space-y-4">
        <div>
          <input
            type="password"
            bind:value={passwordInput}
            placeholder="Password"
            autocomplete="current-password"
            class="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm text-white
                   placeholder-slate-500 outline-none focus:border-indigo-400 transition-colors"
          />
        </div>

        {#if passwordError}
          <p class="rounded-lg bg-red-950/40 border border-red-900 px-3 py-2 text-xs text-red-400">
            {passwordError}
          </p>
        {/if}

        <button
          type="submit"
          disabled={passwordLoading || !passwordInput.trim()}
          class="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white
                 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {passwordLoading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  </div>

<!-- ── Loading screen ──────────────────────────────────────────────────────────── -->

{:else if screen === 'loading'}
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950">
    <div class="flex flex-col items-center gap-4">
      <svg class="h-8 w-8 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      <p class="text-sm text-slate-400">Loading data…</p>
    </div>
  </div>

<!-- ── Dashboard screen ──────────────────────────────────────────────────────────── -->

{:else if screen === 'dashboard'}
  <Dashboard
    {dates}
    {selectedDate}
    {gtfsData}
    {vehicleAssignments}
    {liveData}
    onDateChange={changeDate}
    onBack={() => (screen = 'map')}
  />

<!-- ── Map screen ──────────────────────────────────────────────────────────────── -->

{:else}
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
      onShowDashboard={() => (screen = 'dashboard')}
    />

    <div class="relative flex-1 flex flex-col">
      <div class="flex-1 relative">
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

        {#if loadError}
          <div class="absolute top-4 left-1/2 -translate-x-1/2 z-40 rounded-lg border border-red-900 bg-red-950/80 px-4 py-2 text-xs text-red-300 backdrop-blur-sm">
            {loadError}
          </div>
        {/if}

        {#if wsError}
          <div class="absolute top-4 left-1/2 -translate-x-1/2 z-40 mt-10 rounded-lg border border-amber-900 bg-amber-950/80 px-4 py-2 text-xs text-amber-300 backdrop-blur-sm flex items-center gap-2">
            <svg class="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 3L14.5 13.5H1.5L8 3z"/>
              <path stroke-linecap="round" d="M8 7v3M8 11.5v.5" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            {wsError}
            <button class="ml-1 text-amber-500 hover:text-amber-200" onclick={() => (wsError = null)}>✕</button>
          </div>
        {/if}
      </div>

      <!-- Date switcher bar -->
      {#if dates.length > 0}
        <div class="flex items-center justify-center gap-3 border-t border-slate-800 bg-slate-900/90 backdrop-blur-sm px-4 py-2 shrink-0">
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors disabled:opacity-30"
            onclick={() => loadDate(dates, dateIndex - 1)}
            disabled={dateIndex <= 0}
            aria-label="Previous date"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10 3L5 8l5 5"/>
            </svg>
          </button>

          <div class="flex items-center gap-2">
            <svg class="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <path stroke-linecap="round" d="M5 1v3M11 1v3M2 7h12" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <span class="text-sm font-medium text-slate-200 min-w-[130px] text-center">
              {selectedDate ? formatDate(selectedDate) : '—'}
            </span>
            <span class="text-[10px] text-slate-500">
              {dateIndex + 1} / {dates.length}
            </span>
          </div>

          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors disabled:opacity-30"
            onclick={() => loadDate(dates, dateIndex + 1)}
            disabled={dateIndex >= dates.length - 1}
            aria-label="Next date"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 3l5 5-5 5"/>
            </svg>
          </button>
        </div>
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
{/if}