<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';

  let {
    pingLat,
    pingLon,
    stopLat = undefined,
    stopLon = undefined,
  }: {
    pingLat:  number;
    pingLon:  number;
    stopLat?: number;
    stopLon?: number;
  } = $props();

  let container: HTMLDivElement;
  let map: maplibregl.Map;

  const STYLE = 'https://api.protomaps.com/styles/v5/dark/en.json?key=e01868f0b5821d40';

  onMount(() => {
    const proto = new Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);

    // Center between ping and stop if both present, else on ping
    const centerLon = stopLon !== undefined ? (pingLon + stopLon) / 2 : pingLon;
    const centerLat = stopLat !== undefined ? (pingLat + stopLat) / 2 : pingLat;

    map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [centerLon, centerLat],
      zoom: 15,
      interactive: false,
      attributionControl: false,
    });

    map.on('load', () => {
      // Scheduled stop marker (white)
      if (stopLat !== undefined && stopLon !== undefined) {
        const el = document.createElement('div');
        el.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#ffffff;border:2px solid #1e293b;box-shadow:0 0 0 1px #64748b';
        new maplibregl.Marker({ element: el }).setLngLat([stopLon, stopLat]).addTo(map);
      }

      // Vehicle ping marker (emerald)
      const el2 = document.createElement('div');
      el2.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#34d399;border:2px solid #0f172a;box-shadow:0 0 0 2px #34d39966';
      new maplibregl.Marker({ element: el2 }).setLngLat([pingLon, pingLat]).addTo(map);

      // Fit bounds to include both markers if stop is present
      if (stopLat !== undefined && stopLon !== undefined) {
        const bounds = new maplibregl.LngLatBounds(
          [Math.min(pingLon, stopLon), Math.min(pingLat, stopLat)],
          [Math.max(pingLon, stopLon), Math.max(pingLat, stopLat)],
        );
        map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 });
      }
    });
  });

  onDestroy(() => { map?.remove(); });
</script>

<div bind:this={container} class="h-36 w-full rounded-lg overflow-hidden border border-slate-700"></div>