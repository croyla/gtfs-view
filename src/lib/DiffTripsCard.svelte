<script lang="ts">
  import type { GtfsData } from './types';
  import type { GtfsDiff, TripDiffKind } from './diffGtfs';
  import type { CardEntry, DiffFilter } from './popupTypes';
  import { formatTime } from './popupUtils';

  let {
    filter,
    diff,
    gtfsData,
    compareData,
    onNavigate,
  }: {
    filter: DiffFilter;
    diff: GtfsDiff;
    gtfsData: GtfsData;
    compareData: GtfsData;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  const TABS: { f: DiffFilter; label: string }[] = [
    { f: 'all',     label: 'All' },
    { f: 'added',   label: 'Added' },
    { f: 'removed', label: 'Removed' },
    { f: 'changed', label: 'Changed' },
  ];

  let activeFilter = $state<DiffFilter>(filter);
  let expandedRoutes = $state(new Set<string>());

  // Group changed trips by route
  const byRoute = $derived.by(() => {
    const groups = new Map<string, { routeId: string; tripId: string; kind: TripDiffKind; headsign: string | null; changeCount: number }[]>();

    for (const [tripId, td] of diff.trips) {
      if (activeFilter !== 'all' && td.kind !== activeFilter) continue;
      const routeId = td.routeId;
      if (!groups.has(routeId)) groups.set(routeId, []);
      groups.get(routeId)!.push({
        routeId, tripId, kind: td.kind,
        headsign: td.trip.trip_headsign ?? null,
        changeCount: td.stopChanges?.length ?? 0,
      });
    }

    // Sort routes by ID
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([routeId, trips]) => {
        const route = compareData.routes.get(routeId) ?? gtfsData.routes.get(routeId);
        return { routeId, route, trips: trips.sort((a, b) => (a.headsign ?? '').localeCompare(b.headsign ?? '')) };
      });
  });

  function toggleRoute(routeId: string) {
    const next = new Set(expandedRoutes);
    if (next.has(routeId)) next.delete(routeId); else next.add(routeId);
    expandedRoutes = next;
  }

  const BADGE: Record<TripDiffKind, string> = {
    added:   'bg-emerald-950/60 text-emerald-400',
    removed: 'bg-red-950/60 text-red-400',
    changed: 'bg-amber-950/60 text-amber-400',
  };

  const DOT: Record<TripDiffKind, string> = {
    added:   '#22c55e',
    removed: '#ef4444',
    changed: '#fbbf24',
  };

  function routeKindSummary(trips: typeof byRoute[0]['trips']): string {
    const counts: Partial<Record<TripDiffKind, number>> = {};
    for (const t of trips) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  }
</script>

<!-- Filter tabs -->
<div class="flex gap-1 rounded-lg bg-slate-800 p-1 mb-4">
  {#each TABS as tab (tab.f)}
    <button
      class="flex-1 rounded-md py-1 text-xs font-medium transition-colors
             {activeFilter === tab.f ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}"
      onclick={() => (activeFilter = tab.f)}
    >
      {tab.label}
    </button>
  {/each}
</div>

{#if byRoute.length === 0}
  <p class="text-sm text-slate-500 text-center py-6">No trips with this change type.</p>
{:else}
  <div class="space-y-1">
    {#each byRoute as { routeId, route, trips } (routeId)}
      {@const expanded = expandedRoutes.has(routeId)}

      <!-- Route row -->
      <div class="rounded-lg border border-slate-700 overflow-hidden">
        <button
          class="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-slate-800 transition-colors text-left"
          onclick={() => toggleRoute(routeId)}
        >
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform {expanded ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="currentColor">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {#if route?.route_color}
            <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style="background:#{route.route_color}"></span>
          {/if}
          <div class="flex-1 min-w-0">
            <span class="text-sm font-medium text-slate-200">
              {route?.route_short_name || routeId}
            </span>
            {#if route?.route_long_name}
              <span class="text-xs text-slate-500 ml-1.5">{route.route_long_name}</span>
            {/if}
          </div>
          <span class="text-[10px] text-slate-500 shrink-0">{routeKindSummary(trips)}</span>
        </button>

        {#if expanded}
          <div class="border-t border-slate-700">
            {#each trips as t (t.tripId)}
              <button
                class="w-full flex items-center gap-3 px-4 py-2 hover:bg-slate-800 transition-colors text-left border-b border-slate-800 last:border-0"
                onclick={() => onNavigate({ type: 'trip', tripId: t.tripId })}
              >
                <span class="h-2 w-2 shrink-0 rounded-full" style="background:{DOT[t.kind]}"></span>
                <div class="flex-1 min-w-0">
                  <p class="text-xs text-slate-300 truncate">{t.headsign ?? t.tripId}</p>
                  {#if t.kind === 'changed' && t.changeCount > 0}
                    <p class="text-[10px] text-slate-500">{t.changeCount} stop change{t.changeCount !== 1 ? 's' : ''}</p>
                  {/if}
                </div>
                <span class="rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 {BADGE[t.kind]}">{t.kind}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}