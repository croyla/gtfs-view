<script lang="ts">
  export interface TripPunctuality {
    idx:           number;
    tid:           string;
    schedStart:    string;
    schedEnd:      string;
    schedStartMin: number;
    schedEndMin:   number;
    obsStartT:     number | null;
    obsEndT:       number | null;
  }

  let {
    trips,
    startThreshold,
    endThreshold,
  }: {
    trips:          TripPunctuality[];
    startThreshold: number;
    endThreshold:   number;
  } = $props();

  function fmtObs(t: number | null): string {
    if (t === null) return '—';
    const h = Math.floor(t / 60);
    const m = Math.floor(t % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function check(obsT: number | null, schedMin: number, threshold: number): 'Y' | 'N' {
    if (obsT === null) return 'N';
    return Math.abs(obsT - schedMin) <= threshold ? 'Y' : 'N';
  }
</script>

<div class="overflow-x-auto">
  <table class="w-full text-xs">
    <thead>
      <tr class="border-b border-slate-800 bg-slate-950/40">
        <th class="px-3 py-2 text-left   text-[10px] font-medium uppercase tracking-wider text-slate-500">Trip #</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Sched Start</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Sched End</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Obs Start</th>
        <th class="px-3 py-2 text-right  text-[10px] font-medium uppercase tracking-wider text-slate-500">Obs End</th>
        <th class="px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-slate-500" title="Within ±{startThreshold} min of scheduled start">Start ±{startThreshold}m</th>
        <th class="px-3 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-slate-500" title="Within ±{endThreshold} min of scheduled end">End ±{endThreshold}m</th>
      </tr>
    </thead>
    <tbody>
      {#each trips as trip (trip.idx)}
        {@const sc = check(trip.obsStartT, trip.schedStartMin, startThreshold)}
        {@const ec = check(trip.obsEndT,   trip.schedEndMin,   endThreshold)}
        <tr class="border-b border-slate-800/40 hover:bg-slate-800/20">
          <td class="px-3 py-2 font-mono text-slate-500">{trip.idx}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-400">{trip.schedStart}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-400">{trip.schedEnd}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-300">{fmtObs(trip.obsStartT)}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-300">{fmtObs(trip.obsEndT)}</td>
          <td class="px-3 py-2 text-center font-semibold {sc === 'Y' ? 'text-emerald-400' : 'text-red-400'}">{sc}</td>
          <td class="px-3 py-2 text-center font-semibold {ec === 'Y' ? 'text-emerald-400' : 'text-red-400'}">{ec}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>