<script lang="ts">
  import type { GtfsData } from './types';
  import type { VehiclePosition } from './liveTypes';
  import { makeEpochToMin } from './schedulePings';
  import type { BlockPingData, TripRecord } from './schedulePings';
  import {
    computeBlockMetrics, computeDataAvailability,
    computeTripCompletionFromStopMatches, computePunctualityFromCompletions,
    DEFAULT_PUNCT_SETTINGS,
    DATA_AVAIL_THRESHOLD, DATA_AVAIL_PENALTY_PCT,
  } from './scheduleMetrics';
  import type {
    TripCompletionResult, PunctualityMetrics, PunctualitySettings,
    DataAvailabilityMetrics, StopMatch,
  } from './scheduleMetrics';
  import { parseTimeMin, haversineKm } from './popupUtils';
  import MiniMap from './MiniMap.svelte';
  import PingAssociationEditor from './PingAssociationEditor.svelte';

  let {
    blockTripIds = [],
    gtfsData,
    pingData = null,
    livePositions = [],
    onActivatePicker  = undefined,
    onDeactivatePicker = undefined,
  }: {
    blockTripIds: string[];
    gtfsData: GtfsData;
    pingData?: BlockPingData | null;
    livePositions?: VehiclePosition[];
    onActivatePicker?:   (handler: (ping: VehiclePosition) => void) => void;
    onDeactivatePicker?: () => void;
  } = $props();

  const tz         = $derived([...gtfsData.agencies.values()][0]?.agency_timezone ?? 'UTC');
  const epochToMin = $derived(makeEpochToMin(tz));

  const sortedTripIds = $derived.by(() =>
    [...blockTripIds].sort((a, b) => {
      const aSts = gtfsData.stopTimesByTrip.get(a) ?? [];
      const bSts = gtfsData.stopTimesByTrip.get(b) ?? [];
      const aMin = aSts[0] ? parseTimeMin(aSts[0].departure_time || aSts[0].arrival_time) : 0;
      const bMin = bSts[0] ? parseTimeMin(bSts[0].departure_time || bSts[0].arrival_time) : 0;
      return aMin - bMin;
    })
  );

  // ── Persistent override storage ────────────────────────────────────────────
  const overrideStorageKey = $derived(`gtfs-overrides:${sortedTripIds.join(',')}`);

  function serializeOverrides(map: Map<string, Map<number, VehiclePosition | null>>): string {
    const obj: Record<string, Record<string, VehiclePosition | null>> = {};
    for (const [tid, tMap] of map) {
      obj[tid] = {};
      for (const [idx, ping] of tMap) obj[tid][String(idx)] = ping;
    }
    return JSON.stringify(obj);
  }

  function deserializeOverrides(raw: string): Map<string, Map<number, VehiclePosition | null>> {
    try {
      const obj = JSON.parse(raw) as Record<string, Record<string, VehiclePosition | null>>;
      return new Map(Object.entries(obj).map(([tid, idxMap]) => [
        tid,
        new Map(Object.entries(idxMap).map(([idx, ping]) => [Number(idx), ping])),
      ]));
    } catch { return new Map(); }
  }

  function saveOverrides(overrides: Map<string, Map<number, VehiclePosition | null>>) {
    if (overrides.size > 0) localStorage.setItem(overrideStorageKey, serializeOverrides(overrides));
    else localStorage.removeItem(overrideStorageKey);
  }

  // ── Punctuality settings (persistent) ─────────────────────────────────────
  const PUNCT_SETTINGS_KEY = 'gtfs-punct-settings';

  function loadPunctSettings(): PunctualitySettings {
    try {
      const raw = localStorage.getItem(PUNCT_SETTINGS_KEY);
      return raw ? { ...DEFAULT_PUNCT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_PUNCT_SETTINGS };
    } catch { return { ...DEFAULT_PUNCT_SETTINGS }; }
  }

  let punctSettings  = $state<PunctualitySettings>(loadPunctSettings());
  let draftSettings  = $state<PunctualitySettings>({ ...punctSettings });
  let showPunctSettings = $state(false);

  function applyPunctSettings() {
    punctSettings = { ...draftSettings };
    localStorage.setItem(PUNCT_SETTINGS_KEY, JSON.stringify(punctSettings));
  }

  // ── Base metrics — derived from pre-matched pingData prop (fast) ──────────
  let baseCompletions = $state<TripCompletionResult[]>([]);
  let tripRecords     = $state<TripRecord[]>([]);
  let dataAvail       = $state<DataAvailabilityMetrics>({ trips: [], totalPenaltyPct: 0 });

  $effect(() => {
    const pd  = pingData;
    const pos = livePositions;
    const data = gtfsData;

    if (!pd) { baseCompletions = []; tripRecords = []; return; }

    const metrics   = computeBlockMetrics(pd, pos, data);
    baseCompletions = metrics.completions;
    dataAvail       = metrics.dataAvailability;
    tripRecords     = metrics.tripRecords;
  });

  // Load overrides from localStorage whenever the block changes
  $effect(() => {
    const key = overrideStorageKey;
    const raw = localStorage.getItem(key);
    // Clear then restore so reactive consumers see the update
    overridesByTid = raw ? deserializeOverrides(raw) : new Map();
  });

  // ── Effective completions = base + user overrides (reactive, fast) ─────────
  const effectiveCompletions = $derived.by(() => {
    const etm  = epochToMin;
    const data = gtfsData;
    return baseCompletions.map(c => {
      const overrides = overridesByTid.get(c.tid);
      if (!overrides || overrides.size === 0) return c;
      const applied = c.stopMatches.map(sm => {
        if (!overrides.has(sm.stopIndex)) return sm;
        const ping = overrides.get(sm.stopIndex)!;
        if (ping === null) return { ...sm, matchedPing: null, matchedPingT: null, devMin: null, visited: false };
        const t = etm(ping.timestamp);
        return { ...sm, matchedPing: ping, matchedPingT: t, devMin: t - sm.schedMin, visited: true };
      });
      return computeTripCompletionFromStopMatches(c.tid, applied, data);
    });
  });

  // ── Punctuality = from effective completions + user settings (reactive) ────
  const punctuality = $derived.by(() =>
    computePunctualityFromCompletions(effectiveCompletions, punctSettings, gtfsData)
  );

  let expandedTid   = $state<string | null>(null);
  let showEditor    = $state(false);

  function handleEditorSave(overrides: Map<string, Map<number, VehiclePosition | null>>) {
    overridesByTid = overrides;
    saveOverrides(overrides);
    showEditor = false;
  }

  function toggleExpand(tid: string) {
    if (expandedTid === tid) {
      // Collapsing — clean up any active editing
      editingTid = null; editingStopIdx = null;
      onDeactivatePicker?.();
      expandedTid = null;
    } else {
      expandedTid = tid;
    }
  }

  // ── Per-trip ping overrides ────────────────────────────────────────────────
  // Maps tid → (stopIndex → overridden ping | null to mark unvisited)
  // Loaded from localStorage in $effect above; updated on user action.
  let overridesByTid  = $state(new Map<string, Map<number, VehiclePosition | null>>());
  // Which stop is currently being edited
  let editingTid      = $state<string | null>(null);
  let editingStopIdx  = $state<number | null>(null);

  function nearbyPingsForStop(stopLat: number, stopLon: number, maxKm = 0.5): VehiclePosition[] {
    return [...livePositions]
      .filter(p => haversineKm(p.lat, p.lon, stopLat, stopLon) < maxKm)
      .sort((a, b) => haversineKm(a.lat, a.lon, stopLat, stopLon) - haversineKm(b.lat, b.lon, stopLat, stopLon))
      .slice(0, 12);
  }

  function startEditing(tid: string, stopIdx: number, e: MouseEvent) {
    e.stopPropagation();
    const alreadyOpen = editingTid === tid && editingStopIdx === stopIdx;
    if (alreadyOpen) {
      editingTid = null; editingStopIdx = null;
      onDeactivatePicker?.();
    } else {
      editingTid = tid; editingStopIdx = stopIdx;
      onActivatePicker?.((ping) => assignPing(tid, stopIdx, ping));
    }
  }

  function assignPing(tid: string, stopIdx: number, ping: VehiclePosition | null) {
    const tMap = new Map(overridesByTid.get(tid) ?? []);
    tMap.set(stopIdx, ping);
    const next = new Map(overridesByTid).set(tid, tMap);
    overridesByTid  = next;
    saveOverrides(next);
    editingTid      = null;
    editingStopIdx  = null;
    onDeactivatePicker?.();
  }

  function clearOverride(tid: string, stopIdx: number, e: MouseEvent) {
    e.stopPropagation();
    const tMap = new Map(overridesByTid.get(tid) ?? []);
    tMap.delete(stopIdx);
    const next = new Map(overridesByTid).set(tid, tMap);
    overridesByTid = next;
    saveOverrides(next);
  }

  function fmtEpoch(ts: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(ts * 1000));
    const h = parts.find(p => p.type === 'hour')?.value   ?? '00';
    const m = parts.find(p => p.type === 'minute')?.value ?? '00';
    const s = parts.find(p => p.type === 'second')?.value ?? '00';
    return `${h}:${m}:${s}`;
  }

  function tierLabel(tier: string): string {
    if (tier === 'complete') return 'Complete';
    if (tier === 'no-data')  return 'No data';
    return tier + '% complete';
  }

  function tierClass(tier: string): string {
    if (tier === 'complete') return 'text-emerald-400';
    if (tier === 'no-data')  return 'text-slate-500';
    if (tier === '<25')      return 'text-red-400';
    if (tier === '25-60')    return 'text-orange-400';
    return 'text-yellow-400'; // 60-99
  }

  function fmtDev(dev: number | null): string {
    if (dev === null) return '—';
    const sign = dev > 0 ? '+' : '';
    return `${sign}${dev.toFixed(1)} min`;
  }

  function fmtPct(n: number, decimals = 1): string {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(decimals)}%`;
  }
</script>

<div class="space-y-8">

  <!-- ── Trip Completion ───────────────────────────────────────────────────── -->
  <section>
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-3">
        <h2 class="text-sm font-semibold text-slate-200">Trip Completion</h2>
        <span class="text-xs text-slate-500">
          Penalty applied to per-trip payment · Lost km not remunerated
        </span>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-md border border-indigo-700/60 bg-indigo-950/40 px-3 py-1.5
               text-xs font-medium text-indigo-300 hover:border-indigo-500 hover:bg-indigo-900/40
               hover:text-indigo-200 transition-colors"
        onclick={() => { showEditor = true; }}
      >
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M2 11.5l1.5-1.5 8-8a1.414 1.414 0 012 2l-8 8L4 13.5 2 14l.5-2.5zM11 3l2 2"/>
        </svg>
        Edit ping associations
      </button>
    </div>

    <div class="overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-4 py-2.5 text-left   text-[11px] font-medium uppercase tracking-wider text-slate-500">Trip</th>
            <th class="px-4 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Completion</th>
            <th class="px-4 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Scheduled km</th>
            <th class="px-4 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Lost km</th>
            <th class="px-4 py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-slate-500">Tier</th>
            <th class="px-4 py-2.5 text-right  text-[11px] font-medium uppercase tracking-wider text-slate-500">Deduction</th>
          </tr>
        </thead>
        <tbody>
          {#each effectiveCompletions as row (row.tid)}
            {@const isOpen       = expandedTid === row.tid}
            {@const hasOverrides = (overridesByTid.get(row.tid)?.size ?? 0) > 0}
            <tr
              class="border-b border-slate-800/50 cursor-pointer select-none transition-colors
                     {isOpen ? 'bg-slate-800/50' : 'hover:bg-slate-800/30'}"
              onclick={() => toggleExpand(row.tid)}
            >
              <td class="px-4 py-2.5 font-mono text-xs text-slate-400 flex items-center gap-1.5">
                <svg class="h-3 w-3 shrink-0 text-slate-600 transition-transform {isOpen ? 'rotate-90' : ''}"
                     fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 4l4 4-4 4"/>
                </svg>
                {row.tid}
                {#if hasOverrides}
                  <span class="text-amber-500" title="Has manual overrides">✎</span>
                {/if}
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-300">
                {row.tier === 'no-data' ? '—' : `${row.completionPct.toFixed(1)}%`}
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-400">{row.scheduledKm.toFixed(2)} km</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs {row.lostKm > 0 ? 'text-red-400' : 'text-slate-500'}">
                {row.lostKm > 0 ? row.lostKm.toFixed(2) + ' km' : '—'}
              </td>
              <td class="px-4 py-2.5 text-center">
                <span class="text-[11px] font-medium {tierClass(row.tier)}">{tierLabel(row.tier)}</span>
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-xs {row.penaltyPct > 0 ? 'text-red-400' : 'text-slate-500'}">
                {row.penaltyPct > 0 ? `−${row.penaltyPct}%` : '—'}
              </td>
            </tr>

            {#if isOpen}
              <tr class="border-b border-slate-800">
                <td colspan="6" class="p-0 bg-slate-950/60">

                  <!-- All-stops table -->
                  <div class="border-b border-slate-800/60">
                    <table class="w-full text-xs">
                      <thead>
                        <tr class="border-b border-slate-800/60">
                          <th class="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-slate-600 w-6">#</th>
                          <th class="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-slate-600">Stop</th>
                          <th class="px-4 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-600">Scheduled</th>
                          <th class="px-4 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-600">Observed</th>
                          <th class="px-4 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-600">Deviation</th>
                          <th class="px-4 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-slate-600 w-20">Edit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.stopMatches as sm (sm.stopIndex)}
                          {@const override    = overridesByTid.get(row.tid)?.get(sm.stopIndex)}
                          {@const isOverridden = override !== undefined}
                          {@const isEditing   = editingTid === row.tid && editingStopIdx === sm.stopIndex}
                          {@const stopObj     = gtfsData.stops.get(sm.stopId)}

                          <!-- Stop row -->
                          <tr class="border-b border-slate-800/30 {isEditing ? 'bg-indigo-950/30' : ''}">
                            <td class="px-4 py-2 text-slate-600 tabular-nums">{sm.stopIndex + 1}</td>
                            <td class="px-4 py-2">
                              <div class="flex items-center gap-2">
                                <!-- Status dot -->
                                {#if isOverridden}
                                  <span class="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Overridden"></span>
                                {:else if sm.visited}
                                  <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-500"></span>
                                {:else}
                                  <span class="h-2 w-2 shrink-0 rounded-full bg-red-500/70"></span>
                                {/if}
                                <span class="text-slate-300">{sm.stopName || sm.stopId}</span>
                              </div>
                            </td>
                            <td class="px-4 py-2 text-right font-mono text-slate-500">
                              {#if sm.schedMin >= 0}
                                {String(Math.floor(sm.schedMin / 60) % 24).padStart(2,'0')}:{String(Math.floor(sm.schedMin % 60)).padStart(2,'0')}
                              {:else}—{/if}
                            </td>
                            <td class="px-4 py-2 text-right font-mono">
                              {#if sm.matchedPing}
                                <span class="{isOverridden ? 'text-amber-400' : 'text-emerald-400'}">{fmtEpoch(sm.matchedPing.timestamp)}</span>
                              {:else}
                                <span class="text-slate-700">—</span>
                              {/if}
                            </td>
                            <td class="px-4 py-2 text-right font-mono">
                              {#if sm.devMin !== null}
                                <span class="{Math.abs(sm.devMin) > 5 ? 'text-orange-400' : 'text-slate-400'}">
                                  {sm.devMin > 0 ? '+' : ''}{sm.devMin.toFixed(1)}m
                                </span>
                              {:else}
                                <span class="text-slate-700">—</span>
                              {/if}
                            </td>
                            <td class="px-4 py-2 text-center">
                              <div class="flex items-center justify-center gap-1">
                                <button
                                  class="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors
                                         {isEditing ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'}"
                                  onclick={(e) => startEditing(row.tid, sm.stopIndex, e)}
                                >
                                  {isEditing ? 'Close' : 'Edit'}
                                </button>
                                {#if isOverridden}
                                  <button
                                    class="rounded px-1 py-0.5 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
                                    onclick={(e) => clearOverride(row.tid, sm.stopIndex, e)}
                                    title="Clear override"
                                  >✕</button>
                                {/if}
                              </div>
                            </td>
                          </tr>

                          <!-- Editing panel for this stop -->
                          {#if isEditing && stopObj}
                            {@const nearby = nearbyPingsForStop(stopObj.stop_lat, stopObj.stop_lon)}
                            <tr class="border-b border-slate-800/30 bg-indigo-950/20">
                              <td colspan="6" class="px-4 py-3">
                                <div class="flex gap-4">
                                  <!-- MiniMap for this stop -->
                                  <div class="w-56 shrink-0">
                                    {#if sm.matchedPing}
                                      <MiniMap
                                        pingLat={sm.matchedPing.lat}
                                        pingLon={sm.matchedPing.lon}
                                        stopLat={stopObj.stop_lat}
                                        stopLon={stopObj.stop_lon}
                                      />
                                    {:else}
                                      <div class="flex h-36 items-center justify-center rounded-lg border border-slate-800 text-[11px] text-slate-600">
                                        No ping matched
                                      </div>
                                    {/if}
                                    <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-600">
                                      <span class="flex items-center gap-1">
                                        <span class="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"></span> Ping
                                      </span>
                                      <span class="flex items-center gap-1">
                                        <span class="inline-block h-1.5 w-1.5 rounded-full bg-white"></span> Scheduled stop
                                      </span>
                                    </div>
                                  </div>

                                  <!-- Nearby pings list -->
                                  <div class="flex-1 min-w-0">
                                    <div class="mb-2 flex items-center gap-2">
                                      <span class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Assign a nearby ping</span>
                                      {#if onActivatePicker}
                                        <span class="text-[10px] text-violet-400">· or click a dot in the Space–Time chart above</span>
                                      {/if}
                                    </div>
                                    {#if nearby.length === 0}
                                      <p class="text-[11px] text-slate-600">No pings within 500 m of this stop.</p>
                                    {:else}
                                      <div class="space-y-1 max-h-40 overflow-y-auto pr-1">
                                        {#each nearby as p (p.timestamp + '-' + p.lat + '-' + p.lon)}
                                          {@const d = haversineKm(p.lat, p.lon, stopObj.stop_lat, stopObj.stop_lon)}
                                          {@const isCurrent = sm.matchedPing?.timestamp === p.timestamp && sm.matchedPing?.lat === p.lat}
                                          <button
                                            class="w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors
                                                   {isCurrent ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'}"
                                            onclick={(e) => { e.stopPropagation(); assignPing(row.tid, sm.stopIndex, p); }}
                                          >
                                            <span class="font-mono text-[11px]">{fmtEpoch(p.timestamp)}</span>
                                            <span class="text-[10px] text-slate-600">{(d * 1000).toFixed(0)} m away</span>
                                          </button>
                                        {/each}
                                      </div>
                                    {/if}
                                    {#if sm.visited}
                                      <button
                                        class="mt-2 rounded px-2 py-1 text-[10px] text-slate-600 hover:text-red-400 transition-colors"
                                        onclick={(e) => { e.stopPropagation(); assignPing(row.tid, sm.stopIndex, null); editingTid = null; editingStopIdx = null; }}
                                      >
                                        Clear match (mark as unvisited)
                                      </button>
                                    {/if}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          {/if}
                        {/each}
                      </tbody>
                    </table>
                  </div>

                  <!-- Footer legend + clear button -->
                  <div class="flex items-center justify-between px-4 py-2.5">
                    <div class="flex items-center gap-3 text-[11px] text-slate-600">
                      <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full bg-emerald-500"></span> Visited</span>
                      <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full bg-red-500/70"></span> Missed</span>
                      <span class="flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-full bg-amber-400"></span> Overridden · auto-saved</span>
                    </div>
                    {#if hasOverrides}
                      <button
                        class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-400 transition-colors"
                        onclick={(e) => { e.stopPropagation(); const next = new Map(overridesByTid); next.delete(row.tid); overridesByTid = next; saveOverrides(next); }}
                      >
                        Clear overrides
                      </button>
                    {/if}
                  </div>

                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    <div class="mt-2 flex gap-4 text-[11px] text-slate-600">
      <span>&lt;25% completion → 100% trip payment deducted</span>
      <span>25–60% → 75% deducted</span>
      <span>60–99% → 50% deducted</span>
      <span class="text-slate-700">Lost km not remunerated in all cases</span>
    </div>
  </section>

  <!-- ── Punctuality ───────────────────────────────────────────────────────── -->
  <section>
    <div class="mb-3 flex items-center justify-between gap-3">
      <div class="flex items-baseline gap-3">
        <h2 class="text-sm font-semibold text-slate-200">Punctuality</h2>
        <span class="text-xs text-slate-500">
          Start ±{punctuality.settings.startThresholdMin} min · End ±{punctuality.settings.endThresholdMin} min ·
          {punctuality.settings.startPenaltyPct}% / trip (start) · {punctuality.settings.endPenaltyPct}% / trip (end)
        </span>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400
               hover:border-slate-500 hover:text-slate-200 transition-colors"
        onclick={() => { showPunctSettings = !showPunctSettings; if (showPunctSettings) draftSettings = { ...punctSettings }; }}
      >
        <svg class="h-3 w-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M6.5 2a.5.5 0 000 1h.09a5 5 0 01.91 1.75l-.37.21a.5.5 0 00.5.87l.37-.21A5 5 0 009 7.09V7.5a.5.5 0 001 0v-.41a5 5 0 011-.57l.37.21a.5.5 0 10.5-.87l-.37-.21A5 5 0 0011.41 4h.09a.5.5 0 000-1H6.5z"/>
        </svg>
        Settings
      </button>
    </div>

    <!-- Settings panel -->
    {#if showPunctSettings}
      <div class="mb-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <div class="mb-3 text-xs font-medium text-slate-400">Punctuality thresholds &amp; penalty rates</div>
        <div class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {#each [
            { key: 'startThresholdMin' as const, label: 'Start threshold', unit: 'min', hint: '|dev| ≤ this = on time' },
            { key: 'endThresholdMin'   as const, label: 'End threshold',   unit: 'min', hint: '|dev| ≤ this = on time' },
            { key: 'startPenaltyPct'  as const, label: 'Start penalty',   unit: '% / trip', hint: 'per start violation' },
            { key: 'endPenaltyPct'    as const, label: 'End penalty',     unit: '% / trip', hint: 'per end violation' },
          ] as field}
            <label class="space-y-1">
              <div class="text-[10px] font-medium uppercase tracking-wider text-slate-500">{field.label}</div>
              <div class="flex items-center gap-1.5">
                <input
                  type="number"
                  min="0"
                  step={field.unit === 'min' ? '1' : '0.5'}
                  bind:value={draftSettings[field.key]}
                  class="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white
                         focus:border-indigo-500 focus:outline-none"
                />
                <span class="text-[10px] text-slate-600">{field.unit}</span>
              </div>
              <div class="text-[10px] text-slate-700">{field.hint}</div>
            </label>
          {/each}
        </div>
        <div class="mt-3 flex items-center gap-3">
          <button
            class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
            onclick={applyPunctSettings}
          >
            Apply
          </button>
          <button
            class="text-xs text-slate-600 hover:text-slate-400 transition-colors"
            onclick={() => { draftSettings = { ...DEFAULT_PUNCT_SETTINGS }; applyPunctSettings(); }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    {/if}

    <!-- Summary cards -->
    <div class="mb-4 grid grid-cols-2 gap-3">
      {#each [
        { label: 'Start on time', onTime: punctuality.startOnTimeCount, late: punctuality.startLateCount, noData: punctuality.startNoDataCount, penaltyPct: punctuality.startPenaltyPct, threshold: punctuality.settings.startThresholdMin },
        { label: 'End on time',   onTime: punctuality.endOnTimeCount,   late: punctuality.endLateCount,   noData: punctuality.endNoDataCount,   penaltyPct: punctuality.endPenaltyPct,   threshold: punctuality.settings.endThresholdMin   },
      ] as card}
        {@const total = card.onTime + card.late}
        <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div class="mb-1 text-xs text-slate-500">{card.label} <span class="text-slate-700">(±{card.threshold} min)</span></div>
          <div class="flex items-end gap-3">
            <span class="text-2xl font-semibold {card.late === 0 ? 'text-emerald-400' : 'text-red-400'}">
              {card.onTime}<span class="text-base text-slate-500">/{total}</span>
            </span>
            <span class="mb-0.5 text-xs text-slate-600">trips</span>
          </div>
          {#if card.noData > 0}
            <div class="text-[11px] text-slate-600">{card.noData} not observed</div>
          {/if}
          <div class="mt-1 text-xs {card.penaltyPct > 0 ? 'text-red-400' : 'text-slate-500'}">
            {card.penaltyPct > 0 ? `−${card.penaltyPct.toFixed(1)}% of monthly fee` : 'No deduction'}
          </div>
        </div>
      {/each}
    </div>

    <!-- Net total -->
    <div class="mb-4 flex items-center gap-2 text-xs text-slate-400">
      <span>Net punctuality deduction:</span>
      <span class="font-semibold {punctuality.totalNetPct > 0 ? 'text-red-400' : 'text-slate-400'}">
        {punctuality.totalNetPct > 0 ? `−${punctuality.totalNetPct.toFixed(1)}%` : 'None'} of monthly fee
      </span>
    </div>

    <!-- Per-trip table -->
    <div class="overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-4 py-2.5 text-left  text-[11px] font-medium uppercase tracking-wider text-slate-500">Trip</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Duration</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Start deviation</th>
            <th class="px-4 py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-slate-500">Start</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">End deviation</th>
            <th class="px-4 py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-slate-500">End</th>
          </tr>
        </thead>
        <tbody>
          {#each punctuality.trips as row (row.tid)}
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-slate-400">{row.tid}</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{row.durationMin} min</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs {row.startDevMin !== null ? (row.startOnTime ? 'text-emerald-400' : 'text-red-400') : 'text-slate-700'}">
                {fmtDev(row.startDevMin)}
              </td>
              <td class="px-4 py-2.5 text-center text-xs">
                {#if row.startOnTime === true}
                  <span class="text-emerald-400">✓</span>
                {:else if row.startOnTime === false}
                  <span class="text-red-400">✗</span>
                {:else}
                  <span class="text-slate-700">—</span>
                {/if}
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-xs {row.arrivalDevMin !== null ? (row.endOnTime ? 'text-emerald-400' : 'text-red-400') : 'text-slate-700'}">
                {fmtDev(row.arrivalDevMin)}
              </td>
              <td class="px-4 py-2.5 text-center text-xs">
                {#if row.endOnTime === true}
                  <span class="text-emerald-400">✓</span>
                {:else if row.endOnTime === false}
                  <span class="text-red-400">✗</span>
                {:else}
                  <span class="text-slate-700">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="mt-2 text-[11px] text-slate-600">
      ✓ = within threshold · ✗ = exceeded · — = not observed · Overrides auto-saved and applied to punctuality
    </p>
  </section>

  <!-- ── Data Availability ─────────────────────────────────────────────────── -->
  <section>
    <div class="mb-3 flex items-baseline gap-3">
      <h2 class="text-sm font-semibold text-slate-200">Data Availability</h2>
      <span class="text-xs text-slate-500">
        &lt;{DATA_AVAIL_THRESHOLD}% → {DATA_AVAIL_PENALTY_PCT}% of monthly fee per trip (uncapped) ·
        Expected: 1 ping / 30 s
      </span>
    </div>

    <div class="overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-800 bg-slate-900/60">
            <th class="px-4 py-2.5 text-left  text-[11px] font-medium uppercase tracking-wider text-slate-500">Trip</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Duration</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Pings received</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Expected</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Availability</th>
            <th class="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-slate-500">Penalty</th>
          </tr>
        </thead>
        <tbody>
          {#each dataAvail.trips as row (row.tid)}
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-slate-400">{row.tid}</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-400">{row.durationMin} min</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-400">{row.pingCount}</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs text-slate-600">{row.expectedPings}</td>
              <td class="px-4 py-2.5 text-right font-mono text-xs font-medium
                {row.availabilityPct >= DATA_AVAIL_THRESHOLD ? 'text-emerald-400' : 'text-red-400'}">
                {row.availabilityPct.toFixed(1)}%
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-xs {row.penalized ? 'text-red-400' : 'text-slate-600'}">
                {row.penalized ? `−${DATA_AVAIL_PENALTY_PCT}% / fee` : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr class="border-t border-slate-700 bg-slate-900/60">
            <td colspan="5" class="px-4 py-2.5 text-right text-xs text-slate-400">Total data availability penalty</td>
            <td class="px-4 py-2.5 text-right font-mono text-xs font-semibold {dataAvail.totalPenaltyPct > 0 ? 'text-red-400' : 'text-slate-500'}">
              {dataAvail.totalPenaltyPct > 0 ? `−${dataAvail.totalPenaltyPct}% / fee` : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>

</div>

{#if showEditor}
  <PingAssociationEditor
    {sortedTripIds}
    gtfsData={gtfsData}
    livePositions={livePositions}
    {effectiveCompletions}
    {epochToMin}
    onClose={() => { showEditor = false; }}
    onSave={handleEditorSave}
  />
{/if}