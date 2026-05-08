<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import type { GtfsDiff } from './diffGtfs';
  import StopCard from './StopCard.svelte';
  import RouteCard from './RouteCard.svelte';
  import TripCard from './TripCard.svelte';
  import DiffSummaryCard from './DiffSummaryCard.svelte';
  import DiffStopsCard from './DiffStopsCard.svelte';
  import DiffRoutesCard from './DiffRoutesCard.svelte';
  import DiffTripsCard from './DiffTripsCard.svelte';

  let {
    initialCard,
    gtfsData,
    diff = null,
    compareData = null,
    onClose,
  }: {
    initialCard: CardEntry;
    gtfsData: GtfsData;
    diff?: GtfsDiff | null;
    compareData?: GtfsData | null;
    onClose: () => void;
  } = $props();

  let stack = $state<CardEntry[]>([initialCard]);

  $effect(() => { stack = [initialCard]; });

  function navigate(card: CardEntry) { stack = [...stack, card]; }
  function back() { if (stack.length > 1) stack = stack.slice(0, -1); }

  const current = $derived(stack[stack.length - 1]);

  const title = $derived.by(() => {
    const card = current;
    if (card.type === 'stop') {
      const stop = gtfsData.stops.get(card.stopId);
      return stop?.stop_name ?? 'Stop';
    }
    if (card.type === 'route') {
      const route = gtfsData.routes.get(card.routeId);
      return route ? `Route ${route.route_short_name || route.route_id}` : 'Route';
    }
    if (card.type === 'trip') {
      const trip = gtfsData.trips.get(card.tripId);
      return trip?.trip_headsign ?? 'Trip';
    }
    if (card.type === 'diff-summary') return 'Feed diff';
    if (card.type === 'diff-stops')   return 'Stops diff';
    if (card.type === 'diff-routes')  return 'Routes diff';
    if (card.type === 'diff-trips')   return 'Trips diff';
    return '';
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<!-- Full-screen overlay -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center p-4"
  role="dialog"
  aria-modal="true"
  onclick={handleBackdropClick}
>
  <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>

  <div class="relative z-10 w-full max-w-lg bg-slate-900 rounded-2xl shadow-2xl border border-slate-700 flex flex-col max-h-[85vh]">
    <!-- Header -->
    <div class="flex items-center gap-2 px-5 py-3.5 border-b border-slate-700 shrink-0">
      {#if stack.length > 1}
        <button
          class="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors mr-1"
          onclick={back}
          aria-label="Back"
        >
          <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Back
        </button>
      {/if}

      <h2 class="flex-1 text-sm font-semibold text-white truncate">{title}</h2>

      <button
        class="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
        onclick={onClose}
        aria-label="Close"
      >
        <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto px-5 py-4">
      {#if current.type === 'stop'}
        <StopCard stopId={current.stopId} {gtfsData} onNavigate={navigate} />
      {:else if current.type === 'route'}
        <RouteCard routeId={current.routeId} {gtfsData} onNavigate={navigate} />
      {:else if current.type === 'trip'}
        <TripCard tripId={current.tripId} {gtfsData} onNavigate={navigate} />
      {:else if current.type === 'diff-summary' && diff}
        <DiffSummaryCard {diff} onNavigate={navigate} />
      {:else if current.type === 'diff-stops' && diff && compareData}
        <DiffStopsCard filter={current.filter} {diff} {gtfsData} {compareData} onNavigate={navigate} />
      {:else if current.type === 'diff-routes' && diff && compareData}
        <DiffRoutesCard filter={current.filter} {diff} {gtfsData} {compareData} onNavigate={navigate} />
      {:else if current.type === 'diff-trips' && diff && compareData}
        <DiffTripsCard filter={current.filter} {diff} {gtfsData} {compareData} onNavigate={navigate} />
      {/if}
    </div>
  </div>
</div>