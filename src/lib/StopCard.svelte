<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import type { LiveProcessed } from './liveStopTimes';
  import { computeMetrics } from './liveStopTimes';
  import { haversineKm, formatTime, parseTimeMin } from './popupUtils';

  let {
    stopId,
    gtfsData,
    liveProcessed = null,
    onNavigate,
  }: {
    stopId: string;
    gtfsData: GtfsData;
    liveProcessed?: LiveProcessed | null;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  let activeTab = $state<'overview' | 'timetable'>('overview');

  const stop = $derived(gtfsData.stops.get(stopId));

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
    return { tripCount: rows.length, routeCount: routeIds.size, routeIds, rows };
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

  // Overall live metrics for this stop
  const liveMetrics = $derived.by(() => {
    if (!liveProcessed) return null;
    const liveSTs = liveProcessed.byStop.get(stopId) ?? [];
    const scheduled = liveProcessed.scheduledByStop.get(stopId) ?? new Set<string>();
    return computeMetrics(liveSTs, scheduled, liveProcessed.observedTripIds);
  });

  // Per-route breakdown
  const routeMetrics = $derived.by(() => {
    if (!liveProcessed || !stopInfo) return [];
    const result: {
      routeId: string;
      routeShort: string;
      routeColor: string | undefined;
      metrics: ReturnType<typeof computeMetrics>;
    }[] = [];

    for (const routeId of stopInfo.routeIds) {
      const route = gtfsData.routes.get(routeId);
      // Live stop times at this stop for this route
      const liveSTs = (liveProcessed.byStop.get(stopId) ?? []).filter(s => s.route_id === routeId);
      // Scheduled trips at this stop for this route
      const scheduledAtStop = liveProcessed.scheduledByStop.get(stopId) ?? new Set<string>();
      const scheduledForRoute = liveProcessed.scheduledByRoute.get(routeId) ?? new Set<string>();
      const scheduled = new Set<string>();
      for (const id of scheduledAtStop) {
        if (scheduledForRoute.has(id)) scheduled.add(id);
      }
      const observedForRoute = new Set(liveSTs.map(s => s.trip_id));
      result.push({
        routeId,
        routeShort: route?.route_short_name || routeId,
        routeColor: route?.route_color,
        metrics: computeMetrics(liveSTs, scheduled, observedForRoute),
      });
    }
    return result.sort((a, b) => a.routeShort.localeCompare(b.routeShort));
  });

  function pctColor(v: number | null) {
    if (v === null) return 'text-slate-500';
    if (v >= 80) return 'text-emerald-400';
    if (v >= 60) return 'text-amber-400';
    return 'text-red-400';
  }

  function fmtPct(v: number | null) {
    return v === null ? '—' : `${v.toFixed(0)}%`;
  }

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

      <!-- Live metrics -->
      {#if liveMetrics}
        <div>
          <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Live performance</p>
          <div class="grid grid-cols-3 gap-2">
            {#each [
              { label: 'Operation',   value: liveMetrics.operationPct },
              { label: 'Reliability', value: liveMetrics.reliabilityPct },
              { label: 'Timeliness',  value: liveMetrics.timelinessPct },
            ] as metric (metric.label)}
              <div class="rounded-lg bg-slate-800 px-2.5 py-2 text-center">
                <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{metric.label}</p>
                <p class="text-lg font-bold tabular-nums {pctColor(metric.value)}">{fmtPct(metric.value)}</p>
              </div>
            {/each}
          </div>
        </div>

        <!-- Per-route breakdown -->
        {#if routeMetrics.length > 1}
          <div>
            <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-2">By route</p>
            <div class="space-y-1.5">
              {#each routeMetrics as rm (rm.routeId)}
                <div class="rounded-lg bg-slate-800 px-3 py-2">
                  <div class="flex items-center gap-2 mb-1">
                    {#if rm.routeColor}
                      <span class="h-2 w-2 shrink-0 rounded-sm" style="background:{rm.routeColor}"></span>
                    {/if}
                    <button
                      class="text-xs font-medium text-slate-300 hover:text-white transition-colors"
                      onclick={() => onNavigate({ type: 'route', routeId: rm.routeId })}
                    >{rm.routeShort}</button>
                  </div>
                  <div class="flex gap-2">
                    {#each [
                      { label: 'Op', value: rm.metrics.operationPct },
                      { label: 'Rel', value: rm.metrics.reliabilityPct },
                      { label: 'Time', value: rm.metrics.timelinessPct },
                    ] as m (m.label)}
                      <span class="text-[10px] {pctColor(m.value)}">{m.label} {fmtPct(m.value)}</span>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

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
