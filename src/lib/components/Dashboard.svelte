<script lang="ts">
  import type { GtfsData, StopTime, Stop } from '../types/types';
  import type { LiveData, VehiclePosition } from '../types/liveTypes';
  import type { ApiVehicleAssignment, ApiPosition } from '../services/api';
  import { fetchVehiclePositions } from '../services/api';
  import SpaceTimeChart from './charts/SpaceTimeChart.svelte';
  import DatePicker from './DatePicker.svelte';
  import NetworkTab from './NetworkTab.svelte';
  import SchedulePenalties from './SchedulePenalties.svelte';

  let {
    dates,
    selectedDate,
    gtfsData,
    vehicleAssignments,
    liveData = null,
    onDateChange,
    onBack,
  }: {
    dates: string[];
    selectedDate: string;
    gtfsData: GtfsData | null;
    vehicleAssignments: ApiVehicleAssignment[];
    liveData?: LiveData | null;
    onDateChange: (date: string) => void;
    onBack: () => void;
  } = $props();

  let activeTab = $state<'network' | 'schedules'>('network');
  let selectedBlockId = $state<string>('');

  import type { BlockPingData } from '../services/schedule/schedulePings';
  import type { BlockMetrics } from '../services/schedule/scheduleMetrics';
  import { parseTimeMin, localMidnightEpoch } from '../services/popupUtils';
  import { pingCacheGet, pingCacheSet } from '../stores/pingDataCache';
  import TripMapPopup from './TripMapPopup.svelte';

  const blockIds = $derived.by(() => {
    const ids = [...new Set(vehicleAssignments.map(a => a.block_id).filter(Boolean))];
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return ids;
  });

  $effect(() => {
    if (blockIds.length > 0 && !blockIds.includes(selectedBlockId))
      selectedBlockId = blockIds[0];
  });

  const blockTripIds = $derived.by(() => {
    if (!selectedBlockId) return [];
    return vehicleAssignments
      .filter(a => a.block_id === selectedBlockId)
      .map(a => a.trip_id)
      .filter(tid => gtfsData?.stopTimesByTrip.has(tid));
  });

  const tripsForBlock = $derived.by(() => {
    return [...blockTripIds]
      .map(tid => {
        const trip  = gtfsData?.trips.get(tid);
        const route = trip ? gtfsData?.routes.get(trip.route_id) : undefined;
        const stopTimes = gtfsData?.stopTimesByTrip.get(tid) ?? [];
        return {
          trip_id: tid,
          route_short_name: route?.route_short_name ?? '—',
          route_long_name:  route?.route_long_name  ?? '',
          departure: stopTimes[0]?.departure_time    ?? '—',
          arrival:   stopTimes.at(-1)?.arrival_time  ?? '—',
          stops:     stopTimes.length,
        };
      })
      .sort((a, b) => a.departure.localeCompare(b.departure));
  });

  // ── Schedule ping computation ─────────────────────────────────────────────────

  let blockPingData           = $state<BlockPingData | null>(null);
  let blockMetrics            = $state<BlockMetrics | null>(null);
  let fetchedVehiclePositions = $state<VehiclePosition[]>([]);
  let isPingLoading           = $state(false);
  let isPingComputing         = $state(false);
  let showRawPingMap          = $state(false);

  let _scheduleWorker: Worker | null = null;

  function resolvePositionTrips(
    rawPositions: ApiPosition[],
    tids:         string[],
    gdata:        GtfsData,
    date:         string,
  ): VehiclePosition[] {
    const tz       = [...gdata.agencies.values()][0]?.agency_timezone ?? 'UTC';
    const midnight = localMidnightEpoch(date, tz);
    let   idCtr    = 0;
    return rawPositions.map(p => {
      const timestamp = Math.floor(new Date(p.timestamp).getTime() / 1000);
      let tripId: string | null = null;
      for (const tid of tids) {
        const sts = gdata.stopTimesByTrip.get(tid) ?? [];
        if (!sts.length) continue;
        const firstEpoch = midnight + parseTimeMin(sts[0].departure_time || sts[0].arrival_time) * 60;
        const lastEpoch  = midnight + parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time) * 60;
        if (timestamp >= firstEpoch - 600 && timestamp <= lastEpoch + 600) { tripId = tid; break; }
      }
      return { id: ++idCtr, vehicle_id: p.vehicle_id, trip_id: tripId, route_id: null,
               lat: p.lat, lon: p.lon, bearing: null, speed: null, status: '', timestamp };
    });
  }

  $effect(() => {
    const bid   = selectedBlockId;
    const date  = selectedDate;
    const tids  = blockTripIds;
    const gdata = gtfsData;

    if (_scheduleWorker) { _scheduleWorker.terminate(); _scheduleWorker = null; }

    if (!gdata || !tids.length) {
      blockPingData = null; blockMetrics = null; fetchedVehiclePositions = [];
      isPingLoading = false; isPingComputing = false;
      return;
    }

    // Show loading immediately — the async IIFE below will yield before doing any
    // heavy synchronous work (cache parse, structured-clone) so this state is painted.
    blockPingData = null; blockMetrics = null; fetchedVehiclePositions = [];
    isPingLoading = true;  isPingComputing = false;

    let cancelled = false;

    (async () => {
      // Yield one macrotask so Svelte flushes the loading screen before any
      // blocking work (localStorage JSON.parse, structured clone, etc.)
      await new Promise<void>(r => setTimeout(r, 0));
      if (cancelled) return;

      const vehicleId = vehicleAssignments.find(a => a.block_id === bid)?.vehicle_id;

      // Cache check — JSON.parse happens here; loading screen is already visible
      const cached = pingCacheGet(bid, date);
      if (cached) {
        blockPingData = cached.pingData;
        blockMetrics  = cached.metrics;
        isPingLoading = false;
        if (vehicleId) {
          fetchVehiclePositions(date, vehicleId)
            .then(raw => { if (!cancelled) fetchedVehiclePositions = resolvePositionTrips(raw, tids, gdata, date); })
            .catch(() => {});
        }
        return;
      }

      if (!vehicleId) { isPingLoading = false; return; }

      try {
        const raw = await fetchVehiclePositions(date, vehicleId);
        if (cancelled) return;

        fetchedVehiclePositions = resolvePositionTrips(raw, tids, gdata, date);
        isPingLoading = false;

        if (!raw.length) return;

        isPingComputing = true;

        // Yield again so "Matching pings…" paints before the structured clone
        await new Promise<void>(r => setTimeout(r, 0));
        if (cancelled) return;

        const tz = [...gdata.agencies.values()][0]?.agency_timezone ?? 'UTC';
        const sorted = [...tids].sort((a, b) => {
          const aMin = parseTimeMin((gdata.stopTimesByTrip.get(a)?.[0]?.departure_time ?? gdata.stopTimesByTrip.get(a)?.[0]?.arrival_time) ?? '');
          const bMin = parseTimeMin((gdata.stopTimesByTrip.get(b)?.[0]?.departure_time ?? gdata.stopTimesByTrip.get(b)?.[0]?.arrival_time) ?? '');
          return aMin - bMin;
        });

        const stopTimesByTripObj: Record<string, StopTime[]> = {};
        for (const tid of sorted) {
          const sts = gdata.stopTimesByTrip.get(tid);
          if (sts) stopTimesByTripObj[tid] = sts;
        }
        const stopsObj: Record<string, Stop> = {};
        for (const tid of sorted)
          for (const st of gdata.stopTimesByTrip.get(tid) ?? []) {
            const stop = gdata.stops.get(st.stop_id);
            if (stop) stopsObj[st.stop_id] = stop;
          }

        const worker = new Worker(
          new URL('../services/schedule/scheduleWorker.ts', import.meta.url),
          { type: 'module' },
        );
        _scheduleWorker = worker;

        worker.onmessage = (ev: MessageEvent<{ ok: boolean; pingData?: BlockPingData; metrics?: BlockMetrics; error?: string }>) => {
          if (cancelled) { worker.terminate(); return; }
          if (ev.data.ok && ev.data.pingData && ev.data.metrics) {
            pingCacheSet(bid, date, { pingData: ev.data.pingData, metrics: ev.data.metrics });
            blockPingData = ev.data.pingData;
            blockMetrics  = ev.data.metrics;
          }
          isPingComputing = false;
          _scheduleWorker = null;
          worker.terminate();
        };
        worker.onerror = () => {
          if (cancelled) return;
          isPingComputing = false;
          _scheduleWorker = null;
          worker.terminate();
        };

        worker.postMessage({
          sortedTripIds:   sorted,
          rawPositions:    raw.map(p => ({
            lat:        p.lat,
            lon:        p.lon,
            timestamp:  Math.floor(new Date(p.timestamp).getTime() / 1000),
            vehicle_id: p.vehicle_id,
          })),
          taggedPositions: fetchedVehiclePositions.map(p => ({
            lat:        p.lat,
            lon:        p.lon,
            timestamp:  p.timestamp,
            vehicle_id: p.vehicle_id,
            trip_id:    p.trip_id,
          })),
          timezone:        tz,
          stopTimesByTrip: stopTimesByTripObj,
          stops:           stopsObj,
        });
      } catch {
        if (cancelled) return;
        isPingLoading = false; isPingComputing = false;
      }
    })();

    return () => {
      cancelled = true;
      if (_scheduleWorker) { _scheduleWorker.terminate(); _scheduleWorker = null; }
      isPingLoading = false; isPingComputing = false;
    };
  });

  const dateIndex = $derived(dates.indexOf(selectedDate));

  function prevDate() { if (dateIndex > 0) onDateChange(dates[dateIndex - 1]); }
  function nextDate() { if (dateIndex < dates.length - 1) onDateChange(dates[dateIndex + 1]); }
</script>

<div class="flex h-screen w-screen flex-col bg-slate-950 text-white">

  <!-- Header -->
  <header class="flex shrink-0 items-center gap-4 border-b border-slate-800 bg-slate-900 px-4 py-3">
    <button
      class="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
      onclick={onBack}
    >
      <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 3L5 8l5 5"/>
      </svg>
      Back to map
    </button>

    <div class="h-4 w-px bg-slate-700"></div>
    <h1 class="text-sm font-semibold text-white">Dashboard</h1>

    <div class="ml-auto flex items-center gap-1">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors disabled:opacity-30"
        onclick={prevDate} disabled={dateIndex <= 0} aria-label="Previous date"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10 3L5 8l5 5"/>
        </svg>
      </button>
      <DatePicker {dates} {selectedDate} onSelect={onDateChange} direction="down" />
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors disabled:opacity-30"
        onclick={nextDate} disabled={dateIndex >= dates.length - 1} aria-label="Next date"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 3l5 5-5 5"/>
        </svg>
      </button>
    </div>
  </header>

  <!-- Tabs -->
  <div class="flex shrink-0 border-b border-slate-800 bg-slate-900 px-4">
    {#each (['network', 'schedules'] as const) as tab}
      <button
        class="relative px-4 py-3 text-sm font-medium transition-colors
               {activeTab === tab ? 'text-white' : 'text-slate-400 hover:text-slate-200'}"
        onclick={() => (activeTab = tab)}
      >
        {tab === 'network' ? 'Network' : 'Schedules'}
        {#if activeTab === tab}
          <span class="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-indigo-500"></span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Tab content -->
  <div class="flex-1 overflow-auto">

    {#if activeTab === 'network'}
      <NetworkTab {gtfsData} {vehicleAssignments} {liveData} date={selectedDate} />

    {:else}
      <!-- Schedules tab -->
      <div class="mx-auto max-w-6xl space-y-8 p-6">

        <!-- Block selector + summary table -->
        <section>
          <div class="mb-4 flex flex-wrap items-center gap-3">
            <label class="text-xs font-medium text-slate-400 shrink-0" for="block-select">Schedule (block)</label>
            <select
              id="block-select"
              class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white
                     focus:border-indigo-500 focus:outline-none"
              bind:value={selectedBlockId}
            >
              {#if blockIds.length === 0}
                <option value="">No blocks available</option>
              {:else}
                {#each blockIds as bid (bid)}
                  <option value={bid}>{bid}</option>
                {/each}
              {/if}
            </select>
            {#if selectedBlockId}
              <span class="text-xs text-slate-500">
                {tripsForBlock.length} trip{tripsForBlock.length !== 1 ? 's' : ''}
                {#if fetchedVehiclePositions.length > 0}
                  · {fetchedVehiclePositions.length} pings
                {/if}
              </span>
            {/if}
          </div>

          {#if tripsForBlock.length > 0}
            <div class="overflow-hidden rounded-xl border border-slate-800">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-slate-800 bg-slate-900/60">
                    <th class="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Trip ID</th>
                    <th class="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Route</th>
                    <th class="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Departure</th>
                    <th class="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">Arrival</th>
                    <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Stops</th>
                  </tr>
                </thead>
                <tbody>
                  {#each tripsForBlock as row (row.trip_id)}
                    <tr class="border-b border-slate-800/60 transition-colors hover:bg-slate-800/40">
                      <td class="px-4 py-2.5 font-mono text-xs text-slate-400">{row.trip_id}</td>
                      <td class="px-4 py-2.5">
                        <span class="font-medium text-slate-200">{row.route_short_name}</span>
                        {#if row.route_long_name}
                          <span class="ml-1.5 text-xs text-slate-500">{row.route_long_name}</span>
                        {/if}
                      </td>
                      <td class="px-4 py-2.5 font-mono text-xs text-slate-300">{row.departure}</td>
                      <td class="px-4 py-2.5 font-mono text-xs text-slate-300">{row.arrival}</td>
                      <td class="px-4 py-2.5 text-right text-xs text-slate-400">{row.stops}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

        {#if gtfsData && blockTripIds.length > 0}

          {#if isPingLoading || isPingComputing}
            <div class="flex flex-col items-center justify-center gap-5 py-28">
              <div class="relative h-12 w-12">
                <svg class="h-12 w-12 text-slate-800" viewBox="0 0 48 48" fill="none">
                  <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="4"/>
                </svg>
                <svg class="absolute inset-0 h-12 w-12 animate-spin text-indigo-500" viewBox="0 0 48 48" fill="none">
                  <path d="M24 4a20 20 0 0 1 20 20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="text-center space-y-1">
                <p class="text-sm font-semibold text-slate-200">
                  {isPingLoading ? 'Loading positions…' : 'Matching pings to schedule…'}
                </p>
                <p class="text-xs text-slate-500">
                  {blockTripIds.length} trip{blockTripIds.length !== 1 ? 's' : ''}
                  {#if isPingComputing && fetchedVehiclePositions.length > 0}
                    · {fetchedVehiclePositions.length} ping{fetchedVehiclePositions.length !== 1 ? 's' : ''}
                  {/if}
                </p>
              </div>
              {#if blockTripIds.length > 0}
                <div class="flex flex-wrap justify-center gap-1.5">
                  {#each blockTripIds as tid}
                    <span class="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-slate-600">{tid}</span>
                  {/each}
                </div>
              {/if}
            </div>

          {:else if blockPingData === null}
            <div class="flex h-40 items-center justify-center text-sm text-slate-500">
              No live position data available for this block.
            </div>

          {:else if blockPingData.error === 'no_match'}
            <div class="flex flex-col items-center justify-center gap-3 py-12 text-sm text-slate-500">
              <p>No pings landed within 150 m of any scheduled stop — stop coordinates may be mismatched with GPS data.</p>
              {#if fetchedVehiclePositions.length > 0}
                <button
                  onclick={() => (showRawPingMap = true)}
                  class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5
                         text-xs text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
                >
                  <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round"
                          d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c-.317-.159.69-.159 1.006 0l4.994 2.497c.317.159.69.159 1.006 0Z"/>
                  </svg>
                  View raw ping map ({fetchedVehiclePositions.length} pings)
                </button>
              {/if}
            </div>

          {:else}

            <!-- Chart 1: Space-Time Diagram -->
            <section>
              <div class="mb-3 flex items-baseline gap-2">
                <h2 class="text-sm font-semibold text-slate-200">Space–Time Diagram</h2>
                <span class="text-xs text-slate-500">Stops on Y · Time on X · Lines = scheduled · Dots = live</span>
              </div>
              <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <SpaceTimeChart
                  {blockTripIds}
                  {gtfsData}
                  pingData={blockPingData}
                />
              </div>
            </section>

            <!-- Penalty breakdown -->
            <section>
              <div class="mb-3">
                <h2 class="text-sm font-semibold text-slate-200">Penalty Breakdown</h2>
              </div>
              <SchedulePenalties
                {blockTripIds}
                {gtfsData}
                metrics={blockMetrics}
              />
            </section>

          {/if}

        {/if}

      </div>
    {/if}

  </div>
</div>

{#if showRawPingMap}
  <TripMapPopup
    tripIdx={0}
    tripId={selectedBlockId}
    stops={[]}
    pings={fetchedVehiclePositions.map(p => ({ lat: p.lat, lon: p.lon }))}
    matchedPings={[]}
    onClose={() => (showRawPingMap = false)}
  />
{/if}