<script lang="ts">
  import TripMapPopup from './TripMapPopup.svelte';

  export interface TripStopDetail {
    seq:      number;
    stopName: string;
    schedMin: number;
    obsT:     number | null;
    visited:  boolean;
  }

  export interface TripCompletion {
    idx:            number;
    tid:            string;
    scheduledStops: number;
    scheduledKm:    number;
    ranKm:          number;
    lostKm:         number;
    penaltyPct:     number;
    penaltyKm:      number;
    payableKm:      number;
    stops:          TripStopDetail[];
    mapStops:        Array<{ lat: number; lon: number; name: string; visited: boolean }>;
    mapPings:        Array<{ lat: number; lon: number }>;
    mapMatchedPings: Array<{ lat: number; lon: number } | null>;
  }

  let { trips }: { trips: TripCompletion[] } = $props();

  let expandedIdxs = $state(new Set<number>());
  let mapTripIdx   = $state<number | null>(null);

  const mapTrip = $derived(mapTripIdx !== null ? trips.find(t => t.idx === mapTripIdx) ?? null : null);

  function toggleExpand(idx: number) {
    const next = new Set(expandedIdxs);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    expandedIdxs = next;
  }

  function openMap(e: MouseEvent, idx: number) {
    e.stopPropagation();
    mapTripIdx = idx;
  }

  function fmtKm(km: number): string { return km.toFixed(3); }

  function fmtMin(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.floor(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function fmtObs(t: number | null): string {
    return t === null ? '—' : fmtMin(t);
  }

  function penaltyClass(pct: number): string {
    if (pct === 0)  return 'text-emerald-400';
    if (pct <= 50)  return 'text-yellow-400';
    if (pct <= 75)  return 'text-orange-400';
    return 'text-red-400';
  }
</script>

{#if mapTrip}
  <TripMapPopup
    tripIdx={mapTrip.idx}
    tripId={mapTrip.tid}
    stops={mapTrip.mapStops}
    pings={mapTrip.mapPings}
    matchedPings={mapTrip.mapMatchedPings}
    onClose={() => (mapTripIdx = null)}
  />
{/if}

<div class="overflow-x-auto">
  <table class="w-full text-xs">
    <thead>
      <tr class="border-b border-slate-800 bg-slate-950/40">
        <th class="w-6 px-2 py-2"></th>
        <th class="px-3 py-2 text-left   text-[10px] font-medium uppercase tracking-wider text-slate-500">Trip #</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Sched Stops</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Sched KM</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Ran KM</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Lost KM</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Penalty %</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Penalty KM</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Payable KM</th>
        <th class="w-8 px-2 py-2"></th>
      </tr>
    </thead>
    <tbody>
      {#each trips as trip (trip.idx)}
        {@const expanded = expandedIdxs.has(trip.idx)}
        <tr
          class="cursor-pointer border-b border-slate-800/40 transition-colors hover:bg-slate-800/30"
          onclick={() => toggleExpand(trip.idx)}
        >
          <td class="px-2 py-2 text-center text-slate-500">
            <svg class="inline h-3 w-3 transition-transform {expanded ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="none">
              <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </td>
          <td class="px-3 py-2 font-mono text-slate-400">{trip.idx}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-400">{trip.scheduledStops}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-400">{fmtKm(trip.scheduledKm)}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-300">{fmtKm(trip.ranKm)}</td>
          <td class="px-3 py-2 text-right font-mono {trip.lostKm > 0.001 ? 'text-orange-400' : 'text-slate-600'}">{fmtKm(trip.lostKm)}</td>
          <td class="px-3 py-2 text-right font-mono font-semibold {penaltyClass(trip.penaltyPct)}">{trip.penaltyPct}%</td>
          <td class="px-3 py-2 text-right font-mono {trip.penaltyKm > 0.001 ? 'text-red-400' : 'text-slate-600'}">{fmtKm(trip.penaltyKm)}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-300">{fmtKm(trip.payableKm)}</td>
          <td class="px-2 py-2 text-center">
            <button
              onclick={(e) => openMap(e, trip.idx)}
              title="View on map"
              class="flex h-6 w-6 items-center justify-center rounded text-slate-500
                     hover:bg-slate-700 hover:text-indigo-400 transition-colors"
            >
              <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round"
                      d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.159.69.159 1.006 0Z"/>
              </svg>
            </button>
          </td>
        </tr>
        {#if expanded}
          <tr class="border-b border-slate-800/40">
            <td colspan="10" class="p-0">
              <div class="bg-slate-950/70 px-10 py-2">
                <table class="w-full">
                  <thead>
                    <tr class="border-b border-slate-800/60">
                      <th class="px-2 py-1.5 text-left   text-[10px] font-medium uppercase tracking-wider text-slate-600">Seq</th>
                      <th class="px-2 py-1.5 text-left   text-[10px] font-medium uppercase tracking-wider text-slate-600">Stop Name</th>
                      <th class="px-2 py-1.5 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-600">Sched Time</th>
                      <th class="px-2 py-1.5 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-600">Obs Ping Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each trip.stops as stop (stop.seq)}
                      <tr class="border-b border-slate-800/20 {stop.visited ? '' : 'opacity-40'}">
                        <td class="px-2 py-1 font-mono text-slate-600">{stop.seq}</td>
                        <td class="px-2 py-1 {stop.visited ? 'text-slate-400' : 'text-slate-600 line-through'}">{stop.stopName || stop.seq}</td>
                        <td class="px-2 py-1 text-right font-mono text-slate-500">{fmtMin(stop.schedMin)}</td>
                        <td class="px-2 py-1 text-right font-mono {stop.visited ? 'text-slate-300' : 'text-slate-700'}">{fmtObs(stop.obsT)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>
