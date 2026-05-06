<script lang="ts">
  import type { GtfsData } from './types';
  import type { CardEntry } from './popupTypes';
  import type { LiveProcessed } from './liveStopTimes';
  import type { ExportScope } from './exportReport';
  import StopCard from './StopCard.svelte';
  import RouteCard from './RouteCard.svelte';
  import TripCard from './TripCard.svelte';
  import ExportModal from './ExportModal.svelte';

  let {
    initialCard,
    gtfsData,
    liveProcessed = null,
    onClose,
  }: {
    initialCard: CardEntry;
    gtfsData: GtfsData;
    liveProcessed?: LiveProcessed | null;
    onClose: () => void;
  } = $props();

  let showExport = $state(false);

  let stack = $state<CardEntry[]>([initialCard]);

  $effect(() => { stack = [initialCard]; });

  function navigate(card: CardEntry) {
    stack = [...stack, card];
  }

  function back() {
    if (stack.length > 1) stack = stack.slice(0, -1);
  }

  const current = $derived(stack[stack.length - 1]);

  const exportScope = $derived.by((): ExportScope => {
    const card = current;
    if (card.type === 'stop') return { kind: 'stop', stopId: card.stopId };
    if (card.type === 'route') return { kind: 'route', routeId: card.routeId };
    return { kind: 'trip', tripId: card.tripId };
  });

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
      return trip?.trip_headsign ?? `Trip`;
    }
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
  <!-- Backdrop -->
  <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>

  <!-- Card -->
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

      {#if liveProcessed}
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
          onclick={() => (showExport = true)}
          aria-label="Export report"
          title="Export report"
        >
          <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M2 10.5v1.75A1.75 1.75 0 003.75 14h8.5A1.75 1.75 0 0014 12.25V10.5M8 2v8m-3-3l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      {/if}

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
        <StopCard stopId={current.stopId} {gtfsData} {liveProcessed} onNavigate={navigate} />
      {:else if current.type === 'route'}
        <RouteCard routeId={current.routeId} {gtfsData} {liveProcessed} onNavigate={navigate} />
      {:else if current.type === 'trip'}
        <TripCard tripId={current.tripId} {gtfsData} {liveProcessed} onNavigate={navigate} />
      {/if}
    </div>
  </div>
</div>

{#if showExport && liveProcessed}
  <ExportModal
    scope={exportScope}
    {gtfsData}
    {liveProcessed}
    onClose={() => (showExport = false)}
  />
{/if}