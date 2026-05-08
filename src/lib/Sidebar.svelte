<script lang="ts">
  import type { GtfsData, RouteTreeNode, AgencyTreeNode } from './types';

  let {
    gtfsData,
    checkedKeys,
    showShapes = $bindable(true),
    showStops  = $bindable(true),
    showHeatmap = $bindable(false),
    compareData = null,
    onToggleKeys,
    onLoadCompare,
    onViewDiff,
    onClearCompare,
  }: {
    gtfsData: GtfsData | null;
    checkedKeys: Set<string>;
    showShapes?: boolean;
    showStops?: boolean;
    showHeatmap?: boolean;
    compareData?: GtfsData | null;
    onToggleKeys: (keys: string[], on: boolean) => void;
    onLoadCompare: () => void;
    onViewDiff: () => void;
    onClearCompare: () => void;
  } = $props();

  let expandedAgencies = $state(new Set<string>());
  let expandedRoutes   = $state(new Set<string>());

  $effect(() => {
    if (gtfsData) {
      expandedAgencies = new Set(gtfsData.tree.map(a => a.agency.agency_id));
      expandedRoutes = new Set<string>();
    }
  });

  // Tri-state helper: 'all' | 'some' | 'none'
  function keyState(keys: string[]): 'all' | 'some' | 'none' {
    let n = 0;
    for (const k of keys) if (checkedKeys.has(k)) n++;
    return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
  }

  // Svelte action: syncs checked + indeterminate from tri-state value
  function tristate(node: HTMLInputElement, value: 'all' | 'some' | 'none') {
    function apply(v: typeof value) {
      node.checked = v === 'all';
      node.indeterminate = v === 'some';
    }
    apply(value);
    return { update: apply };
  }

  function toggleAgency(node: AgencyTreeNode, checked: boolean) {
    onToggleKeys(node.allKeys, checked);
  }

  function toggleRoute(node: RouteTreeNode, checked: boolean) {
    onToggleKeys(node.allKeys, checked);
  }

  function toggleKey(key: string, checked: boolean) {
    onToggleKeys([key], checked);
  }

  function toggleAll(on: boolean) {
    if (gtfsData) onToggleKeys([...gtfsData.allShapeKeys], on);
  }

  function toggleExpanded(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
</script>

<aside class="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900 overflow-hidden">

  <!-- Layers section -->
  <div class="border-b border-slate-800 px-3 py-3 space-y-1">
    <p class="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Layers</p>

    {#each [
      { label: 'Shapes',  get: () => showShapes,  set: (v: boolean) => showShapes = v },
      { label: 'Stops',   get: () => showStops,   set: (v: boolean) => showStops = v },
      { label: 'Heatmap', get: () => showHeatmap, set: (v: boolean) => showHeatmap = v },
    ] as layer}
      <label class="flex cursor-pointer items-center gap-2.5 rounded px-1 py-0.5 hover:bg-slate-800">
        <input
          type="checkbox"
          class="h-3.5 w-3.5 accent-indigo-500"
          checked={layer.get()}
          onchange={(e) => layer.set(e.currentTarget.checked)}
        />
        <span class="text-sm text-slate-300">{layer.label}</span>
      </label>
    {/each}
  </div>

  <!-- Feed tree -->
  <div class="flex min-h-0 flex-1 flex-col">
    {#if !gtfsData}
      <p class="p-4 text-xs text-slate-500">No feed loaded.</p>
    {:else}
      <!-- Header row with select all / none -->
      <div class="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <p class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Feed</p>
        <div class="flex gap-1">
          <button
            class="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            onclick={() => toggleAll(true)}
          >all</button>
          <button
            class="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            onclick={() => toggleAll(false)}
          >none</button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto py-1 text-sm">
        {#each gtfsData.tree as agencyNode (agencyNode.agency.agency_id)}
          {@const agencyExpanded = expandedAgencies.has(agencyNode.agency.agency_id)}
          {@const agencyState = keyState(agencyNode.allKeys)}

          <!-- Agency row -->
          <div>
            <div class="flex items-center gap-1 px-2 py-1 hover:bg-slate-800">
              <button
                class="flex h-4 w-4 shrink-0 items-center justify-center text-slate-500 hover:text-slate-300"
                onclick={() => { expandedAgencies = toggleExpanded(expandedAgencies, agencyNode.agency.agency_id); }}
                aria-label={agencyExpanded ? 'Collapse' : 'Expand'}
              >
                <svg class="h-3 w-3 transition-transform {agencyExpanded ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <input
                type="checkbox"
                class="h-3.5 w-3.5 shrink-0 accent-indigo-500"
                use:tristate={agencyState}
                onchange={(e) => toggleAgency(agencyNode, e.currentTarget.checked)}
              />
              <span class="truncate font-medium text-slate-200" title={agencyNode.agency.agency_name}>
                {agencyNode.agency.agency_name}
              </span>
            </div>

            {#if agencyExpanded}
              {#each agencyNode.routes as routeNode (routeNode.route.route_id)}
                {@const routeExpanded = expandedRoutes.has(routeNode.route.route_id)}
                {@const routeState = keyState(routeNode.allKeys)}

                <!-- Route row -->
                <div class="ml-4">
                  <div class="flex items-center gap-1 px-2 py-0.5 hover:bg-slate-800">
                    <button
                      class="flex h-4 w-4 shrink-0 items-center justify-center text-slate-500 hover:text-slate-300"
                      onclick={() => { expandedRoutes = toggleExpanded(expandedRoutes, routeNode.route.route_id); }}
                      aria-label={routeExpanded ? 'Collapse' : 'Expand'}
                    >
                      <svg class="h-3 w-3 transition-transform {routeExpanded ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="currentColor">
                        <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                    <input
                      type="checkbox"
                      class="h-3.5 w-3.5 shrink-0 accent-indigo-500"
                      use:tristate={routeState}
                      onchange={(e) => toggleRoute(routeNode, e.currentTarget.checked)}
                    />
                    {#if routeNode.route.route_color}
                      <span
                        class="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style="background:{routeNode.route.route_color}"
                      ></span>
                    {/if}
                    <span class="truncate text-slate-300" title="{routeNode.route.route_short_name} — {routeNode.route.route_long_name}">
                      <span class="font-medium">{routeNode.route.route_short_name || routeNode.route.route_id}</span>
                      {#if routeNode.route.route_long_name}
                        <span class="text-slate-500"> {routeNode.route.route_long_name}</span>
                      {/if}
                    </span>
                  </div>

                  {#if routeExpanded}
                    {#each routeNode.shapeGroups as group (group.key)}
                      <!-- Shape group leaf -->
                      <label class="ml-5 flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 hover:bg-slate-800">
                        <input
                          type="checkbox"
                          class="h-3.5 w-3.5 shrink-0 accent-indigo-500"
                          checked={checkedKeys.has(group.key)}
                          onchange={(e) => toggleKey(group.key, e.currentTarget.checked)}
                        />
                        <span class="min-w-0 truncate text-slate-400" title={group.label}>
                          {group.label}
                        </span>
                        <span class="ml-auto shrink-0 text-[10px] text-slate-600">
                          {group.tripIds.length}
                        </span>
                      </label>
                    {/each}
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Compare / diff actions -->
  {#if gtfsData}
    <div class="border-t border-slate-800 p-2 shrink-0 space-y-1">
      {#if !compareData}
        <button
          class="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          onclick={onLoadCompare}
        >
          <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 8h10M8 3l5 5-5 5"/>
          </svg>
          Compare with…
        </button>
      {:else}
        <button
          class="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-indigo-300 bg-indigo-950/40 hover:bg-indigo-950/70 border border-indigo-800/60 transition-colors"
          onclick={onViewDiff}
        >
          <span class="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
          View diff
        </button>
        <button
          class="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
          onclick={onClearCompare}
        >
          Clear compare
        </button>
      {/if}
    </div>
  {/if}
</aside>