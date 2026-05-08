<script lang="ts">
  import type { GtfsData } from './types';
  import type { GtfsDiff, StopDiffKind } from './diffGtfs';
  import type { CardEntry, DiffFilter } from './popupTypes';
  import { DIFF_COLORS } from './diffGtfs';

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
    { f: 'moved',   label: 'Moved' },
  ];

  let activeFilter = $state<DiffFilter>(filter);

  const entries = $derived.by(() => {
    const all = [...diff.stops.entries()];
    return all
      .filter(([, d]) => activeFilter === 'all' || d.kind === activeFilter)
      .map(([stopId, d]) => {
        const stopData = d.kind === 'removed'
          ? gtfsData.stops.get(stopId)
          : compareData.stops.get(stopId);
        return { stopId, diff: d, stop: stopData };
      })
      .sort((a, b) => {
        const order: Record<StopDiffKind, number> = { added: 0, removed: 1, moved: 2 };
        return order[a.diff.kind] - order[b.diff.kind];
      });
  });

  const BADGE: Record<StopDiffKind, string> = {
    added:   'bg-emerald-950/60 text-emerald-400',
    removed: 'bg-red-950/60 text-red-400',
    moved:   'bg-sky-950/60 text-sky-400',
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
  <p class="text-sm text-slate-500 text-center py-6">No stops with this change type.</p>
{:else}
  <div class="space-y-1">
    {#each entries as { stopId, diff: d, stop } (stopId)}
      <button
        class="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-800 transition-colors text-left"
        onclick={() => onNavigate({ type: 'stop', stopId })}
      >
        <span
          class="h-2.5 w-2.5 shrink-0 rounded-full"
          style="background:{DIFF_COLORS[d.kind]}"
        ></span>
        <div class="flex-1 min-w-0">
          <p class="text-sm text-slate-200 truncate">{stop?.stop_name ?? stopId}</p>
          <p class="text-[10px] text-slate-500">{stopId}</p>
        </div>
        <div class="shrink-0 flex flex-col items-end gap-1">
          <span class="rounded px-1.5 py-0.5 text-[9px] font-semibold {BADGE[d.kind]}">
            {d.kind}
          </span>
          {#if d.kind === 'moved' && d.distanceM !== undefined}
            <span class="text-[9px] text-slate-500">{d.distanceM < 1000 ? `${Math.round(d.distanceM)}m` : `${(d.distanceM / 1000).toFixed(1)}km`}</span>
          {/if}
        </div>
      </button>
    {/each}
  </div>
{/if}