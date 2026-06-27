<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { LiveData } from '../types/liveTypes';
  import type { ApiVehicleAssignment } from '../services/api';
  import { haversineKm, parseTimeMin } from '../services/popupUtils';
  import { makeEpochToMin, buildSortedPings, matchBlockPings } from '../services/schedule/schedulePings';
  import { pingCacheGet } from '../stores/pingDataCache';

  let {
    gtfsData,
    vehicleAssignments,
    liveData,
    date = '',
  }: {
    gtfsData: GtfsData;
    vehicleAssignments: ApiVehicleAssignment[];
    liveData: LiveData | null;
    date?: string;
  } = $props();

  const tz         = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');
  const epochToMin = $derived(makeEpochToMin(tz));

  const blockIds = $derived.by(() => {
    const ids = [...new Set(vehicleAssignments.map(a => a.block_id).filter(Boolean))];
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return ids;
  });

  interface BlockRow {
    blockId:          string;
    schedDurationMin: number;
    schedDistKm:      number;
    schedTrips:       number;
    obsDurationMin:   number;
    obsDistKm:        number;
    obsTrips:         number;
    hasLive:          boolean;
  }

  function computeBlock(blockId: string): BlockRow {
    const tripIds = vehicleAssignments
      .filter(a => a.block_id === blockId)
      .map(a => a.trip_id)
      .filter(tid => gtfsData.stopTimesByTrip.has(tid));

    const sorted = [...tripIds].sort((a, b) => {
      const aSts = gtfsData.stopTimesByTrip.get(a) ?? [];
      const bSts = gtfsData.stopTimesByTrip.get(b) ?? [];
      return (aSts[0] ? parseTimeMin(aSts[0].departure_time || aSts[0].arrival_time) : 0)
           - (bSts[0] ? parseTimeMin(bSts[0].departure_time || bSts[0].arrival_time) : 0);
    });

    const schedTrips = sorted.length;
    let schedDistKm  = 0;

    // Block duration = span from first stop of first trip to last stop of last trip
    const firstSts     = gtfsData.stopTimesByTrip.get(sorted[0] ?? '') ?? [];
    const lastSts      = gtfsData.stopTimesByTrip.get(sorted.at(-1) ?? '') ?? [];
    const schedBlockLo = firstSts[0]      ? parseTimeMin(firstSts[0].departure_time      || firstSts[0].arrival_time)         : 0;
    const schedBlockHi = lastSts.at(-1)   ? parseTimeMin(lastSts.at(-1)!.arrival_time    || lastSts.at(-1)!.departure_time)   : 0;
    const schedDurationMin = Math.max(0, schedBlockHi - schedBlockLo);

    for (let i = 0; i < sorted.length; i++) {
      const sts = gtfsData.stopTimesByTrip.get(sorted[i]) ?? [];

      // Route distance for this trip
      for (let s = 1; s < sts.length; s++) {
        const sA = gtfsData.stops.get(sts[s - 1].stop_id);
        const sB = gtfsData.stops.get(sts[s].stop_id);
        if (sA && sB)
          schedDistKm += haversineKm(sA.stop_lat, sA.stop_lon, sB.stop_lat, sB.stop_lon);
      }

      // Deadhead segment between trips
      if (i > 0) {
        const prevSts    = gtfsData.stopTimesByTrip.get(sorted[i - 1]) ?? [];
        const prevLast   = gtfsData.stops.get(prevSts.at(-1)?.stop_id ?? '');
        const currFirst  = gtfsData.stops.get(sts[0]?.stop_id ?? '');
        if (prevLast && currFirst)
          schedDistKm += haversineKm(prevLast.stop_lat, prevLast.stop_lon, currFirst.stop_lat, currFirst.stop_lon);
      }
    }

    const allPositions    = liveData?.vehiclePositions ?? [];
    const tripSet         = new Set(sorted);
    const taggedPings     = allPositions.filter(p => p.trip_id && tripSet.has(p.trip_id));
    const blockVehicleIds = new Set(taggedPings.map(p => p.vehicle_id).filter((v): v is string => !!v));
    const rawVehiclePings = blockVehicleIds.size > 0
      ? allPositions.filter(p => blockVehicleIds.has(p.vehicle_id!))
      : taggedPings;
    const hasLive = rawVehiclePings.length > 0;

    let obsDurationMin  = 0;
    let obsDistKm       = 0;
    let obsTrips        = 0;
    let obsBlockFirstT: number | null = null;
    let obsBlockLastT:  number | null = null;

    if (hasLive) {
      const sortedVehiclePings = buildSortedPings(rawVehiclePings, epochToMin);
      const pingData = pingCacheGet(blockId, date)?.pingData
        ?? matchBlockPings(sorted, sortedVehiclePings, gtfsData);

      for (const record of pingData.tripRecords) {
        const visited = record.stopMatches.filter(m => m.visited);
        if (visited.length === 0) continue;
        obsTrips++;

        // Track overall block span (first matched ping across all trips → last)
        const tFirst = visited[0].matchedPingT!;
        const tLast  = visited.at(-1)!.matchedPingT!;
        if (obsBlockFirstT === null || tFirst < obsBlockFirstT) obsBlockFirstT = tFirst;
        if (obsBlockLastT  === null || tLast  > obsBlockLastT)  obsBlockLastT  = tLast;

        for (let s = 1; s < record.stopMatches.length; s++) {
          if (record.stopMatches[s - 1].visited && record.stopMatches[s].visited)
            obsDistKm += record.stopMatches[s].cumDistKm - record.stopMatches[s - 1].cumDistKm;
        }
      }

      if (obsBlockFirstT !== null && obsBlockLastT !== null)
        obsDurationMin = Math.max(0, obsBlockLastT - obsBlockFirstT);
    }

    return { blockId, schedDurationMin, schedDistKm, schedTrips, obsDurationMin, obsDistKm, obsTrips, hasLive };
  }

  let rankedBlocks = $state<BlockRow[]>([]);
  let calculated   = $state(false);
  let calculating  = $state(false);

  function calculate() {
    calculating  = true;
    calculated   = false;
    rankedBlocks = [];
    setTimeout(() => {
      rankedBlocks = blockIds.map(bid => computeBlock(bid));
      calculated   = true;
      calculating  = false;
    }, 0);
  }

  function fmtDuration(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtDist(km: number): string {
    return `${km.toFixed(2)} km`;
  }
</script>

<div class="mx-auto max-w-7xl space-y-6 p-6">

  <!-- Controls -->
  <div class="flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
    <button
      onclick={calculate}
      disabled={calculating}
      class="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white
             hover:bg-indigo-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {#if calculating}
        <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
        </svg>
        Calculating…
      {:else}
        Calculate
      {/if}
    </button>
    <span class="text-xs text-slate-500">{blockIds.length} block{blockIds.length !== 1 ? 's' : ''}</span>
  </div>

  <!--
  === OLD SDI TABLE (commented out) ===
  <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-slate-800 bg-slate-900/60">
          <th>#</th><th>Block</th><th>SDI</th><th>A</th><th>L</th>
          <th>t</th><th>T</th><th>Obs.</th>
          <th>Trip Completion Penalties</th>
          <th>Punctuality Penalties</th>
          <th>Other Penalties</th>
        </tr>
      </thead>
      <tbody>...</tbody>
    </table>
  </div>
  -->

  <!-- Table -->
  {#if calculating}
    <div class="flex h-40 items-center justify-center gap-3 text-sm text-slate-500">
      <svg class="h-4 w-4 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
      </svg>
      Computing metrics for {blockIds.length} block{blockIds.length !== 1 ? 's' : ''}…
    </div>
  {:else if !calculated}
    <div class="flex h-40 items-center justify-center text-sm text-slate-500">
      Press
      <span class="mx-1.5 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">Calculate</span>
      to compute block metrics.
    </div>
  {:else if rankedBlocks.length === 0}
    <div class="flex h-40 items-center justify-center text-sm text-slate-500">No schedule data available.</div>
  {:else}
    <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-700 bg-slate-900/80">
            <th colspan="2" class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500"></th>
            <th colspan="3" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">Scheduled</th>
            <th colspan="4" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70">Observed</th>
            <th colspan="4" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-orange-400/70">Penalties</th>
          </tr>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">#</th>
            <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Block</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Sum of trip durations">Duration</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Route distance including inter-trip segments">Distance</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Number of scheduled trips">Trips</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Block span from first matched stop of first trip to last matched stop of last trip">Duration</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Distance based on visited stop segments">Distance</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trips with at least one matched stop">Trips</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">SDI</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trip punctuality penalties">Punct.</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trip completion penalties">Completion</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Data availability penalties">Data Avail.</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Total</th>
          </tr>
        </thead>
        <tbody>
          {#each rankedBlocks as row, i (row.blockId)}
            <tr class="border-b border-slate-800/60 transition-colors hover:bg-slate-800/30">
              <td class="px-3 py-2.5 text-xs text-slate-600">{i + 1}</td>
              <td class="px-3 py-2.5 font-mono text-xs font-medium text-slate-300">{row.blockId}</td>

              <!-- Scheduled -->
              <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-400">
                {fmtDuration(row.schedDurationMin)}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">
                {fmtDist(row.schedDistKm)}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">
                {row.schedTrips}
              </td>

              <!-- Observed -->
              <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs {row.hasLive ? 'text-slate-300' : 'text-slate-600'}">
                {row.hasLive ? fmtDuration(row.obsDurationMin) : '—'}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs {row.hasLive ? 'text-slate-300' : 'text-slate-600'}">
                {row.hasLive ? fmtDist(row.obsDistKm) : '—'}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs {row.hasLive ? (row.obsTrips < row.schedTrips ? 'text-orange-400' : 'text-slate-300') : 'text-slate-600'}">
                {row.hasLive ? `${row.obsTrips} / ${row.schedTrips}` : '—'}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-600">—</td>

              <!-- Penalties -->
              <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-600">—</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-600">—</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-600">—</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-600">—</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <p class="text-[11px] text-slate-600">
      Observed values derived from stop match ping times and served stop segments. Penalty columns to be implemented.
    </p>
  {/if}
</div>