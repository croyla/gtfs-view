<script lang="ts">
  import type { GtfsData } from './types';
  import type { GtfsDiff, RouteDiffKind } from './diffGtfs';
  import type { CardEntry, DiffFilter } from './popupTypes';

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

  const entries = $derived.by(() =>
    [...diff.routes.entries()]
      .filter(([, d]) => activeFilter === 'all' || d.kind === activeFilter)
      .map(([routeId, d]) => {
        const route = d.kind === 'removed'
          ? gtfsData.routes.get(routeId)
          : compareData.routes.get(routeId);
        return { routeId, diff: d, route };
      })
      .sort((a, b) => {
        const order: Record<RouteDiffKind, number> = { added: 0, removed: 1, changed: 2 };
        return order[a.diff.kind] - order[b.diff.kind];
      })
  );

  const BADGE: Record<RouteDiffKind, string> = {
    added:   'bg-emerald-950/60 text-emerald-400',
    removed: 'bg-red-950/60 text-red-400',
    changed: 'bg-sky-950/60 text-sky-400',
  };

  const DOT: Record<RouteDiffKind, string> = {
    added:   '#22c55e',
    removed: '#ef4444',
    changed: '#60a5fa',
  };
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

{#if entries.length === 0}
  <p class="text-sm text-slate-500 text-center py-6">No routes with this change type.</p>
{:else}
  <div class="space-y-1">
    {#each entries as { routeId, diff: d, route } (routeId)}
      <button
        class="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-800 transition-colors text-left"
        onclick={() => onNavigate({ type: 'route', routeId })}
      >
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:{DOT[d.kind]}"></span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <p class="text-sm font-medium text-slate-200 truncate">
              {route?.route_short_name || routeId}
            </p>
            {#if route?.route_long_name}
              <p class="text-xs text-slate-500 truncate">{route.route_long_name}</p>
            {/if}
          </div>
          {#if d.kind === 'changed' && d.changes?.length}
            <p class="text-[10px] text-slate-500">{d.changes.join(', ')} changed</p>
          {/if}
        </div>
        <span class="rounded px-1.5 py-0.5 text-[9px] font-semibold shrink-0 {BADGE[d.kind]}">
          {d.kind}
        </span>
      </button>
    {/each}
  </div>
{/if}