/// <reference lib="webworker" />
import { composeInto } from '../engine/compose';
import { canvasTextMeasurer, setTextMeasurer } from '../engine/shapes';
import { type PerfMetrics, roundMs } from '../shared/perf';
import type { ExportDone, ExportFailed, ExportJob } from './export-protocol';

// Export by replay: draw the base image and the annotations onto an
// OffscreenCanvas at full resolution, then encode with Chromium's encoders.
// All of this runs off the window's main thread.
const scope = self as unknown as DedicatedWorkerGlobalScope;

// Text backgrounds are sized from text metrics; use the same real ones as the editor.
const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
if (measureCtx) setTextMeasurer(canvasTextMeasurer(measureCtx));

scope.onmessage = async (event: MessageEvent<ExportJob>) => {
  const job = event.data;
  const workerT0 = performance.now();
  const perf: PerfMetrics = {};
  try {
    const composeT0 = performance.now();
    let canvas: OffscreenCanvas;
    try {
      canvas = await composeInto(job.bitmap, job.doc, perf);
    } finally {
      job.bitmap.close();
    }
    perf.compose_total = roundMs(performance.now() - composeT0);

    const { width, height } = canvas;
    const saveSpec = job.save;
    const encodePng = async () => {
      const t0 = performance.now();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = await blob.arrayBuffer();
      perf.png_encode = roundMs(performance.now() - t0);
      return bytes;
    };
    const encodeSave = saveSpec
      ? async () => {
          const t0 = performance.now();
          const blob = await canvas.convertToBlob({
            type: saveSpec.mime,
            quality: saveSpec.quality / 100,
          });
          const bytes = await blob.arrayBuffer();
          perf.save_encode = roundMs(performance.now() - t0);
          return bytes;
        }
      : async () => undefined;
    const encodeThumb = async () => {
      const t0 = performance.now();
      const bytes = await thumbnail(canvas, job.thumbMax);
      perf.thumb_encode = roundMs(performance.now() - t0);
      return bytes;
    };

    const [png, save, thumb] = await Promise.all([encodePng(), encodeSave(), encodeThumb()]);
    perf.worker_total = roundMs(performance.now() - workerT0);

    const done: ExportDone = {
      id: job.id,
      png: { bytes: png, mime: 'image/png', width, height },
      thumb,
      perf,
      ...(save && saveSpec ? { save: { bytes: save, mime: saveSpec.mime, width, height } } : {}),
    };
    const transfer = [png, thumb, ...(save ? [save] : [])];
    scope.postMessage(done, transfer);
  } catch (error) {
    const failed: ExportFailed = { id: job.id, error: String(error) };
    scope.postMessage(failed);
  }
};

async function thumbnail(source: OffscreenCanvas, max: number): Promise<ArrayBuffer> {
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
  return blob.arrayBuffer();
}
