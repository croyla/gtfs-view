<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { CardEntry } from '../types/popupTypes';
  import type { LiveProcessed, LiveStopTime } from '../services/live/liveStopTimes';
  import { computeMetrics } from '../services/live/liveStopTimes';
  import { formatTime } from '../services/popupUtils';

  let {
    tripId,
    gtfsData,
    liveProcessed = null,
    onNavigate,
  }: {
    tripId: string;
    gtfsData: GtfsData;
    liveProcessed?: LiveProcessed | null;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  const tripData = $derived.by(() => {
    const trip = gtfsData.trips.get(tripId);
    if (!trip) return null;
    const route = gtfsData.routes.get(trip.route_id);
    const stopTimes = (gtfsData.stopTimesByTrip.get(tripId) ?? []).map(st => ({
      ...st,
      stop: gtfsData.stops.get(st.stop_id),
    }));
    return { trip, route, stopTimes };
  });

  // Per-stop live data lookup
  const liveByStop = $derived.by((): Map<string, LiveStopTime> => {
    if (!liveProcessed) return new Map();
    const liveSTs = liveProcessed.byTrip.get(tripId) ?? [];
    const m = new Map<string, LiveStopTime>();
    for (const lst of liveSTs) m.set(lst.stop_id, lst);
    return m;
  });

  // Overall trip metrics
  const liveMetrics = $derived.by(() => {
    if (!liveProcessed) return null;
    const liveSTs = liveProcessed.byTrip.get(tripId) ?? [];
    const scheduled = liveProcessed.scheduledTripIds.has(tripId)
      ? new Set([tripId])
      : new Set<string>();
    return computeMetrics(liveSTs, scheduled, liveProcessed.observedTripIds);
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

  function fmtDeviation(s: number): string {
    const abs = Math.abs(s);
    const m = Math.floor(abs / 60);
    const sec = Math.round(abs % 60);
    if (m === 0) return `${sec}s`;
    return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
  }
</script>

{#if tripData}
  {@const { trip, route, stopTimes } = tripData}
  <div class="mb-4 space-y-0.5">
    {#if trip.trip_headsign}
      <p class="text-xs text-slate-400">Towards <span class="text-slate-200">{trip.trip_headsign}</span></p>
    {/if}
    <p class="text-xs text-slate-500">
      {route?.route_short_name ? `Route ${route.route_short_name}` : ''}
      {route?.route_long_name ? `· ${route.route_long_name}` : ''}
      {#if !route?.route_short_name && !route?.route_long_name}
        Route {trip.route_id}
      {/if}
    </p>
  </div>

  <!-- Live metrics -->
  {#if liveMetrics}
    <div class="mb-4">
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
  {/if}

  <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Stops ({stopTimes.length})</p>

  {#if stopTimes.length === 0}
    <p class="text-sm text-slate-400">No stop data for this trip.</p>
  {:else}
    <div class="overflow-y-auto">
      <div class="relative">
        <div class="absolute left-[5px] top-3 bottom-3 w-px bg-slate-700"></div>
        <div class="space-y-0">
          {#each stopTimes as st, i (st.stop_sequence)}
            {@const lst = liveByStop.get(st.stop_id)}
            <button
              class="relative w-full flex items-start gap-3 py-2 pl-1 pr-2 rounded-lg hover:bg-slate-800 text-left transition-colors group"
              onclick={() => onNavigate({ type: 'stop', stopId: st.stop_id })}
            >
              <!-- Timeline dot -->
              <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 z-10
                {lst?.visited ? 'border-emerald-500 bg-emerald-500' :
                 lst?.skipped ? 'border-orange-500 bg-orange-500' :
                 i === 0 ? 'border-indigo-400 bg-indigo-400' :
                 i === stopTimes.length - 1 ? 'border-emerald-400 bg-emerald-400' :
                 'border-slate-500 bg-slate-900 group-hover:border-slate-400'}">
              </span>

              <div class="flex-1 min-w-0">
                <p class="text-sm text-slate-200 truncate leading-snug">
                  {st.stop?.stop_name ?? st.stop_id}
                </p>
                <p class="text-[10px] text-slate-500">{st.stop_id}</p>
              </div>

              <div class="shrink-0 flex flex-col items-end gap-0.5">
                <!-- Schedule time -->
                {#if st.arrival_time && st.departure_time && st.arrival_time !== st.departure_time}
                  <p class="text-xs text-slate-300 tabular-nums">{formatTime(st.arrival_time)}</p>
                  <p class="text-[10px] text-slate-500 tabular-nums">{formatTime(st.departure_time)}</p>
                {:else}
                  <p class="text-xs text-slate-300 tabular-nums">{formatTime(st.departure_time || st.arrival_time)}</p>
                {/if}

                <!-- Live status badge -->
                {#if lst}
                  {#if lst.skipped}
                    <span class="rounded px-1 py-0.5 text-[9px] font-medium bg-orange-950/60 text-orange-400">Skipped</span>
                  {:else if lst.visited}
                    {#if lst.on_time === true}
                      <span class="rounded px-1 py-0.5 text-[9px] font-medium bg-emerald-950/60 text-emerald-400">On time</span>
                    {:else if lst.on_time === false && lst.deviation_s !== null}
                      {#if lst.deviation_s > 0}
                        <span class="rounded px-1 py-0.5 text-[9px] font-medium bg-red-950/60 text-red-400">+{fmtDeviation(lst.deviation_s)}</span>
                      {:else}
                        <span class="rounded px-1 py-0.5 text-[9px] font-medium bg-sky-950/60 text-sky-400">-{fmtDeviation(lst.deviation_s)}</span>
                      {/if}
                    {:else}
                      <span class="rounded px-1 py-0.5 text-[9px] font-medium bg-emerald-950/60 text-emerald-400">Visited</span>
                    {/if}
                  {/if}
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
{:else}
  <p class="text-sm text-slate-400">Trip not found.</p>
{/if}
