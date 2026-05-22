<script lang="ts">
  import type { GtfsDiff } from './diffGtfs';
  import type { CardEntry, DiffFilter } from './popupTypes';

  let {
    diff,
    onNavigate,
  }: {
    diff: GtfsDiff;
    onNavigate: (card: CardEntry) => void;
  } = $props();

  interface Section {
    label: string;
    type: 'diff-stops' | 'diff-routes' | 'diff-trips';
    rows: { filter: DiffFilter; label: string; count: number; color: string }[];
  }

  const sections: Section[] = [
    {
      label: 'Stops',
      type: 'diff-stops',
      rows: [
        { filter: 'added',     label: 'Added',   count: diff.stopsAdded,     color: 'text-emerald-400' },
        { filter: 'removed',   label: 'Removed', count: diff.stopsRemoved,   color: 'text-red-400' },
        { filter: 'moved',     label: 'Moved',   count: diff.stopsMoved,     color: 'text-sky-400' },
        { filter: 'unchanged', label: 'Same',    count: diff.stopsUnchanged, color: 'text-slate-300' },
      ],
    },
    {
      label: 'Routes',
      type: 'diff-routes',
      rows: [
        { filter: 'added',     label: 'Added',   count: diff.routesAdded,     color: 'text-emerald-400' },
        { filter: 'removed',   label: 'Removed', count: diff.routesRemoved,   color: 'text-red-400' },
        { filter: 'changed',   label: 'Changed', count: diff.routesChanged,   color: 'text-sky-400' },
        { filter: 'unchanged', label: 'Same',    count: diff.routesUnchanged, color: 'text-slate-300' },
      ],
    },
    {
      label: 'Trips',
      type: 'diff-trips',
      rows: [
        { filter: 'added',     label: 'Added',   count: diff.tripsAdded,     color: 'text-emerald-400' },
        { filter: 'removed',   label: 'Removed', count: diff.tripsRemoved,   color: 'text-red-400' },
        { filter: 'changed',   label: 'Changed', count: diff.tripsChanged,   color: 'text-amber-400' },
        { filter: 'unchanged', label: 'Same',    count: diff.tripsUnchanged, color: 'text-slate-300' },
      ],
    },
  ];

  function totalChanged(s: Section): number {
    return s.rows.reduce((a, r) => a + r.count, 0);
  }
</script>

<div class="space-y-4">
  <p class="text-xs text-slate-400">Differences between the base feed and the comparison feed.</p>

  {#each sections as section (section.label)}
    {@const total = totalChanged(section)}
    <div class="rounded-xl border border-slate-700 overflow-hidden">
      <!-- Section header -->
      <button
        class="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800 transition-colors text-left"
        onclick={() => onNavigate({ type: section.type, filter: 'all' })}
      >
        <span class="text-sm font-semibold text-white">{section.label}</span>
        {#if total === 0}
          <span class="text-xs text-slate-500">No changes</span>
        {:else}
          <svg class="h-4 w-4 text-slate-500" viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>

      {#if total > 0}
        <!-- Change counts -->
        <div class="border-t border-slate-700 px-4 py-2 grid grid-cols-2 gap-2">
          {#each section.rows as row (row.filter)}
            {#if row.count > 0}
              <button
                class="flex flex-col items-center gap-0.5 rounded-lg py-2 hover:bg-slate-800 transition-colors"
                onclick={() => onNavigate({ type: section.type, filter: row.filter })}
              >
                <span class="text-lg font-bold tabular-nums {row.color}">{row.count}</span>
                <span class="text-[10px] uppercase tracking-wide text-slate-500">{row.label}</span>
              </button>
            {:else}
              <div class="flex flex-col items-center gap-0.5 py-2 opacity-30">
                <span class="text-lg font-bold tabular-nums text-slate-500">0</span>
                <span class="text-[10px] uppercase tracking-wide text-slate-600">{row.label}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <!-- Shapes summary (display only) -->
  {#if diff.shapesAdded + diff.shapesRemoved + diff.shapesChanged > 0}
    <div class="rounded-xl border border-slate-700 px-4 py-3">
      <p class="text-sm font-semibold text-white mb-2">Shapes</p>
      <div class="flex gap-4 text-xs">
        {#if diff.shapesAdded   > 0}<span class="text-emerald-400">{diff.shapesAdded} added</span>{/if}
        {#if diff.shapesRemoved > 0}<span class="text-red-400">{diff.shapesRemoved} removed</span>{/if}
        {#if diff.shapesChanged > 0}<span class="text-sky-400">{diff.shapesChanged} changed</span>{/if}
      </div>
    </div>
  {/if}
</div>