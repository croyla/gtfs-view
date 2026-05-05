<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import { formatTime, formatDuration, parseTimeMin, shapeDistanceKm } from './popupUtils';

  let {
    routeId,
    gtfsData,
    onNavigate,
  }: {
    routeId: string;
    gtfsData: GtfsData;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  let activeTab = $state<'overview' | 'trips'>('overview');

  $effect(() => { routeId; activeTab = 'overview'; });

  const route = $derived(gtfsData.routes.get(routeId));
  const agency = $derived(route ? gtfsData.agencies.get(route.agency_id) : undefined);

  // Single pass over stop_times to compute per-trip first/last stop + duration
  const routeInfo = $derived.by(() => {
    if (!route) return null;

    type TripBounds = {
      minSeq: number; minTime: string; minStopId: string;
      maxSeq: number; maxTime: string; maxStopId: string;
    };

    const tripBounds = new Map<string, TripBounds>();

    for (const trip of gtfsData.trips.values()) {
      if (trip.route_id !== routeId) continue;
      for (const st of gtfsData.stopTimesByTrip.get(trip.trip_id) ?? []) {
        const curr = tripBounds.get(st.trip_id);
        if (!curr) {
          tripBounds.set(st.trip_id, {
            minSeq: st.stop_sequence, minTime: st.departure_time || st.arrival_time, minStopId: st.stop_id,
            maxSeq: st.stop_sequence, maxTime: st.arrival_time || st.departure_time, maxStopId: st.stop_id,
          });
        } else {
          if (st.stop_sequence < curr.minSeq) {
            curr.minSeq = st.stop_sequence;
            curr.minTime = st.departure_time || st.arrival_time;
            curr.minStopId = st.stop_id;
          }
          if (st.stop_sequence > curr.maxSeq) {
            curr.maxSeq = st.stop_sequence;
            curr.maxTime = st.arrival_time || st.departure_time;
            curr.maxStopId = st.stop_id;
          }
        }
      }
    }

    // Average duration
    let durationSum = 0, durationCount = 0;
    for (const b of tripBounds.values()) {
      const dep = parseTimeMin(b.minTime), arr = parseTimeMin(b.maxTime);
      if (arr > dep) { durationSum += arr - dep; durationCount++; }
    }
    const avgDurationMin = durationCount > 0 ? durationSum / durationCount : 0;

    // Shape distance: longest shape on this route
    const shapeIds = new Set<string>();
    for (const trip of gtfsData.trips.values()) {
      if (trip.route_id === routeId && trip.shape_id) shapeIds.add(trip.shape_id);
    }
    let maxDistKm = 0;
    for (const sid of shapeIds) {
      const pts = gtfsData.shapes.get(sid);
      if (pts) { const d = shapeDistanceKm(pts); if (d > maxDistKm) maxDistKm = d; }
    }

    // Group trips by first→last stop pair
    type TripGroup = {
      key: string;
      firstStopName: string;
      lastStopName: string;
      trips: { tripId: string; departureTime: string; departureMin: number }[];
    };
    const groups = new Map<string, TripGroup>();
    for (const [tripId, b] of tripBounds) {
      const key = `${b.minStopId}:${b.maxStopId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          firstStopName: gtfsData.stops.get(b.minStopId)?.stop_name ?? b.minStopId,
          lastStopName:  gtfsData.stops.get(b.maxStopId)?.stop_name ?? b.maxStopId,
          trips: [],
        });
      }
      groups.get(key)!.trips.push({
        tripId,
        departureTime: b.minTime,
        departureMin: parseTimeMin(b.minTime),
      });
    }
    for (const g of groups.values()) g.trips.sort((a, b) => a.departureMin - b.departureMin);

    const sortedGroups = [...groups.values()].sort((a, b) =>
      (a.trips[0]?.departureMin ?? 0) - (b.trips[0]?.departureMin ?? 0),
    );

    return { tripCount: tripBounds.size, avgDurationMin, maxDistKm, groups: sortedGroups };
  });
</script>

{#if route && routeInfo}
  <!-- Tabs -->
  <div class="flex border-b border-slate-700 mb-4">
    {#each [['overview', 'Overview'], ['trips', 'Trips']] as [tab, label] (tab)}
      <button
        class="px-4 py-2 text-sm font-medium transition-colors {activeTab === tab
          ? 'text-indigo-400 border-b-2 border-indigo-400 -mb-px'
          : 'text-slate-400 hover:text-slate-200'}"
        onclick={() => (activeTab = tab as 'overview' | 'trips')}
      >{label}</button>
    {/each}
  </div>

  {#if activeTab === 'overview'}
    <div class="space-y-4">
      <!-- Route identity -->
      <div class="flex items-start gap-3">
        {#if route.route_color}
          <span
            class="mt-0.5 h-8 w-1.5 shrink-0 rounded-full"
            style="background: {route.route_color}"
          ></span>
        {/if}
        <div class="min-w-0">
          <p class="text-base font-bold text-white">
            {route.route_short_name || route.route_id}
          </p>
          {#if route.route_long_name}
            <p class="text-sm text-slate-300 leading-snug">{route.route_long_name}</p>
          {/if}
          {#if agency}
            <p class="text-xs text-slate-500 mt-0.5">{agency.agency_name}</p>
          {/if}
        </div>
      </div>

      <!-- Stats grid -->
      <div class="grid grid-cols-3 gap-2">
        <div class="rounded-lg bg-slate-800 px-2.5 py-2">
          <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Trips</p>
          <p class="text-xl font-bold text-white tabular-nums">{routeInfo.tripCount}</p>
        </div>
        {#if routeInfo.maxDistKm > 0}
          <div class="rounded-lg bg-slate-800 px-2.5 py-2">
            <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Distance</p>
            <p class="text-xl font-bold text-white tabular-nums">{routeInfo.maxDistKm.toFixed(1)}<span class="text-xs font-normal text-slate-400 ml-0.5">km</span></p>
          </div>
        {/if}
        {#if routeInfo.avgDurationMin > 0}
          <div class="rounded-lg bg-slate-800 px-2.5 py-2">
            <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Avg time</p>
            <p class="text-sm font-bold text-white mt-1">{formatDuration(routeInfo.avgDurationMin)}</p>
          </div>
        {/if}
      </div>

      {#if route.route_type}
        <p class="text-xs text-slate-500">Route ID: {route.route_id} · Type: {route.route_type}</p>
      {/if}
    </div>

  {:else}
    <!-- Trips tab: grouped by first→last stop -->
    {#if routeInfo.groups.length === 0}
      <p class="text-sm text-slate-400">No trip data.</p>
    {:else}
      <div class="overflow-y-auto space-y-4">
        {#each routeInfo.groups as group (group.key)}
          <div>
            <div class="flex items-center gap-2 mb-1.5 px-1">
              <span class="text-xs text-slate-300 truncate">{group.firstStopName}</span>
              <svg class="h-3 w-3 shrink-0 text-slate-500" viewBox="0 0 12 12" fill="none">
                <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span class="text-xs text-slate-300 truncate">{group.lastStopName}</span>
            </div>
            <div class="space-y-0">
              {#each group.trips as t (t.tripId)}
                <button
                  class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-800 text-left transition-colors"
                  onclick={() => onNavigate({ type: 'trip', tripId: t.tripId })}
                >
                  <span class="text-sm tabular-nums text-slate-200">{formatTime(t.departureTime)}</span>
                  <svg class="h-3 w-3 text-slate-600" viewBox="0 0 12 12" fill="none">
                    <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{:else}
  <p class="text-sm text-slate-400">Route not found.</p>
{/if}