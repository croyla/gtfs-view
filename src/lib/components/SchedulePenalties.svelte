<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { BlockMetrics } from '../services/schedule/scheduleMetrics';
  import { DATA_AVAIL_THRESHOLD, DATA_AVAIL_PENALTY_PCT } from '../services/schedule/scheduleMetrics';
  import { parseTimeMin } from '../services/popupUtils';
  import PunctualityTable from './PunctualityTable.svelte';
  import type { TripPunctuality } from './PunctualityTable.svelte';
  import CompletionTable from './CompletionTable.svelte';
  import type { TripCompletion, TripStopDetail } from './CompletionTable.svelte';

  let startThreshold  = $state(+(localStorage.getItem('gtfs_punct_start')    ?? '5'));
  let endThreshold    = $state(+(localStorage.getItem('gtfs_punct_end')      ?? '10'));
  let pingIntervalSec = $state(+(localStorage.getItem('gtfs_ping_interval')  ?? '30'));

  $effect(() => { localStorage.setItem('gtfs_punct_start',   String(startThreshold));  });
  $effect(() => { localStorage.setItem('gtfs_punct_end',     String(endThreshold));    });
  $effect(() => { localStorage.setItem('gtfs_ping_interval', String(pingIntervalSec)); });

  let {
    blockTripIds = [],
    gtfsData,
    metrics = null,
  }: {
    blockTripIds: string[];
    gtfsData:     GtfsData;
    metrics?:     BlockMetrics | null;
  } = $props();

  const punctualityRows = $derived.by((): TripPunctuality[] => {
    if (!metrics) return [];
    return metrics.tripRecords.map((record, i) => {
      const sts     = gtfsData.stopTimesByTrip.get(record.tid) ?? [];
      const visited = record.stopMatches.filter(m => m.visited);
      const schedStartMin = sts.length > 0
        ? parseTimeMin(sts[0].departure_time || sts[0].arrival_time) : 0;
      const schedEndMin   = sts.length > 0
        ? parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time) : 0;
      return {
        idx:          i + 1,
        tid:          record.tid,
        schedStart:   sts.length > 0 ? (sts[0].departure_time  || sts[0].arrival_time).slice(0, 5)           : '—',
        schedEnd:     sts.length > 0 ? (sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time).slice(0, 5) : '—',
        schedStartMin,
        schedEndMin,
        obsStartT: visited.length > 0 ? visited[0].matchedPingT!        : null,
        obsEndT:   visited.length > 0 ? visited.at(-1)!.matchedPingT!   : null,
      };
    });
  });

  const completionRows = $derived.by((): TripCompletion[] => {
    if (!metrics) return [];
    return metrics.completions.map((result, i) => {
      const record    = metrics.tripRecords[i];
      const ranKm     = result.scheduledKm - result.lostKm;
      const penaltyKm = ranKm * result.penaltyPct / 100;
      const payableKm = ranKm - penaltyKm;

      const stops: TripStopDetail[] = record.stopMatches.map((m, j) => ({
        seq:      j + 1,
        stopName: m.stopName,
        schedMin: m.schedMin,
        obsT:     m.matchedPingT,
        visited:  m.visited,
      }));

      const mapStops = record.stopMatches
        .map(m => {
          const stop = gtfsData.stops.get(m.stopId);
          return stop
            ? { lat: stop.stop_lat, lon: stop.stop_lon, name: m.stopName, visited: m.visited }
            : null;
        })
        .filter((s): s is { lat: number; lon: number; name: string; visited: boolean } => s !== null);

      const mapPings        = record.pings.map(p => ({ lat: p.lat, lon: p.lon }));
      const mapMatchedPings = record.stopMatches.map(m =>
        m.visited && m.matchedPing ? { lat: m.matchedPing.lat, lon: m.matchedPing.lon } : null,
      );

      return {
        idx: i + 1, tid: result.tid,
        scheduledStops: record.stopMatches.length,
        scheduledKm:    result.scheduledKm,
        ranKm, lostKm: result.lostKm,
        penaltyPct:     result.penaltyPct,
        penaltyKm, payableKm, stops, mapStops, mapPings, mapMatchedPings,
      };
    });
  });

  // ── Block-level data availability ─────────────────────────────────────────────

  const blockAvailability = $derived.by(() => {
    const expectedPerMin = pingIntervalSec > 0 ? 60 / pingIntervalSec : 0;
    if (!metrics || blockTripIds.length === 0) return null;

    const blockStartMin = 0;          // 12:00 AM
    const blockEndMin   = 23 * 60 + 59; // 11:59 PM

    const blockDurationMin = Math.max(0, blockEndMin - blockStartMin);
    const expectedPings    = Math.ceil(blockDurationMin * expectedPerMin);
    const observedPings    = metrics.dataAvailability.trips.reduce((s, t) => s + t.pingCount, 0);
    const availabilityPct  = expectedPings > 0
      ? Math.min(100, (observedPings / expectedPings) * 100)
      : (observedPings > 0 ? 100 : 0);
    const penalized = availabilityPct < DATA_AVAIL_THRESHOLD;

    return { blockStartMin, blockEndMin, blockDurationMin, expectedPings, observedPings, availabilityPct, penalized };
  });

  function fmtBlockTime(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = Math.floor(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
</script>

<div class="space-y-8">

  {#if !metrics}
    <div class="flex h-40 items-center justify-center text-sm text-slate-500">
      No live position data available for this block.
    </div>

  {:else}

    <!-- Trip Completion -->
    <section>
      <div class="mb-3 flex items-baseline gap-3">
        <h2 class="text-sm font-semibold text-slate-200">Trip Completion</h2>
        <span class="text-xs text-slate-500">KM-based · lost km not remunerated</span>
      </div>
      <div class="overflow-hidden rounded-xl border border-slate-800">
        <CompletionTable trips={completionRows} />
      </div>
      <div class="mt-2 flex gap-4 text-[11px] text-slate-600">
        <span>&lt;25% → 100% deducted</span>
        <span>25–60% → 75% deducted</span>
        <span>60–99% → 50% deducted</span>
      </div>
    </section>

    <!-- Punctuality -->
    <section>
      <div class="mb-3 flex flex-wrap items-center gap-4">
        <h2 class="text-sm font-semibold text-slate-200">Punctuality</h2>
        <div class="flex items-center gap-3 text-xs text-slate-400">
          <label class="flex items-center gap-1.5">
            Start ±
            <input
              type="number" min="0" step="1"
              bind:value={startThreshold}
              class="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-center font-mono
                     text-white focus:border-indigo-500 focus:outline-none"
            />
            min
          </label>
          <span class="text-slate-700">·</span>
          <label class="flex items-center gap-1.5">
            End ±
            <input
              type="number" min="0" step="1"
              bind:value={endThreshold}
              class="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-center font-mono
                     text-white focus:border-indigo-500 focus:outline-none"
            />
            min
          </label>
        </div>
      </div>
      <div class="overflow-hidden rounded-xl border border-slate-800">
        <PunctualityTable trips={punctualityRows} {startThreshold} {endThreshold} />
      </div>
    </section>

    <!-- Data Availability -->
    <section>
      <div class="mb-3 flex flex-wrap items-center gap-4">
        <h2 class="text-sm font-semibold text-slate-200">Data Availability</h2>
        <span class="text-xs text-slate-500">&lt;{DATA_AVAIL_THRESHOLD}% → {DATA_AVAIL_PENALTY_PCT}% of monthly fee</span>
        <label class="flex items-center gap-1.5 text-xs text-slate-400">
          Expected: 1 ping /
          <input
            type="number" min="1" step="1"
            bind:value={pingIntervalSec}
            class="w-14 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-center font-mono
                   text-white focus:border-indigo-500 focus:outline-none"
          />
          s
        </label>
      </div>

      {#if blockAvailability}
        <div class="mb-3 flex items-center gap-6 text-xs text-slate-400">
          <span>
            Block start:
            <span class="ml-1 font-mono text-slate-200">{fmtBlockTime(blockAvailability.blockStartMin)}</span>
          </span>
          <span class="text-slate-700">·</span>
          <span>
            Block end:
            <span class="ml-1 font-mono text-slate-200">{fmtBlockTime(blockAvailability.blockEndMin)}</span>
          </span>
        </div>

        <div class="overflow-hidden rounded-xl border border-slate-800">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-slate-800 bg-slate-950/40">
                <th class="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">Duration</th>
                <th class="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">Expected</th>
                <th class="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">Observed</th>
                <th class="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">Availability</th>
                <th class="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">Penalty</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-b border-slate-800/40">
                <td class="px-3 py-2.5 text-right font-mono text-slate-400">{blockAvailability.blockDurationMin} min</td>
                <td class="px-3 py-2.5 text-right font-mono text-slate-600">{blockAvailability.expectedPings}</td>
                <td class="px-3 py-2.5 text-right font-mono text-slate-400">{blockAvailability.observedPings}</td>
                <td class="px-3 py-2.5 text-right font-mono font-medium
                           {blockAvailability.availabilityPct >= DATA_AVAIL_THRESHOLD ? 'text-emerald-400' : 'text-red-400'}">
                  {blockAvailability.availabilityPct.toFixed(1)}%
                </td>
                <td class="px-3 py-2.5 text-right font-mono {blockAvailability.penalized ? 'text-red-400' : 'text-slate-600'}">
                  {blockAvailability.penalized ? `−${DATA_AVAIL_PENALTY_PCT}% / fee` : '—'}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="border-t border-slate-700 bg-slate-900/60">
                <td colspan="4" class="px-3 py-2 text-right text-[10px] text-slate-400">Total data availability penalty</td>
                <td class="px-3 py-2 text-right font-mono font-semibold
                           {blockAvailability.penalized ? 'text-red-400' : 'text-slate-600'}">
                  {blockAvailability.penalized ? `−${DATA_AVAIL_PENALTY_PCT}% / fee` : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      {/if}
    </section>

  {/if}
</div>