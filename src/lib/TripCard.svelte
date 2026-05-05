<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import { formatTime } from './popupUtils';

  let {
    tripId,
    gtfsData,
    onNavigate,
  }: {
    tripId: string;
    gtfsData: GtfsData;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  const tripData = $derived.by(() => {
    const trip = gtfsData.trips.get(tripId);
    if (!trip) return null;
    const route = gtfsData.routes.get(trip.route_id);

    const stopTimes = gtfsData.stopTimes
      .filter(st => st.trip_id === tripId)
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map(st => ({
        ...st,
        stop: gtfsData.stops.get(st.stop_id),
      }));

    return { trip, route, stopTimes };
  });
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

  <p class="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Stops ({stopTimes.length})</p>

  {#if stopTimes.length === 0}
    <p class="text-sm text-slate-400">No stop data for this trip.</p>
  {:else}
    <div class="overflow-y-auto">
      <div class="relative">
        <!-- Timeline line -->
        <div class="absolute left-[5px] top-3 bottom-3 w-px bg-slate-700"></div>

        <div class="space-y-0">
          {#each stopTimes as st, i (st.stop_sequence)}
            <button
              class="relative w-full flex items-start gap-3 py-2 pl-1 pr-2 rounded-lg hover:bg-slate-800 text-left transition-colors group"
              onclick={() => onNavigate({ type: 'stop', stopId: st.stop_id })}
            >
              <!-- Timeline dot -->
              <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 z-10
                {i === 0 ? 'border-indigo-400 bg-indigo-400' : i === stopTimes.length - 1 ? 'border-emerald-400 bg-emerald-400' : 'border-slate-500 bg-slate-900 group-hover:border-slate-400'}">
              </span>

              <div class="flex-1 min-w-0">
                <p class="text-sm text-slate-200 truncate leading-snug">
                  {st.stop?.stop_name ?? st.stop_id}
                </p>
                <p class="text-[10px] text-slate-500">{st.stop_id}</p>
              </div>

              <div class="shrink-0 text-right tabular-nums">
                {#if st.arrival_time && st.departure_time && st.arrival_time !== st.departure_time}
                  <p class="text-xs text-slate-300">{formatTime(st.arrival_time)}</p>
                  <p class="text-[10px] text-slate-500">{formatTime(st.departure_time)}</p>
                {:else}
                  <p class="text-xs text-slate-300">{formatTime(st.departure_time || st.arrival_time)}</p>
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