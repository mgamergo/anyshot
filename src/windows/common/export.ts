import type { Rect } from '../../shared/geometry';
import { type PerfMetrics, roundMs } from '../../shared/perf';
import type { ExportDone, ExportFailed, ExportJob, ImageMime } from '../../workers/export-protocol';

let worker: Worker | null = null;
let pendingWorkerSpawnMs = 0;
let nextId = 1;
const pending = new Map<number, { resolve: (d: ExportDone) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const spawnT0 = performance.now();
  const created = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), {
    type: 'module',
  });
  pendingWorkerSpawnMs = roundMs(performance.now() - spawnT0);
  created.onmessage = (event: MessageEvent<ExportDone | ExportFailed>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if ('error' in event.data) entry.reject(new Error(event.data.error));
    else entry.resolve(event.data);
  };
  // A worker that fails to load (or crashes) answers nothing: fail what is pending
  // and start a fresh worker for the next export.
  created.onerror = (event) => {
    event.preventDefault();
    if (worker !== created) return;
    worker = null;
    created.terminate();
    const error = new Error(`Export worker failed: ${event.message || 'could not start'}`);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker = created;
  return created;
}

export interface ExportOptions {
  /** Full-resolution source and the region of it to export. */
  source: ImageBitmap;
  region: Rect;
  /** Annotation document already translated into region coordinates. */
  doc?: unknown;
  save?: { mime: ImageMime; quality: number };
  thumbMax?: number;
}

/** Crops, replays annotations and encodes in the export worker. */
export async function exportImage(options: ExportOptions): Promise<ExportDone> {
  const exportT0 = performance.now();
  const { x, y, width, height } = options.region;
  const cropT0 = performance.now();
  const bitmap = await createImageBitmap(options.source, x, y, width, height);
  const cropMs = roundMs(performance.now() - cropT0);
  const id = nextId++;
  const job: ExportJob = {
    id,
    bitmap,
    doc: options.doc ?? null,
    thumbMax: options.thumbMax ?? 480,
    ...(options.save ? { save: options.save } : {}),
  };
  return new Promise((resolve, reject) => {
    const roundtripT0 = performance.now();
    try {
      const w = getWorker();
      const spawnMs = pendingWorkerSpawnMs;
      pendingWorkerSpawnMs = 0;
      pending.set(id, {
        resolve: (done) => {
          const perf: PerfMetrics = {
            ...(done.perf ?? {}),
            ...(spawnMs > 0 ? { worker_spawn: spawnMs } : {}),
            export_crop_bitmap: cropMs,
            worker_roundtrip: roundMs(performance.now() - roundtripT0),
            export_total: roundMs(performance.now() - exportT0),
          };
          resolve({ ...done, perf });
        },
        reject,
      });
      w.postMessage(job, [bitmap]);
    } catch (error) {
      pending.delete(id);
      bitmap.close();
      reject(error);
    }
  });
}
