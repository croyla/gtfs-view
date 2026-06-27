import type { SerializedGtfsData } from './gtfsCore';
import type { GtfsData, StopTime } from '../../types/types';

// ── Deserialiser: runs on main thread after Worker posts result ───────────────

function deserialize(s: SerializedGtfsData): GtfsData {
  // Build trip/stop indices from the flat stop_times array
  const stopTimesByTrip = new Map<string, StopTime[]>();
  const stopTimesByStop = new Map<string, StopTime[]>();
  for (const st of s.stopTimes) {
    let byTrip = stopTimesByTrip.get(st.trip_id);
    if (!byTrip) { byTrip = []; stopTimesByTrip.set(st.trip_id, byTrip); }
    byTrip.push(st);

    let byStop = stopTimesByStop.get(st.stop_id);
    if (!byStop) { byStop = []; stopTimesByStop.set(st.stop_id, byStop); }
    byStop.push(st);
  }
  // Sort each trip's stop_times by sequence (stop card timetable relies on this)
  for (const sts of stopTimesByTrip.values())
    sts.sort((a, b) => a.stop_sequence - b.stop_sequence);

  return {
    agencies:       new Map(s.agencies),
    stops:          new Map(s.stops),
    trips:          new Map(s.trips),
    routes:         new Map(s.routes),
    shapes:         new Map(s.shapes),
    shapeColors:    new Map(s.shapeColors),
    tripStops:      new Map(s.tripStops),
    stopTimesByTrip,
    stopTimesByStop,
    tree:           s.tree,
    allShapeKeys:   new Set(s.allShapeKeys),
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loadGtfsFromBlob(blob: Blob): Promise<GtfsData> {
  const buffer = await blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./gtfsWorker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent<{ ok: true; data: SerializedGtfsData } | { ok: false; error: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(deserialize(e.data.data));
      else reject(new Error(e.data.error));
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message ?? 'Worker error during GTFS parsing'));
    };

    // Transfer buffer ownership — zero-copy handoff to Worker
    worker.postMessage(buffer, [buffer]);
  });
}

// Rewrite github.com raw/blob URLs to raw.githubusercontent.com to avoid
// CORS issues that arise from following cross-origin redirects.
function resolveUrl(url: string): string {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(raw|blob)\/(.+)$/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[3]}`;
  return url;
}

export async function loadGtfsFromUrl(url: string): Promise<GtfsData> {
  const resolved = resolveUrl(url.trim());
  let response: Response;
  try {
    response = await fetch(resolved, { redirect: 'follow' });
  } catch {
    throw new Error(
      'Network error — this may be a CORS restriction. Try downloading the file and uploading it instead.',
    );
  }
  if (!response.ok) throw new Error(`Server returned ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return loadGtfsFromBlob(blob);
}