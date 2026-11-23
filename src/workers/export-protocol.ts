import type { EncodedImage } from '../shared/ipc';
import type { PerfMetrics } from '../shared/perf';

export type ImageMime = EncodedImage['mime'];

export interface ExportJob {
  id: number;
  /** The base pixels, already cropped to the output region. Transferred. */
  bitmap: ImageBitmap;
  /** Serialised annotation document in the bitmap's coordinate space, if any. */
  doc: unknown;
  save?: { mime: ImageMime; quality: number };
  thumbMax: number;
}

export interface ExportDone {
  id: number;
  png: EncodedImage;
  save?: EncodedImage;
  thumb: ArrayBuffer;
  perf?: PerfMetrics;
}

export interface ExportFailed {
  id: number;
  error: string;
}
