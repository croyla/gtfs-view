<script lang="ts">
  let {
    dates = [],
    selectedDate = '',
    onSelect,
    direction = 'down',
  }: {
    dates: string[];
    selectedDate: string;
    onSelect: (date: string) => void;
    direction?: 'up' | 'down';
  } = $props();

  let open      = $state(false);
  let viewYear  = $state(0);
  let viewMonth = $state(0); // 0-indexed

  // Position of the fixed calendar popover (computed from trigger button rect)
  let popoverTop    = $state(0);
  let popoverBottom = $state(0);
  let popoverLeft   = $state(0);

  let triggerEl: HTMLButtonElement;

  const dateSet = $derived(new Set(dates));

  // Sync view to selected date whenever it changes
  $effect(() => {
    if (selectedDate.length === 8) {
      viewYear  = parseInt(selectedDate.slice(0, 4));
      viewMonth = parseInt(selectedDate.slice(4, 6)) - 1;
    }
  });

  const monthRange = $derived.by(() => {
    if (dates.length === 0) return { minY: 2024, minM: 0, maxY: 2025, maxM: 11 };
    const f = dates[0], l = dates.at(-1)!;
    return {
      minY: parseInt(f.slice(0, 4)), minM: parseInt(f.slice(4, 6)) - 1,
      maxY: parseInt(l.slice(0, 4)), maxM: parseInt(l.slice(4, 6)) - 1,
    };
  });

  const canPrev = $derived(
    viewYear > monthRange.minY || (viewYear === monthRange.minY && viewMonth > monthRange.minM)
  );
  const canNext = $derived(
    viewYear < monthRange.maxY || (viewYear === monthRange.maxY && viewMonth < monthRange.maxM)
  );

  function prevMonth() { if (viewMonth === 0) { viewMonth = 11; viewYear--; } else viewMonth--; }
  function nextMonth() { if (viewMonth === 11) { viewMonth = 0; viewYear++; } else viewMonth++; }

  interface Cell { dateStr: string | null; day: number | null; available: boolean; selected: boolean }

  const calendarCells = $derived.by((): Cell[] => {
    const y = viewYear, m = viewMonth;
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth  = new Date(y, m + 1, 0).getDate();
    const cells: Cell[] = [];
    for (let i = 0; i < firstWeekday; i++)
      cells.push({ dateStr: null, day: null, available: false, selected: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${String(y).padStart(4,'0')}${String(m+1).padStart(2,'0')}${String(d).padStart(2,'0')}`;
      cells.push({ dateStr, day: d, available: dateSet.has(dateStr), selected: dateStr === selectedDate });
    }
    return cells;
  });

  const monthLabel = $derived(
    new Date(viewYear, viewMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  );

  function formatSelected(yyyymmdd: string): string {
    if (yyyymmdd.length !== 8) return '—';
    const y = yyyymmdd.slice(0,4), m = yyyymmdd.slice(4,6), d = yyyymmdd.slice(6,8);
    return new Date(`${y}-${m}-${d}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  }

  function openCalendar() {
    const rect = triggerEl.getBoundingClientRect();
    // Center the popover horizontally under/above the trigger
    popoverLeft = rect.left + rect.width / 2;
    if (direction === 'up') {
      popoverBottom = window.innerHeight - rect.top + 6;
      popoverTop    = 0;
    } else {
      popoverTop    = rect.bottom + 6;
      popoverBottom = 0;
    }
    open = true;
  }

  function select(dateStr: string) {
    open = false;
    onSelect(dateStr);
  }

  function onWindowKeydown(e: KeyboardEvent) { if (e.key === 'Escape') open = false; }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="relative">
  <button
    bind:this={triggerEl}
    class="min-w-[140px] rounded-lg px-3 py-1.5 text-sm font-medium text-slate-200
           hover:bg-slate-700/60 transition-colors flex items-center gap-1 justify-center"
    onclick={openCalendar}
  >
    {formatSelected(selectedDate)}
    <svg class="h-3 w-3 text-slate-500 shrink-0" fill="none" viewBox="0 0 10 6" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M1 1l4 4 4-4"/>
    </svg>
  </button>
</div>

{#if open}
  <!-- Click-away backdrop — rendered at root level via fixed positioning -->
  <div
    class="fixed inset-0"
    style="z-index: 9998"
    onclick={() => (open = false)}
  ></div>

  <!-- Calendar popover — fixed so it escapes any ancestor stacking context -->
  <div
    class="fixed w-64 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3"
    style="z-index: 9999;
           left: {popoverLeft}px;
           transform: translateX(-50%);
           {direction === 'up'
             ? `bottom: ${popoverBottom}px;`
             : `top: ${popoverTop}px;`}"
  >
    <!-- Month header -->
    <div class="flex items-center justify-between mb-3">
      <button
        class="flex h-6 w-6 items-center justify-center rounded text-slate-400
               hover:text-white hover:bg-slate-700 disabled:opacity-25 transition-colors"
        onclick={prevMonth}
        disabled={!canPrev}
        aria-label="Previous month"
      >
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10 3L5 8l5 5"/>
        </svg>
      </button>
      <span class="text-xs font-semibold text-slate-200">{monthLabel}</span>
      <button
        class="flex h-6 w-6 items-center justify-center rounded text-slate-400
               hover:text-white hover:bg-slate-700 disabled:opacity-25 transition-colors"
        onclick={nextMonth}
        disabled={!canNext}
        aria-label="Next month"
      >
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 3l5 5-5 5"/>
        </svg>
      </button>
    </div>

    <!-- Weekday headers -->
    <div class="grid grid-cols-7 mb-1">
      {#each ['Su','Mo','Tu','We','Th','Fr','Sa'] as wd}
        <div class="text-center text-[10px] font-medium text-slate-600 pb-1">{wd}</div>
      {/each}
    </div>

    <!-- Day grid -->
    <div class="grid grid-cols-7 gap-y-0.5">
      {#each calendarCells as cell, idx (cell.dateStr ?? `e${idx}`)}
        {#if cell.dateStr === null}
          <div></div>
        {:else if cell.available}
          <button
            class="aspect-square w-full rounded text-[11px] font-medium transition-colors
                   {cell.selected ? 'bg-indigo-600 text-white' : 'text-slate-200 hover:bg-slate-700'}"
            onclick={() => select(cell.dateStr!)}
          >
            {cell.day}
          </button>
        {:else}
          <div class="aspect-square w-full flex items-center justify-center text-[11px] text-slate-700 select-none">
            {cell.day}
          </div>
        {/if}
      {/each}
    </div>

    <!-- Footer -->
    <div class="mt-2.5 border-t border-slate-800 pt-2 text-center text-[10px] text-slate-600">
      {dates.length} date{dates.length !== 1 ? 's' : ''} available
    </div>
  </div>
{/if}