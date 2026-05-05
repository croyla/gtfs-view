import { processGtfsBuffer } from './gtfsCore';

// Vite bundles this as a separate Worker chunk
onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const data = processGtfsBuffer(e.data);
    postMessage({ ok: true, data });
  } catch (err) {
    postMessage({ ok: false, error: String(err) });
  }
};