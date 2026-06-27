<script lang="ts">
  import type { GtfsData } from '../types/types';
  import type { VehiclePosition } from '../types/liveTypes';
  import type { TripCompletionResult } from '../services/schedule/scheduleMetrics';
  import { haversineKm, parseTimeMin } from '../services/popupUtils';

  let {
    sortedTripIds,
    gtfsData,
    livePositions,
    effectiveCompletions,
    epochToMin,
    onClose,
    onSave,
  }: {
    sortedTripIds:        string[];
    gtfsData:             GtfsData;
    livePositions:        VehiclePosition[];
    effectiveCompletions: TripCompletionResult[];
    epochToMin:           (epoch: number) => number;
    onClose:              () => void;
    onSave:               (overrides: Map<string, Map<number, VehiclePosition | null>>) => void;
  } = $props();

  // ── Colour palette ────────────────────────────────────────────────────────
  const PALETTE = [
    '#6366f1','#f59e0b','#10b981','#ef4444',
    '#8b5cf6','#14b8a6','#f97316','#3b82f6',
    '#ec4899','#84cc16','#fb7185','#38bdf8',
  ];
  const tripColors = new Map(sortedTripIds.map((tid, i) => [tid, PALETTE[i % PALETTE.length]]));

  // ── Canonical stops (Y axis — longest trip's sequence) ───────────────────
  interface CanonStop { stopId: string; stopName: string; isTerminus: boolean }

  const terminusIds = new Set<string>();
  for (const tid of sortedTripIds) {
    const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
    if (sts.length) { terminusIds.add(sts[0].stop_id); terminusIds.add(sts.at(-1)!.stop_id); }
  }

  const canonicalStops: CanonStop[] = (() => {
    let bestId = sortedTripIds[0] ?? '', bestLen = 0;
    for (const tid of sortedTripIds) {
      const n = (gtfsData.stopTimesByTrip.get(tid) ?? []).length;
      if (n > bestLen) { bestLen = n; bestId = tid; }
    }
    return (gtfsData.stopTimesByTrip.get(bestId) ?? []).map(st => ({
      stopId:     st.stop_id,
      stopName:   gtfsData.stops.get(st.stop_id)?.stop_name ?? st.stop_id,
      isTerminus: terminusIds.has(st.stop_id),
    }));
  })();

  const stopIdxMap = new Map(canonicalStops.map((s, i) => [s.stopId, i]));

  const canonStopPos = canonicalStops.map(s => {
    const st = gtfsData.stops.get(s.stopId);
    return st ? { lat: st.stop_lat, lon: st.stop_lon } : { lat: 0, lon: 0 };
  });

  // ── Time range ────────────────────────────────────────────────────────────
  let tMin = Infinity, tMax = -Infinity;
  for (const tid of sortedTripIds) {
    for (const st of gtfsData.stopTimesByTrip.get(tid) ?? []) {
      const t = parseTimeMin(st.departure_time || st.arrival_time);
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!isFinite(tMin)) { tMin = 0; tMax = 24 * 60; }
  tMin = Math.max(0, tMin - 15);
  tMax = Math.min(30 * 60, tMax + 15);

  // ── SVG layout ───────────────────────────────────────────────────────────
  const ML = 186, MR = 24, MT = 74, MB = 32;
  const STOP_H     = 28;
  const PX_PER_MIN = 2.5;

  const chartW = Math.max(400, (tMax - tMin) * PX_PER_MIN);
  const chartH = canonicalStops.length * STOP_H;
  const svgW   = ML + chartW + MR;
  const svgH   = MT + chartH + MB;

  function xOf(t: number)   { return ML + (t - tMin) * PX_PER_MIN; }
  function yOf(idx: number) { return MT + idx * STOP_H + STOP_H * 0.5; }

  function fmtMin(m: number) {
    const h = Math.floor(m / 60) % 24, mm = Math.round(m % 60);
    return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  }

  // ── Anchor model ─────────────────────────────────────────────────────────
  interface Anchor {
    ping:          VehiclePosition;
    t:             number;
    tripId:        string;
    stopId:        string;
    stopIdxInTrip: number;
    isAutomatic:   boolean;
  }

  function buildInitialAnchors(): Anchor[] {
    const result: Anchor[] = [];
    for (const c of effectiveCompletions) {
      const first = c.stopMatches.find(sm => sm.visited);
      const last  = [...c.stopMatches].reverse().find(sm => sm.visited);
      if (first?.matchedPing) {
        result.push({
          ping: first.matchedPing, t: first.matchedPingT!,
          tripId: c.tid, stopId: first.stopId, stopIdxInTrip: first.stopIndex,
          isAutomatic: true,
        });
      }
      if (last && last !== first && last.matchedPing) {
        result.push({
          ping: last.matchedPing, t: last.matchedPingT!,
          tripId: c.tid, stopId: last.stopId, stopIdxInTrip: last.stopIndex,
          isAutomatic: true,
        });
      }
    }
    return result;
  }

  let anchors = $state<Anchor[]>(buildInitialAnchors());

  // ── Processed pings ──────────────────────────────────────────────────────
  interface PingNode {
    raw:        VehiclePosition;
    t:          number;
    stopIdx:    number;
    tripId:     string | null;
    color:      string;
    isExplicit: boolean;
    isManual:   boolean;
  }

  const processedPings = $derived.by((): PingNode[] => {
    const sortedAnchors = [...anchors].sort((a, b) => a.t - b.t);

    return livePositions.map(p => {
      const t = epochToMin(p.timestamp);

      let bestStopIdx = 0, bestDist = Infinity;
      for (let i = 0; i < canonStopPos.length; i++) {
        const d = haversineKm(canonStopPos[i].lat, canonStopPos[i].lon, p.lat, p.lon);
        if (d < bestDist) { bestDist = d; bestStopIdx = i; }
      }

      const anchor = sortedAnchors.find(a =>
        a.ping.timestamp === p.timestamp && a.ping.vehicle_id === p.vehicle_id
      );
      if (anchor) {
        const canonIdx = stopIdxMap.get(anchor.stopId) ?? bestStopIdx;
        return {
          raw: p, t, stopIdx: canonIdx, tripId: anchor.tripId,
          color: tripColors.get(anchor.tripId) ?? '#64748b',
          isExplicit: true, isManual: !anchor.isAutomatic,
        };
      }

      const prev = sortedAnchors.filter(a => a.t <= t).at(-1);
      const next = sortedAnchors.find(a => a.t >= t);
      let tripId: string | null = null;
      if (prev && next && prev.tripId === next.tripId) {
        tripId = prev.tripId;
      } else if (prev && next) {
        tripId = t <= (prev.t + next.t) / 2 ? prev.tripId : next.tripId;
      } else if (prev) {
        tripId = prev.tripId;
      } else if (next) {
        tripId = next.tripId;
      }

      return {
        raw: p, t, stopIdx: bestStopIdx, tripId,
        color: tripId ? (tripColors.get(tripId) ?? '#64748b') : '#475569',
        isExplicit: false, isManual: false,
      };
    });
  });

  // ── Click / selection state ───────────────────────────────────────────────
  let selectedIdx  = $state<number | null>(null);
  let popupClientX = $state(0);
  let popupClientY = $state(0);

  function onPingClick(e: MouseEvent, idx: number) {
    e.stopPropagation();
    if (selectedIdx === idx) { selectedIdx = null; return; }
    selectedIdx  = idx;
    popupClientX = e.clientX;
    popupClientY = e.clientY;
  }

  function dismissPopup() { selectedIdx = null; }

  // Clamp popup position so it stays inside the viewport
  const POPUP_W = 220, POPUP_H = 180;
  const popupStyle = $derived.by(() => {
    if (selectedIdx === null) return '';
    const x = Math.min(popupClientX + 12, window.innerWidth  - POPUP_W - 8);
    const y = Math.min(popupClientY + 12, window.innerHeight - POPUP_H - 8);
    return `left:${x}px;top:${y}px`;
  });

  // ── Anchor mutations ─────────────────────────────────────────────────────
  function removeAnchor(pingIdx: number) {
    const pp = processedPings[pingIdx];
    anchors = anchors.filter(a =>
      !(a.ping.timestamp === pp.raw.timestamp && a.ping.vehicle_id === pp.raw.vehicle_id)
    );
    selectedIdx = null;
  }

  function assignToTrip(pingIdx: number, tid: string) {
    const pp  = processedPings[pingIdx];
    const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
    // nearest stop on this trip by scheduled time proximity to the ping's observed time
    let bestSt = sts[0], bestDt = Infinity;
    for (const st of sts) {
      const dt = Math.abs(parseTimeMin(st.departure_time || st.arrival_time) - pp.t);
      if (dt < bestDt) { bestDt = dt; bestSt = st; }
    }
    if (!bestSt) return;
    anchors = [
      ...anchors.filter(a =>
        !(a.ping.timestamp === pp.raw.timestamp && a.ping.vehicle_id === pp.raw.vehicle_id)
      ),
      {
        ping: pp.raw, t: pp.t,
        tripId: tid, stopId: bestSt.stop_id,
        stopIdxInTrip: sts.indexOf(bestSt),
        isAutomatic: false,
      },
    ];
    selectedIdx = null;
  }

  // ── Trip line helpers ─────────────────────────────────────────────────────
  function tripPolyPoints(tid: string): string {
    return (gtfsData.stopTimesByTrip.get(tid) ?? [])
      .map(st => {
        const idx = stopIdxMap.get(st.stop_id);
        if (idx === undefined) return null;
        return `${xOf(parseTimeMin(st.departure_time || st.arrival_time)).toFixed(1)},${yOf(idx).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  }

  function tripLabelX(tid: string): number {
    const sts = gtfsData.stopTimesByTrip.get(tid) ?? [];
    if (!sts.length) return ML;
    const t0 = parseTimeMin(sts[0].departure_time || sts[0].arrival_time);
    const t1 = parseTimeMin(sts.at(-1)!.arrival_time || sts.at(-1)!.departure_time);
    return xOf((t0 + t1) / 2);
  }

  const timeTicks: number[] = (() => {
    const step  = (tMax - tMin) > 300 ? 60 : 30;
    const start = Math.ceil(tMin / step) * step;
    const ticks: number[] = [];
    for (let t = start; t <= tMax; t += step) ticks.push(t);
    return ticks;
  })();

  // ── Save ──────────────────────────────────────────────────────────────────
  function save() {
    const overrides = new Map<string, Map<number, VehiclePosition | null>>();
    for (const a of anchors.filter(a => !a.isAutomatic)) {
      const tMap = overrides.get(a.tripId) ?? new Map<number, VehiclePosition | null>();
      tMap.set(a.stopIdxInTrip, a.ping);
      overrides.set(a.tripId, tMap);
    }
    onSave(overrides);
  }

  const manualCount = $derived(anchors.filter(a => !a.isAutomatic).length);
</script>

<!-- Popup (rendered at document root level via fixed positioning) -->
{#if selectedIdx !== null}
  {@const pp      = processedPings[selectedIdx]}
  {@const isAnch  = pp.isExplicit}
  <div
    class="fixed z-[60] w-[220px] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
    style={popupStyle}
    onclick={(e) => e.stopPropagation()}
    role="dialog"
  >
    <!-- Popup header -->
    <div class="flex items-center justify-between border-b border-slate-800 px-3 py-2">
      <div class="flex items-center gap-2">
        <span
          class="inline-block h-2.5 w-2.5 rounded-full"
          style="background:{pp.color}"
        ></span>
        <span class="text-[11px] font-medium text-slate-300">
          {#if isAnch}
            {pp.isManual ? 'Manual anchor' : 'Auto anchor'}
          {:else}
            {pp.tripId ? 'Inferred ping' : 'Unassigned ping'}
          {/if}
        </span>
      </div>
      <button
        class="text-slate-600 hover:text-slate-400 transition-colors"
        onclick={dismissPopup}
        aria-label="Close"
      >
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4l8 8M12 4l-8 8"/>
        </svg>
      </button>
    </div>

    <div class="p-3 space-y-2.5">
      <!-- Current assignment label -->
      {#if pp.tripId}
        <p class="text-[10px] text-slate-500">
          {isAnch ? 'Anchored to' : 'Inferred as'}: <span style="color:{pp.color}">{pp.tripId}</span>
        </p>
      {/if}

      <!-- Trip assignment buttons -->
      <div>
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
          {isAnch ? 'Reassign anchor to' : 'Add anchor for trip'}
        </p>
        <div class="flex flex-wrap gap-1.5">
          {#each sortedTripIds as tid}
            {@const col       = tripColors.get(tid) ?? '#6366f1'}
            {@const isCurrent = pp.tripId === tid && isAnch}
            <button
              class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors
                     {isCurrent
                       ? 'ring-1 ring-white/30 text-white'
                       : 'text-slate-400 hover:text-white'}"
              style="background:{col}25; {isCurrent ? `outline:1px solid ${col}` : ''}"
              onclick={() => assignToTrip(selectedIdx!, tid)}
            >
              <span class="inline-block h-2 w-2 rounded-full shrink-0" style="background:{col}"></span>
              {tid}
            </button>
          {/each}
        </div>
      </div>

      <!-- Remove anchor (only for explicit anchors) -->
      {#if isAnch}
        <div class="pt-1 border-t border-slate-800">
          <button
            class="w-full rounded-md py-1 text-[11px] text-slate-600 hover:text-red-400 hover:bg-red-950/30 transition-colors"
            onclick={() => removeAnchor(selectedIdx!)}
          >
            {pp.isManual ? 'Remove manual anchor' : 'Remove auto anchor'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Modal backdrop -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3"
  role="dialog"
  aria-modal="true"
  onclick={() => { dismissPopup(); onClose(); }}
>
  <!-- Panel -->
  <div
    class="flex flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
    style="width: min(98vw, {svgW + 32}px); max-height: 92vh"
    onclick={(e) => e.stopPropagation()}
    role="document"
  >
    <!-- Header -->
    <div class="flex shrink-0 items-start justify-between border-b border-slate-800 px-5 py-3.5">
      <div>
        <h2 class="text-sm font-semibold text-slate-100">Edit Ping Associations</h2>
        <p class="mt-0.5 text-[11px] text-slate-500">
          Click any ping to assign it to a trip.
          <span class="text-slate-400">Large dots</span> = anchors (explicit boundaries).
          <span class="text-slate-600">Small dots</span> = inferred from surrounding anchors.
          Auto-anchors mark where the algorithm detected trip changes.
        </p>
      </div>
      <button
        class="ml-4 shrink-0 rounded-lg p-1.5 text-slate-500 hover:text-slate-200 transition-colors"
        onclick={onClose}
        aria-label="Close"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4l8 8M12 4l-8 8"/>
        </svg>
      </button>
    </div>

    <!-- Trip legend -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-slate-800 px-5 py-2">
      {#each sortedTripIds as tid}
        {@const col = tripColors.get(tid)}
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="inline-block h-1 w-6 rounded-full" style="background:{col}"></span>
          <span class="text-slate-300">{tid}</span>
        </div>
      {/each}
      <div class="ml-auto flex items-center gap-4 text-[10px] text-slate-600">
        <span class="flex items-center gap-1">
          <span class="inline-block h-2.5 w-2.5 rounded-full border border-white/40 bg-indigo-500"></span>
          auto anchor
        </span>
        <span class="flex items-center gap-1">
          <span class="inline-block h-2.5 w-2.5 rounded-full border-2 border-white bg-indigo-500"></span>
          manual anchor
        </span>
        <span class="flex items-center gap-1">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-slate-500"></span>
          inferred
        </span>
      </div>
    </div>

    <!-- SVG chart (scrollable) -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="flex-1 overflow-auto" onclick={dismissPopup}>
      <svg
        viewBox="0 0 {svgW} {svgH}"
        width={svgW}
        height={svgH}
        style="display:block; min-width:{svgW}px"
      >
        <rect width={svgW} height={svgH} fill="#0f172a"/>

        <defs>
          <clipPath id="pae-clip">
            <rect x={ML} y={MT} width={chartW} height={chartH}/>
          </clipPath>
        </defs>

        <!-- Stop grid lines + Y labels -->
        {#each canonicalStops as stop, i}
          {@const y = yOf(i)}
          <line
            x1={ML} x2={svgW - MR} y1={y} y2={y}
            stroke={stop.isTerminus ? '#334155' : '#1e293b'}
            stroke-width={stop.isTerminus ? 1 : 0.5}
            stroke-dasharray={stop.isTerminus ? '' : '4 4'}
          />
          <text
            x={ML - 8} y={y + 4}
            text-anchor="end"
            font-size={stop.isTerminus ? '11' : '10'}
            fill={stop.isTerminus ? '#cbd5e1' : '#475569'}
            font-weight={stop.isTerminus ? 'bold' : 'normal'}
          >{stop.stopName.length > 25 ? stop.stopName.slice(0, 24) + '…' : stop.stopName}</text>
        {/each}

        <!-- Time grid + X labels -->
        {#each timeTicks as t}
          {@const x = xOf(t)}
          <line x1={x} x2={x} y1={MT} y2={MT + chartH} stroke="#1e293b" stroke-width="0.5"/>
          <text x={x} y={MT - 8} text-anchor="middle" font-size="9" fill="#475569">{fmtMin(t)}</text>
        {/each}

        <!-- Trip scheduled lines -->
        {#each sortedTripIds as tid}
          {@const pts   = tripPolyPoints(tid)}
          {@const color = tripColors.get(tid) ?? '#6366f1'}
          {#if pts}
            <polyline
              points={pts}
              fill="none"
              stroke={color}
              stroke-width="1.5"
              opacity="0.5"
              clip-path="url(#pae-clip)"
            />
          {/if}
        {/each}

        <!-- Trip ID labels -->
        {#each sortedTripIds as tid}
          {@const lx    = tripLabelX(tid)}
          {@const color = tripColors.get(tid) ?? '#6366f1'}
          <line x1={lx} x2={lx} y1={MT - 16} y2={MT} stroke={color} stroke-width="1" opacity="0.35"/>
          <text x={lx} y={MT - 20} text-anchor="middle" font-size="10" fill={color} font-weight="600">{tid}</text>
        {/each}

        <!-- Inferred / unassigned pings (render first, under anchors) -->
        {#each processedPings as pp, i}
          {#if !pp.isExplicit}
            {@const isSelected = selectedIdx === i}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <g style="cursor:pointer" onclick={(e) => onPingClick(e, i)} clip-path="url(#pae-clip)">
              <circle cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="8" fill="transparent"/>
              <circle
                cx={xOf(pp.t)} cy={yOf(pp.stopIdx)}
                r={isSelected ? 5 : (pp.tripId ? 3 : 2.5)}
                fill={pp.color}
                opacity={isSelected ? 0.9 : (pp.tripId ? 0.45 : 0.2)}
              />
              {#if isSelected}
                <circle
                  cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="5"
                  fill="none" stroke="#fff" stroke-width="1.5" opacity="0.7"
                />
              {/if}
            </g>
          {/if}
        {/each}

        <!-- Explicit anchors (render on top) -->
        {#each processedPings as pp, i}
          {#if pp.isExplicit}
            {@const isSelected = selectedIdx === i}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <g style="cursor:pointer" onclick={(e) => onPingClick(e, i)} clip-path="url(#pae-clip)">
              <!-- Glow ring -->
              <circle cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="13" fill={pp.color} opacity={isSelected ? 0.2 : 0.08}/>
              <!-- Main dot -->
              <circle cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="7" fill={pp.color} opacity={isSelected ? 1 : 0.9}/>
              <!-- Ring: white for manual, subtle for auto -->
              <circle
                cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="7"
                fill="none"
                stroke={pp.isManual ? '#ffffff' : pp.color}
                stroke-width={pp.isManual ? 2 : 1}
                opacity={pp.isManual ? 0.85 : 0.4}
              />
              <!-- Selection outer ring -->
              {#if isSelected}
                <circle
                  cx={xOf(pp.t)} cy={yOf(pp.stopIdx)} r="11"
                  fill="none" stroke="#fff" stroke-width="1.5" opacity="0.5"
                />
              {/if}
            </g>
          {/if}
        {/each}

        <!-- Bottom axis line -->
        <line x1={ML} x2={svgW - MR} y1={MT + chartH} y2={MT + chartH} stroke="#334155" stroke-width="1"/>
      </svg>
    </div>

    <!-- Footer -->
    <div class="flex shrink-0 items-center justify-between border-t border-slate-800 px-5 py-3">
      <p class="text-[11px] text-slate-600">
        {manualCount > 0
          ? `${manualCount} manual anchor${manualCount > 1 ? 's' : ''}`
          : 'No manual anchors yet — click any dot to assign it'}
        · Saves to per-stop overrides
      </p>
      <div class="flex items-center gap-3">
        <button
          class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          onclick={onClose}
        >Cancel</button>
        <button
          class="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
          onclick={save}
        >Save associations</button>
      </div>
    </div>
  </div>
</div>