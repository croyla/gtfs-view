<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import { haversineKm, formatTime, parseTimeMin } from './popupUtils';

  let {
    stopId,
    gtfsData,
    onNavigate,
  }: {
    stopId: string;
    gtfsData: GtfsData;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  let activeTab = $state<'overview' | 'timetable'>('overview');

  const stop = $derived(gtfsData.stops.get(stopId));

  // Single pass over stop_times to build all needed data
  const stopInfo = $derived.by(() => {
    if (!stop) return null;
    const routeIds = new Set<string>();
    const rows: {
      tripId: string;
      key: string;
      routeShort: string;
      routeColor: string | undefined;
      destination: string;
      time: string;
      timeMin: number;
    }[] = [];

    for (const st of gtfsData.stopTimesByStop.get(stopId) ?? []) {
      const trip = gtfsData.trips.get(st.trip_id);
      if (!trip) continue;
      const route = gtfsData.routes.get(trip.route_id);
      routeIds.add(trip.route_id);
      const tripStopList = gtfsData.tripStops.get(st.trip_id) ?? [];
      const lastStop = gtfsData.stops.get(tripStopList[tripStopList.length - 1] ?? '');
      const time = st.departure_time || st.arrival_time;
      rows.push({
        tripId: st.trip_id,
        key: `${st.trip_id}:${st.stop_sequence}`,
        routeShort: route?.route_short_name || trip.route_id,
        routeColor: route?.route_color,
        destination: trip.trip_headsign || lastStop?.stop_name || '—',
        time,
        timeMin: parseTimeMin(time),
      });
    }

    rows.sort((a, b) => a.timeMin - b.timeMin);
    return { tripCount: rows.length, routeCount: routeIds.size, rows };
  });

  const nearbyStops = $derived.by(() => {
    if (!stop) return [];
    const nearby: { stop_id: string; stop_name: string; distKm: number }[] = [];
    for (const s of gtfsData.stops.values()) {
      if (s.stop_id === stopId) continue;
      const dist = haversineKm(stop.stop_lat, stop.stop_lon, s.stop_lat, s.stop_lon);
      if (dist <= 1) nearby.push({ stop_id: s.stop_id, stop_name: s.stop_name, distKm: dist });
    }
    return nearby.sort((a, b) => a.distKm - b.distKm).slice(0, 3);
  });

  // Reset tab when stop changes
  $effect(() => { stopId; activeTab = 'overview'; });
</script>

{#if stop && stopInfo}
  <!-- Tabs -->
  <div class="flex border-b border-slate-700 mb-4">
    {#each [['overview', 'Overview'], ['timetable', 'Timetable']] as [tab, label] (tab)}
      <button
        class="px-4 py-2 text-sm font-medium transition-colors {activeTab === tab
          ? 'text-indigo-400 border-b-2 border-indigo-400 -mb-px'
          : 'text-slate-400 hover:text-slate-200'}"
        onclick={() => (activeTab = tab as 'overview' | 'timetable')}
      >{label}</button>
    {/each}
  </div>

  {#if activeTab === 'overview'}
    <div class="space-y-4">
      <div>
        <p class="text-base font-semibold text-white leading-snug">{stop.stop_name}</p>
        <p class="text-xs text-slate-400 mt-0.5">
          ID: {stop.stop_id}{stop.stop_code ? ` · Code: ${stop.stop_code}` : ''}
        </p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg bg-slate-800 px-3 py-2.5">
          <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Trips served</p>
          <p class="text-2xl font-bold text-white tabular-nums">{stopInfo.tripCount}</p>
        </div>
        <div class="rounded-lg bg-slate-800 px-3 py-2.5">
          <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Routes</p>
          <p class="text-2xl font-bold text-white tabular-nums">{stopInfo.routeCount}</p>
        </div>
      </div>

      {#if nearbyStops.length > 0}
        <div>
          <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Nearby stops</p>
          <div class="space-y-1">
            {#each nearbyStops as nearby (nearby.stop_id)}
              <button
                class="w-full flex items-center justify-between rounded-lg bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 text-left transition-colors"
                onclick={() => onNavigate({ type: 'stop', stopId: nearby.stop_id })}
              >
                <span class="truncate text-slate-200">{nearby.stop_name}</span>
                <span class="ml-2 shrink-0 text-xs text-slate-400">
                  {nearby.distKm < 1 ? `${(nearby.distKm * 1000).toFixed(0)} m` : `${nearby.distKm.toFixed(1)} km`}
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

  {:else}
    {#if stopInfo.rows.length === 0}
      <p class="text-sm text-slate-400">No timetable data for this stop.</p>
    {:else}
      <div class="overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-slate-900">
            <tr class="text-[10px] uppercase tracking-wide text-slate-500">
              <th class="pb-2 text-left font-medium pr-3">Route</th>
              <th class="pb-2 text-left font-medium">Destination</th>
              <th class="pb-2 text-right font-medium">Departs</th>
            </tr>
          </thead>
          <tbody>
            {#each stopInfo.rows as row (row.key)}
              <tr
                class="border-t border-slate-700/40 hover:bg-slate-800 cursor-pointer transition-colors"
                onclick={() => onNavigate({ type: 'trip', tripId: row.tripId })}
              >
                <td class="py-1.5 pr-3">
                  {#if row.routeColor}
                    <span
                      class="inline-flex items-center gap-1.5 font-medium"
                      style="color: {row.routeColor}"
                    >{row.routeShort}</span>
                  {:else}
                    <span class="font-medium text-slate-200">{row.routeShort}</span>
                  {/if}
                </td>
                <td class="py-1.5 pr-3 text-slate-300 max-w-[160px] truncate">{row.destination}</td>
                <td class="py-1.5 text-right tabular-nums text-slate-200">{formatTime(row.time)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
{:else}
  <p class="text-sm text-slate-400">Stop not found.</p>
{/if}