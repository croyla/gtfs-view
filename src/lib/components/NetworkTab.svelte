<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { LiveData } from '../types/liveTypes';
  import type { ApiVehicleAssignment } from '../services/api';
  import { haversineKm, parseTimeMin } from '../services/popupUtils';
  import { makeEpochToMin, buildSortedPings, matchBlockPings } from '../services/schedule/schedulePings';
  import {
    computeBlockMetrics,
    DATA_AVAIL_THRESHOLD,
    DATA_AVAIL_PENALTY_PCT,
    PUNCT_START_THRESHOLD_PCT,
    PUNCT_END_THRESHOLD_PCT,
    type BlockMetrics,
  } from '../services/schedule/scheduleMetrics';
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

  interface BlockDataAvail {
    expectedPings:   number;
    observedPings:   number;
    availabilityPct: number;
    penaltyPct:      number;
  }

  interface BlockRow {
    blockId:              string;
    schedDurationMin:     number;
    schedDistKm:          number;
    schedTrips:           number;
    obsDurationMin:       number;
    obsDistKm:            number;
    obsTrips:             number;
    hasLive:              boolean;
    // Penalties (null = no live data)
    completionPenaltyKm:  number | null;
    punctPenaltyPct:      number | null;
    dataAvailPenaltyPct:  number | null;
    blockDataAvail:       BlockDataAvail | null;
    metrics:              BlockMetrics | null;
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

    const firstSts      = gtfsData.stopTimesByTrip.get(sorted[0] ?? '') ?? [];
    const lastSts       = gtfsData.stopTimesByTrip.get(sorted.at(-1) ?? '') ?? [];
    const schedBlockLo  = firstSts[0]    ? parseTimeMin(firstSts[0].departure_time   || firstSts[0].arrival_time)       : 0;
    const schedBlockHi  = lastSts.at(-1) ? parseTimeMin(lastSts.at(-1)!.arrival_time || lastSts.at(-1)!.departure_time) : 0;
    const schedDurationMin = Math.max(0, schedBlockHi - schedBlockLo);

    for (let i = 0; i < sorted.length; i++) {
      const sts = gtfsData.stopTimesByTrip.get(sorted[i]) ?? [];
      for (let s = 1; s < sts.length; s++) {
        const sA = gtfsData.stops.get(sts[s - 1].stop_id);
        const sB = gtfsData.stops.get(sts[s].stop_id);
        if (sA && sB) schedDistKm += haversineKm(sA.stop_lat, sA.stop_lon, sB.stop_lat, sB.stop_lon);
      }
      if (i > 0) {
        const prevSts   = gtfsData.stopTimesByTrip.get(sorted[i - 1]) ?? [];
        const prevLast  = gtfsData.stops.get(prevSts.at(-1)?.stop_id ?? '');
        const currFirst = gtfsData.stops.get(sts[0]?.stop_id ?? '');
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

    let obsDurationMin = 0;
    let obsDistKm      = 0;
    let obsTrips       = 0;
    let metrics: BlockMetrics | null = null;

    if (hasLive) {
      const sortedVehiclePings = buildSortedPings(rawVehiclePings, epochToMin);
      const pingData = pingCacheGet(blockId, date)?.pingData
        ?? matchBlockPings(sorted, sortedVehiclePings, gtfsData);

      metrics = computeBlockMetrics(pingData, taggedPings, gtfsData);

      let obsBlockFirstT: number | null = null;
      let obsBlockLastT:  number | null = null;

      for (const record of metrics.tripRecords) {
        const visited = record.stopMatches.filter(m => m.visited);
        if (visited.length === 0) continue;
        obsTrips++;
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

    // ── Penalty derivations ───────────────────────────────────────────────────
    let completionPenaltyKm: number | null = null;
    let punctPenaltyPct:     number | null = null;
    let dataAvailPenaltyPct: number | null = null;
    let blockDataAvail:      BlockDataAvail | null = null;

    if (metrics) {
      // Completion: sum of (served km × penalty fraction) across all trips
      completionPenaltyKm = metrics.completions.reduce((sum, c) => {
        const servedKm = c.scheduledKm - c.lostKm;
        return sum + servedKm * c.penaltyPct / 100;
      }, 0);

      // Punctuality: block-level d*2 formula
      punctPenaltyPct = metrics.blockPunctPenalty.totalPenaltyPct;

      // Data availability: (98 - blockAvail%) × 1% per point
      const totalObs = metrics.dataAvailability.trips.reduce((s, t) => s + t.pingCount,     0);
      const totalExp = metrics.dataAvailability.trips.reduce((s, t) => s + t.expectedPings, 0);
      const availabilityPct = totalExp > 0
        ? Math.min(100, totalObs / totalExp * 100)
        : (totalObs > 0 ? 100 : 0);
      const penaltyPct = Math.max(0, DATA_AVAIL_THRESHOLD - availabilityPct) * DATA_AVAIL_PENALTY_PCT;
      dataAvailPenaltyPct = penaltyPct;
      blockDataAvail = { expectedPings: totalExp, observedPings: totalObs, availabilityPct, penaltyPct };
    }

    return {
      blockId, schedDurationMin, schedDistKm, schedTrips,
      obsDurationMin, obsDistKm, obsTrips, hasLive,
      completionPenaltyKm, punctPenaltyPct, dataAvailPenaltyPct, blockDataAvail, metrics,
    };
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

  function fmtPct(v: number | null, decimals = 1): string {
    return v === null ? '—' : `${v.toFixed(decimals)}%`;
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

    <!-- ── Block overview table ────────────────────────────────────────────── -->
    <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-700 bg-slate-900/80">
            <th colspan="2" class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500"></th>
            <th colspan="3" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">Scheduled</th>
            <th colspan="4" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70">Observed</th>
            <th colspan="3" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-orange-400/70">Penalties</th>
          </tr>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">#</th>
            <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Block</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Duration</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Distance</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Trips</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Duration</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Distance</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Trips</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">SDI</th>

            <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Punctuality penalty (%)">Punct.</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trip completion penalty km">Completion</th>
            <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Data availability penalty (% of monthly fee)">Data Avail.</th>
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
              <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                {fmtPct(row.punctPenaltyPct)}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                {(row.completionPenaltyKm ?? 0).toFixed(2)} km
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                {row.dataAvailPenaltyPct === null ? '—' : row.dataAvailPenaltyPct > 0 ? `−${row.dataAvailPenaltyPct.toFixed(1)}%/mo` : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- ── Trip Punctuality Penalties table ───────────────────────────────── -->
    <section>
      <div class="mb-3 flex items-baseline gap-3">
        <h2 class="text-sm font-semibold text-slate-200">Trip Punctuality Penalties</h2>
        <span class="text-xs text-slate-500">
          Start ≥{PUNCT_START_THRESHOLD_PCT}% on time · End ≥{PUNCT_END_THRESHOLD_PCT}% on time · penalty = (threshold − actual) × 2
        </span>
      </div>

      <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-700 bg-slate-900/80">
              <th colspan="2" class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500"></th>
              <th colspan="2" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70">On Time</th>
              <th colspan="3" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-orange-400/70">Penalty</th>
            </tr>
            <tr class="border-b border-slate-800 bg-slate-900/60">
              <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">#</th>
              <th class="px-3 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Block</th>
              <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Total Trips</th>

              <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trips starting within threshold window">Start</th>
              <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Trips ending within threshold window">End</th>

              <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500" title="(90% − actual%) × 2">Start %</th>
              <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="(80% − actual%) × 2">End %</th>
              <th class="px-3 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Total %</th>
            </tr>
          </thead>
          <tbody>
            {#each rankedBlocks as row, i (row.blockId)}
              {@const pp = row.metrics?.blockPunctPenalty ?? null}
              <tr class="border-b border-slate-800/60 transition-colors hover:bg-slate-800/30">
                <td class="px-3 py-2.5 text-xs text-slate-600">{i + 1}</td>
                <td class="px-3 py-2.5 font-mono text-xs font-medium text-slate-300">{row.blockId}</td>
                <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-400">
                  {pp ? pp.totalTrips : '—'}
                </td>

                <!-- On time counts -->
                <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs">
                  {#if pp}
                    <span class="text-slate-300">{pp.onTimeStartCount} / {pp.totalTrips}</span>
                    <span class="ml-1 text-slate-600">({pp.onTimeStartPct.toFixed(0)}%)</span>
                  {:else}
                    <span class="text-slate-600">—</span>
                  {/if}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs">
                  {#if pp}
                    <span class="text-slate-300">{pp.onTimeEndCount} / {pp.totalTrips}</span>
                    <span class="ml-1 text-slate-600">({pp.onTimeEndPct.toFixed(0)}%)</span>
                  {:else}
                    <span class="text-slate-600">—</span>
                  {/if}
                </td>

                <!-- Penalty % -->
                <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                  {pp ? fmtPct(pp.startPenaltyPct) : '—'}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                  {pp ? fmtPct(pp.endPenaltyPct) : '—'}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs font-semibold text-slate-300">
                  {pp ? fmtPct(pp.totalPenaltyPct) : '—'}
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr class="border-t border-slate-700 bg-slate-900/60">
              <td colspan="5" class="px-3 py-2 text-right text-[10px] text-slate-400">
                Thresholds: start ≥{PUNCT_START_THRESHOLD_PCT}% · end ≥{PUNCT_END_THRESHOLD_PCT}%
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-300">
                {#if rankedBlocks.some(r => r.metrics)}
                  {fmtPct(rankedBlocks.reduce((s, r) => s + (r.metrics?.blockPunctPenalty.startPenaltyPct ?? 0), 0))}
                {:else}—{/if}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-300">
                {#if rankedBlocks.some(r => r.metrics)}
                  {fmtPct(rankedBlocks.reduce((s, r) => s + (r.metrics?.blockPunctPenalty.endPenaltyPct ?? 0), 0))}
                {:else}—{/if}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-300">
                {#if rankedBlocks.some(r => r.metrics)}
                  {fmtPct(rankedBlocks.reduce((s, r) => s + (r.metrics?.blockPunctPenalty.totalPenaltyPct ?? 0), 0))}
                {:else}—{/if}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="mt-2 text-[11px] text-slate-600">
        On-time thresholds from <code class="font-mono">SchedulePenalties</code> settings (start ±5 min, end ±10 min).
        Trips with no position data count as not on time.
      </p>
    </section>

    <!-- ── Data Availability table ────────────────────────────────────────── -->
    <section>
      <div class="mb-3 flex items-baseline gap-3">
        <h2 class="text-sm font-semibold text-slate-200">Data Availability</h2>
        <span class="text-xs text-slate-500">
          &lt;{DATA_AVAIL_THRESHOLD}% → {DATA_AVAIL_PENALTY_PCT}% penalty per lost point
        </span>
      </div>

      <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-700 bg-slate-900/80">
              <th colspan="2" class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500"></th>
              <th colspan="3" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-indigo-400/70">Pings</th>
              <th colspan="2" class="border-l border-slate-700 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-orange-400/70">Penalty</th>
            </tr>
            <tr class="border-b border-slate-800 bg-slate-900/60">
              <th class="px-3 py-2.5 text-left  text-[11px] font-medium uppercase tracking-wider text-slate-500">#</th>
              <th class="px-3 py-2.5 text-left  text-[11px] font-medium uppercase tracking-wider text-slate-500">Block</th>
              <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Expected</th>
              <th class="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Observed</th>
              <th class="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Availability</th>
              <th class="border-l border-slate-800 px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Penalty %</th>
              <th class="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Fee Impact</th>
            </tr>
          </thead>
          <tbody>
            {#each rankedBlocks as row, i (row.blockId)}
              {@const da = row.blockDataAvail}
              <tr class="border-b border-slate-800/60 transition-colors hover:bg-slate-800/30">
                <td class="px-3 py-2.5 text-xs text-slate-600">{i + 1}</td>
                <td class="px-3 py-2.5 font-mono text-xs font-medium text-slate-300">{row.blockId}</td>
                <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-600">
                  {da ? da.expectedPings : '—'}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">
                  {da ? da.observedPings : '—'}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                  {da ? `${da.availabilityPct.toFixed(1)}%` : '—'}
                </td>
                <td class="border-l border-slate-800/40 px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                  {da ? fmtPct(da.penaltyPct) : '—'}
                </td>
                <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-300">
                  {da && da.penaltyPct > 0 ? `−${da.penaltyPct.toFixed(1)}%/mo` : '—'}
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr class="border-t border-slate-700 bg-slate-900/60">
              <td colspan="5" class="px-3 py-2 text-right text-[10px] text-slate-400">
                Threshold: ≥{DATA_AVAIL_THRESHOLD}% availability required
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-300">
                {#if rankedBlocks.some(r => r.blockDataAvail)}
                  {fmtPct(rankedBlocks.reduce((s, r) => s + (r.blockDataAvail?.penaltyPct ?? 0), 0))}
                {:else}—{/if}
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-300">
                {#if rankedBlocks.some(r => r.blockDataAvail)}
                  {@const total = rankedBlocks.reduce((s, r) => s + (r.blockDataAvail?.penaltyPct ?? 0), 0)}
                  {total > 0 ? `−${total.toFixed(1)}%/mo` : '—'}
                {:else}—{/if}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

  {/if}
</div>