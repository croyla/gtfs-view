<script lang="ts">
  import type { GtfsData } from './types';
  import type { LiveData } from './liveTypes';
  import type { ApiVehicleAssignment } from './api';
  import { haversineKm, parseTimeMin } from './popupUtils';
  import { makeEpochToMin, buildSortedPings, matchBlockPings } from './schedulePings';
  import { computeBlockMetrics, DEFAULT_PUNCT_SETTINGS } from './scheduleMetrics';
  import { pingCacheGet, pingCacheSet } from './pingDataCache';

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

  let constantC = $state(1.0);

  const tz         = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');
  const epochToMin = $derived(makeEpochToMin(tz));

  const blockIds = $derived.by(() => {
    const ids = [...new Set(vehicleAssignments.map(a => a.block_id).filter(Boolean))];
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return ids;
  });

  interface TripCompletionSummary { tiers: Record<string, number>; totalPenaltyTrips: number }
  interface BlockRow {
    blockId:    string;
    T:          number;
    L:          number;
    A:          number;
    t:          number;
    sdi:        number | null;
    observations: number;
    hasLive:    boolean;
    tcSummary:  TripCompletionSummary;
    punctNetPct:number;       // net % of monthly fee (positive = deduction)
    dataPenPct: number;       // total % of monthly fee
  }

  function computeBlock(blockId: string, C: number): BlockRow {
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

    const T = sorted.length;

    let L = 0;
    if (sorted.length > 0) {
      const fSts = gtfsData.stopTimesByTrip.get(sorted[0]) ?? [];
      const lSts = gtfsData.stopTimesByTrip.get(sorted.at(-1)!) ?? [];
      const lo = fSts[0]     ? parseTimeMin(fSts[0].departure_time     || fSts[0].arrival_time)         : 0;
      const hi = lSts.at(-1) ? parseTimeMin(lSts.at(-1)!.arrival_time || lSts.at(-1)!.departure_time) : 0;
      L = Math.max(0, hi - lo);
    }

    const allPositions = liveData?.vehiclePositions ?? [];
    const tripSet      = new Set(sorted);
    const taggedPings  = allPositions.filter(p => p.trip_id && tripSet.has(p.trip_id));
    const blockVehicleIds = new Set(taggedPings.map(p => p.vehicle_id).filter(v => !!v));
    const rawVehiclePings = blockVehicleIds.size > 0
      ? allPositions.filter(p => blockVehicleIds.has(p.vehicle_id))
      : taggedPings;
    const hasLive = rawVehiclePings.length > 0;

    // Build sorted ping arrays once — used by binary-search matching
    const sortedVehiclePings = buildSortedPings(rawVehiclePings, epochToMin);
    const sortedTaggedPings  = buildSortedPings(taggedPings,     epochToMin);

    // SDI component A: deviation of tagged pings from nearest scheduled stop.
    // Pre-compute stop positions + schedMin per trip to avoid repeated Map lookups.
    let sumSq = 0, observations = 0;
    type StopInfo = { lat: number; lon: number; schedMin: number };
    const stopCache = new Map<string, StopInfo[]>();
    for (const pw of sortedTaggedPings) {
      const tid = pw.p.trip_id!;
      let stops = stopCache.get(tid);
      if (!stops) {
        const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
        stops = [];
        for (const st of sts) {
          const s = gtfsData.stops.get(st.stop_id);
          if (s) stops.push({ lat: s.stop_lat, lon: s.stop_lon, schedMin: parseTimeMin(st.arrival_time || st.departure_time) });
        }
        stopCache.set(tid, stops);
      }
      let minDist = Infinity, nearestSchedMin: number | null = null;
      for (const s of stops) {
        const d = haversineKm(s.lat, s.lon, pw.p.lat, pw.p.lon);
        if (d < minDist) { minDist = d; nearestSchedMin = s.schedMin; }
      }
      if (nearestSchedMin !== null) { sumSq += (pw.t - nearestSchedMin) ** 2; observations++; }
    }
    const A = Math.sqrt(sumSq);

    const pingData   = pingCacheGet(blockId, date) ?? (() => {
      const pd = matchBlockPings(sorted, sortedVehiclePings, gtfsData);
      pingCacheSet(blockId, date, pd);
      return pd;
    })();
    const metrics    = computeBlockMetrics(pingData, taggedPings, gtfsData);
    const t          = hasLive ? metrics.skippedCount : 0;
    const sdi        = hasLive && L > 0 && T > 0 ? (A / L) + (C * t / T) : null;

    const tiers: Record<string, number> = {};
    let totalPenaltyTrips = 0;
    for (const r of metrics.completions) {
      if (r.tier !== 'complete' && r.tier !== 'no-data') {
        tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
        totalPenaltyTrips++;
      }
    }

    return {
      blockId,
      T, L: Math.round(L), A, t,
      sdi, observations, hasLive,
      tcSummary:  { tiers, totalPenaltyTrips },
      punctNetPct: metrics.punctuality.totalNetPct,
      dataPenPct:  metrics.dataAvailability.totalPenaltyPct,
    };
  }

  let rankedBlocks = $state<BlockRow[]>([]);
  let calculated   = $state(false);
  let calculating  = $state(false);

  function calculate() {
    calculating  = true;
    calculated   = false;
    rankedBlocks = [];
    // Defer computation by one frame so the loading state renders first
    setTimeout(() => {
      const C = constantC;
      const rows = blockIds.map(bid => computeBlock(bid, C));
      rows.sort((a, b) => {
        if (a.sdi === null && b.sdi === null) return 0;
        if (a.sdi === null) return 1;
        if (b.sdi === null) return -1;
        return a.sdi - b.sdi;
      });
      rankedBlocks = rows;
      calculated   = true;
      calculating  = false;
    }, 0);
  }

  function sdiClass(sdi: number): string {
    if (sdi < 0.05) return 'text-emerald-400';
    if (sdi < 0.2)  return 'text-yellow-400';
    return 'text-red-400';
  }

  function fmtNetPct(pct: number): string {
    if (pct === 0) return '—';
    const sign = pct > 0 ? '−' : '+'; // positive = deduction; negative = incentive
    return `${sign}${Math.abs(pct).toFixed(1)}%`;
  }

  function netPctClass(pct: number): string {
    if (pct > 0) return 'text-red-400';
    if (pct < 0) return 'text-emerald-400';
    return 'text-slate-500';
  }

  function tierSummary(s: TripCompletionSummary): string {
    if (s.totalPenaltyTrips === 0) return '—';
    return Object.entries(s.tiers).map(([tier, n]) => `${n}×${tier}`).join(' ');
  }
</script>

<div class="mx-auto max-w-6xl space-y-6 p-6">

  <!-- Controls + formula -->
  <div class="flex flex-wrap items-start gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
    <div class="flex items-center gap-3">
      <label class="text-xs font-medium text-slate-400 shrink-0" for="const-c">Missed trip weight (C)</label>
      <input
        id="const-c"
        type="number" min="0" step="0.1"
        bind:value={constantC}
        class="w-20 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white text-center
               focus:border-indigo-500 focus:outline-none"
      />
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
    </div>
    <div class="flex-1 space-y-1">
      <p class="font-mono text-xs text-slate-400">SDI = (A / L) + (C × t / T)</p>
      <div class="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-600">
        <span><span class="text-slate-500">A</span> = √Σdev²</span>
        <span><span class="text-slate-500">L</span> = schedule length (min)</span>
        <span><span class="text-slate-500">t</span> = trips with &lt;20 m displacement from start</span>
        <span><span class="text-slate-500">T</span> = total trips</span>
        <span>Punct. threshold: ±{DEFAULT_PUNCT_SETTINGS.startThresholdMin} min start / ±{DEFAULT_PUNCT_SETTINGS.endThresholdMin} min arrival</span>
      </div>
    </div>
  </div>

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
      Set parameters above and press
      <span class="mx-1.5 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">Calculate</span>
      to rank schedules.
    </div>
  {:else if rankedBlocks.length === 0}
    <div class="flex h-40 items-center justify-center text-sm text-slate-500">No schedule data available.</div>
  {:else}
    <div class="overflow-x-auto overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-3 py-3 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">#</th>
            <th class="px-3 py-3 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Block</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">SDI ↑</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="√(Σ deviation²)">A</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Schedule length">L</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Skipped">t</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Total trips">T</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500" title="Pings">Obs.</th>
            <th class="px-3 py-3 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Trip Completion Penalties</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Punctuality Penalties</th>
            <th class="px-3 py-3 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Other Penalties</th>
          </tr>
        </thead>
        <tbody>
          {#each rankedBlocks as row, i (row.blockId)}
            <tr class="border-b border-slate-800/60 transition-colors hover:bg-slate-800/30">
              <td class="px-3 py-2.5 text-xs text-slate-600">{row.sdi !== null ? i + 1 : '—'}</td>
              <td class="px-3 py-2.5 font-mono text-xs font-medium text-slate-300">{row.blockId}</td>

              <td class="px-3 py-2.5 text-right">
                {#if row.sdi !== null}
                  <span class="font-mono text-xs font-semibold {sdiClass(row.sdi)}">{row.sdi.toFixed(4)}</span>
                {:else}
                  <span class="text-xs text-slate-600">—</span>
                {/if}
              </td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">{row.hasLive ? row.A.toFixed(2) : '—'}</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">{row.L}</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs {row.hasLive && row.t > 0 ? 'text-red-400' : 'text-slate-400'}">{row.hasLive ? row.t : '—'}</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-400">{row.T}</td>
              <td class="px-3 py-2.5 text-right font-mono text-xs text-slate-600">{row.observations || '—'}</td>

              <!-- Trip Completion Penalties -->
              <td class="px-3 py-2.5 font-mono text-xs {row.tcSummary.totalPenaltyTrips > 0 ? 'text-orange-400' : 'text-slate-600'}">
                {#if !row.hasLive}
                  <span class="text-slate-600">No data</span>
                {:else}
                  {tierSummary(row.tcSummary)}
                {/if}
              </td>

              <!-- Punctuality Penalties -->
              <td class="px-3 py-2.5 text-right font-mono text-xs {netPctClass(row.punctNetPct)}">
                {row.hasLive ? fmtNetPct(row.punctNetPct) : '—'}
              </td>

              <!-- Other Penalties (data availability) -->
              <td class="px-3 py-2.5 text-right font-mono text-xs {row.dataPenPct > 0 ? 'text-red-400' : 'text-slate-600'}">
                {row.hasLive ? (row.dataPenPct > 0 ? `−${row.dataPenPct}%` : '—') : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-600">
      <span>TC Penalties: N×tier = penalised trips · e.g. 1×&lt;25 = one trip &lt;25% complete → 100% deduction</span>
      <span>Punct. / Other: % of monthly fee · green = incentive</span>
      <span>Ranked best → worst by SDI. Lower SDI = better adherence.</span>
    </div>
  {/if}
</div>