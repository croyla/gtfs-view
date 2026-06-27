<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { LiveProcessed } from '../services/live/liveStopTimes';
  import type { ExportScope, ReportType } from '../services/exportReport';
  import {
    scopeLabel,
    computeTripCompletion,
    computeDataAvailability,
    computePunctuality,
    downloadJson,
    openHtmlOrPdf,
  } from '../services/exportReport';

  let {
    scope,
    gtfsData,
    liveProcessed,
    onClose,
  }: {
    scope: ExportScope;
    gtfsData: GtfsData;
    liveProcessed: LiveProcessed;
    onClose: () => void;
  } = $props();

  let reportType = $state<ReportType>('trip-completion');

  // Settings
  let radialDistanceM = $state(50);
  let expectedIntervalS = $state(30);
  let punctualityRadiusM = $state(50);
  let bufferMinutes = $state(3);

  let exporting = $state(false);

  const label = $derived(scopeLabel(scope, gtfsData));

  const reportOptions: { type: ReportType; title: string; desc: string }[] = [
    {
      type: 'trip-completion',
      title: 'Trip Completion',
      desc: 'Stops touched vs. planned stops per trip, based on vehicle proximity.',
    },
    {
      type: 'data-availability',
      title: 'Data Availability',
      desc: 'Gaps between vehicle position pings for each trip.',
    },
    {
      type: 'punctuality',
      title: 'Punctuality',
      desc: 'Actual vs. scheduled stop times based on nearest vehicle ping.',
    },
  ];

  async function doExport(format: 'json' | 'html' | 'pdf') {
    exporting = true;
    try {
      await new Promise(r => setTimeout(r, 0)); // let UI update
      if (reportType === 'trip-completion') {
        const report = computeTripCompletion(scope, gtfsData, liveProcessed, { radialDistanceM });
        if (format === 'json') downloadJson(report);
        else openHtmlOrPdf(report, format === 'pdf');
      } else if (reportType === 'data-availability') {
        const report = computeDataAvailability(scope, gtfsData, liveProcessed, { expectedIntervalS });
        if (format === 'json') downloadJson(report);
        else openHtmlOrPdf(report, format === 'pdf');
      } else {
        const report = computePunctuality(scope, gtfsData, liveProcessed, {
          radialDistanceM: punctualityRadiusM,
          bufferMinutes,
        });
        if (format === 'json') downloadJson(report);
        else openHtmlOrPdf(report, format === 'pdf');
      }
    } finally {
      exporting = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<div
  class="fixed inset-0 z-[60] flex items-center justify-center p-4"
  role="dialog"
  aria-modal="true"
  onclick={handleBackdrop}
>
  <div class="absolute inset-0 bg-black/70 backdrop-blur-sm"></div>

  <div class="relative z-10 w-full max-w-md bg-slate-900 rounded-2xl shadow-2xl border border-slate-700 flex flex-col max-h-[90vh]">
    <!-- Header -->
    <div class="flex items-center gap-2 px-5 py-3.5 border-b border-slate-700 shrink-0">
      <svg class="h-4 w-4 text-indigo-400 shrink-0" viewBox="0 0 16 16" fill="none">
        <path d="M2 10.5v1.75A1.75 1.75 0 003.75 14h8.5A1.75 1.75 0 0014 12.25V10.5M8 2v8m-3-3l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold text-white">Export Report</h2>
        <p class="text-[10px] text-slate-500 truncate">{label}</p>
      </div>
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

    <!-- Body -->
    <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">

      <!-- Report type selection -->
      <div>
        <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Report type</p>
        <div class="space-y-1.5">
          {#each reportOptions as opt (opt.type)}
            <label class="flex gap-3 items-start rounded-lg border cursor-pointer px-3.5 py-3 transition-colors
              {reportType === opt.type ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-700 hover:border-slate-600'}">
              <input
                type="radio"
                class="mt-0.5 accent-indigo-500 shrink-0"
                name="reportType"
                value={opt.type}
                checked={reportType === opt.type}
                onchange={() => (reportType = opt.type)}
              />
              <div>
                <p class="text-sm font-medium text-slate-200">{opt.title}</p>
                <p class="text-[11px] text-slate-400 leading-snug mt-0.5">{opt.desc}</p>
              </div>
            </label>
          {/each}
        </div>
      </div>

      <!-- Settings -->
      <div>
        <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Settings</p>
        <div class="rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3 space-y-3">

          {#if reportType === 'trip-completion'}
            <div>
              <label class="block text-xs text-slate-300 mb-1.5">
                Stop touch radius <span class="text-slate-500">(metres)</span>
              </label>
              <p class="text-[10px] text-slate-500 mb-2">A stop is counted as touched if any vehicle ping falls within this distance of the stop centre.</p>
              <div class="flex items-center gap-3">
                <input
                  type="range" min="10" max="500" step="10"
                  class="flex-1 accent-indigo-500"
                  bind:value={radialDistanceM}
                />
                <span class="text-sm font-mono text-indigo-300 w-12 text-right">{radialDistanceM}m</span>
              </div>
            </div>

          {:else if reportType === 'data-availability'}
            <div>
              <label class="block text-xs text-slate-300 mb-1.5">
                Expected ping interval <span class="text-slate-500">(seconds)</span>
              </label>
              <p class="text-[10px] text-slate-500 mb-2">Gaps between consecutive position pings longer than this are flagged as data gaps.</p>
              <div class="flex items-center gap-3">
                <input
                  type="range" min="5" max="300" step="5"
                  class="flex-1 accent-indigo-500"
                  bind:value={expectedIntervalS}
                />
                <span class="text-sm font-mono text-indigo-300 w-14 text-right">{expectedIntervalS}s</span>
              </div>
            </div>

          {:else}
            <div class="space-y-3">
              <div>
                <label class="block text-xs text-slate-300 mb-1.5">
                  Stop match radius <span class="text-slate-500">(metres)</span>
                </label>
                <p class="text-[10px] text-slate-500 mb-2">If no ping falls within this radius the stop is considered skipped; otherwise the nearest ping is used as the arrival time.</p>
                <div class="flex items-center gap-3">
                  <input
                    type="range" min="10" max="500" step="10"
                    class="flex-1 accent-indigo-500"
                    bind:value={punctualityRadiusM}
                  />
                  <span class="text-sm font-mono text-indigo-300 w-12 text-right">{punctualityRadiusM}m</span>
                </div>
              </div>
              <div>
                <label for="buffer-range" class="block text-xs text-slate-300 mb-1.5">
                  On-time buffer <span class="text-slate-500">(minutes)</span>
                </label>
                <p class="text-[10px] text-slate-500 mb-2">Arrivals within this many minutes of the scheduled time are considered on time.</p>
                <div class="flex items-center gap-3">
                  <input
                    id="buffer-range"
                    type="range" min="0" max="15" step="0.5"
                    class="flex-1 accent-indigo-500"
                    bind:value={bufferMinutes}
                  />
                  <span class="text-sm font-mono text-indigo-300 w-14 text-right">{bufferMinutes}min</span>
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Export format buttons -->
    <div class="border-t border-slate-700 px-5 py-3.5 shrink-0">
      <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2.5">Export as</p>
      <div class="grid grid-cols-3 gap-2">
        {#each [
          { fmt: 'json' as const, label: 'JSON', icon: '{}', hint: 'Raw data' },
          { fmt: 'html' as const, label: 'HTML', icon: '<>', hint: 'Styled report' },
          { fmt: 'pdf'  as const, label: 'PDF',  icon: '▣',  hint: 'Print / save' },
        ] as btn (btn.fmt)}
          <button
            class="flex flex-col items-center gap-1 rounded-lg border border-slate-600 py-2.5 px-2 hover:border-indigo-500 hover:bg-indigo-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            onclick={() => doExport(btn.fmt)}
            disabled={exporting}
          >
            <span class="text-base font-mono text-indigo-300">{btn.icon}</span>
            <span class="text-xs font-semibold text-slate-200">{btn.label}</span>
            <span class="text-[9px] text-slate-500">{btn.hint}</span>
          </button>
        {/each}
      </div>
      {#if exporting}
        <p class="text-[10px] text-slate-500 mt-2 text-center">Computing report…</p>
      {/if}
    </div>
  </div>
</div>