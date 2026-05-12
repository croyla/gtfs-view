import type { SerializedGtfsData } from './gtfsCore';
import type { GtfsData, StopTime } from './types';

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

// Parse a github.com blob/raw or raw.githubusercontent.com URL into owner, repo, and the
// opaque "rest" segment (everything after owner/repo/). Branch names can contain slashes,
// so we cannot split ref vs. path here — that is resolved later with iterative probing.
function parseGithubUrl(url: string): { owner: string; repo: string; rest: string } | null {
  const ghCom = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(raw|blob)\/(.+)$/);
  if (ghCom) return { owner: ghCom[1], repo: ghCom[2], rest: ghCom[4] };
  const rawCdn = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/);
  if (rawCdn) return { owner: rawCdn[1], repo: rawCdn[2], rest: rawCdn[3] };
  return null;
}

// Fetch a GitHub file using the Contents API with Accept: application/vnd.github.raw+json,
// which returns the raw file bytes directly from api.github.com (CORS-safe).
// Tries ref/path splits shortest-ref-first to handle branch names with slashes.
async function fetchGithubWithToken(owner: string, repo: string, rest: string, token: string): Promise<Response> {
  const parts = rest.split('/');
  for (let refLen = 1; refLen <= parts.length - 1; refLen++) {
    const ref  = parts.slice(0, refLen).join('/');
    const path = parts.slice(refLen).join('/');
    // Slashes in `ref` are intentionally not percent-encoded — GitHub does not treat %2F
    // the same as / in query parameters.
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' },
    });
    if (response.status === 404) continue;
    return response;
  }
  throw new Error('Server returned 404 Not Found');
}

export async function loadGtfsFromUrl(url: string, token?: string): Promise<GtfsData> {
  const trimmed = url.trim();
  const gh = parseGithubUrl(trimmed);

  let response: Response;
  try {
    if (gh && token) {
      response = await fetchGithubWithToken(gh.owner, gh.repo, gh.rest, token);
    } else {
      const resolved = gh ? `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.rest}` : trimmed;
      response = await fetch(resolved, { redirect: 'follow' });
    }
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('Server returned') || err.message.startsWith('GitHub')))
      throw err;
    throw new Error('Network error — this may be a CORS restriction. Try downloading the file and uploading it instead.');
  }
  if (!response.ok) throw new Error(`Server returned ${response.status} ${response.statusText}`);
  const blob = await response.blob();
  return loadGtfsFromBlob(blob);
}