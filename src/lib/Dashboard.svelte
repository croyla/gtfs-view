<script lang="ts">
  import type { GtfsData } from './types';
  import type { LiveData } from './liveTypes';
  import type { ApiVehicleAssignment } from './api';
  import SpaceTimeChart from './charts/SpaceTimeChart.svelte';
  import DistanceTimeChart from './charts/DistanceTimeChart.svelte';

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

  let activeTab = $state<'stops' | 'schedules'>('stops');
  let selectedBlockId = $state<string>('');

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

  // Trips table for the block selector section
  const tripsForBlock = $derived.by(() => {
    return blockTripIds.map(tid => {
      const trip  = gtfsData?.trips.get(tid);
      const route = trip ? gtfsData?.routes.get(trip.route_id) : undefined;
      const stopTimes = gtfsData?.stopTimesByTrip.get(tid) ?? [];
      return {
        trip_id: tid,
        route_short_name: route?.route_short_name ?? '—',
        route_long_name: route?.route_long_name ?? '',
        departure: stopTimes[0]?.departure_time ?? '—',
        arrival: stopTimes.at(-1)?.arrival_time ?? '—',
        stops: stopTimes.length,
      };
    }).sort((a, b) => a.departure.localeCompare(b.departure));
  });

  // Live positions filtered to current block's trips
  const blockLivePositions = $derived.by(() => {
    const tripSet = new Set(blockTripIds);
    return (liveData?.vehiclePositions ?? []).filter(p => p.trip_id && tripSet.has(p.trip_id));
  });

  const dateIndex = $derived(dates.indexOf(selectedDate));

  function prevDate() { if (dateIndex > 0) onDateChange(dates[dateIndex - 1]); }
  function nextDate() { if (dateIndex < dates.length - 1) onDateChange(dates[dateIndex + 1]); }

  function formatDate(yyyymmdd: string): string {
    const y = yyyymmdd.slice(0, 4), m = yyyymmdd.slice(4, 6), d = yyyymmdd.slice(6, 8);
    return new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  }
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
      <span class="min-w-[120px] text-center text-xs font-medium text-slate-200">
        {selectedDate ? formatDate(selectedDate) : '—'}
      </span>
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
    {#each (['stops', 'schedules'] as const) as tab}
      <button
        class="relative px-4 py-3 text-sm font-medium transition-colors
               {activeTab === tab ? 'text-white' : 'text-slate-400 hover:text-slate-200'}"
        onclick={() => (activeTab = tab)}
      >
        {tab === 'stops' ? 'Stops' : 'Schedules'}
        {#if activeTab === tab}
          <span class="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-indigo-500"></span>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Tab content -->
  <div class="flex-1 overflow-auto">

    {#if activeTab === 'stops'}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-slate-500">Stop reports coming soon.</p>
      </div>

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
                {#if blockLivePositions.length > 0}
                  · {blockLivePositions.length} live pings
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
                livePositions={blockLivePositions}
              />
            </div>
          </section>

          <!-- Chart 2: Distance-Time Diagram -->
          <section>
            <div class="mb-3 flex items-baseline gap-2">
              <h2 class="text-sm font-semibold text-slate-200">Distance–Time Diagram</h2>
              <span class="text-xs text-slate-500">Cumulative distance over the day</span>
            </div>
            <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <DistanceTimeChart
                {blockTripIds}
                {gtfsData}
                livePositions={blockLivePositions}
                {selectedDate}
              />
            </div>
          </section>

        {/if}

      </div>
    {/if}

  </div>
</div>