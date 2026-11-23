import type { PerfMetrics } from '../shared/perf';
import { frameImage } from './beautify';
import { parseDoc } from './document';
import { adjustFilter, GlEffects } from './gl';
import { isAdjustNeutral } from './model';
import { censorFallback, drawDoc, type RenderEnv } from './render';

let gl: GlEffects | null | undefined;
function effects(perf?: PerfMetrics): GlEffects | null {
  if (gl === undefined) {
    gl = GlEffects.create();
    if (perf) perf.gl_create = GlEffects.lastCreateMs;
  } else if (perf) {
    perf.gl_create = 0;
  }
  return gl;
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
}

/**
 * Produces the final image: base pixels (with colour adjustments), then the
 * annotations replayed on top, then the optional Beautify frame.
 */
export async function composeInto(
  bitmap: ImageBitmap,
  rawDoc: unknown,
  perf?: PerfMetrics,
): Promise<OffscreenCanvas> {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = context(canvas);
  if (!rawDoc) {
    if (perf) perf.gl_create = 0;
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  }
  const doc = parseDoc(rawDoc);
  const { adjust, invert, beautify } = doc.effects;
  const adjusted = invert || !isAdjustNeutral(adjust);
  const hasAnnotations = doc.annotations.length > 0;
  if (!hasAnnotations && !adjusted && !beautify.enabled) {
    if (perf) perf.gl_create = 0;
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  }
  const needsGlCensor =
    hasAnnotations && doc.annotations.some((a) => a.kind === 'censor' && a.mode !== 'solid');
  const fx = adjusted || needsGlCensor ? effects(perf) : null;
  if (!fx && perf && perf.gl_create === undefined) perf.gl_create = 0;
  if (adjusted && fx) {
    ctx.drawImage(fx.adjust(bitmap, width, height, adjust, invert), 0, 0);
  } else {
    if (adjusted) ctx.filter = adjustFilter(adjust, invert);
    ctx.drawImage(bitmap, 0, 0);
    ctx.filter = 'none';
  }
  if (hasAnnotations) {
    // Only allocate a separate base copy when an annotation reads pixels (censor / magnify).
    const needsSource = doc.annotations.some((a) => a.kind === 'censor' || a.kind === 'magnify');
    let source: OffscreenCanvas | null = null;
    if (needsSource) {
      source = new OffscreenCanvas(width, height);
      context(source).drawImage(canvas, 0, 0);
    }
    const env: RenderEnv = {
      source,
      width,
      height,
      unit: doc.unit,
      censor: fx?.censor ?? censorFallback,
    };
    drawDoc(ctx, doc, env);
  }
  return frameImage(canvas, beautify, doc.unit);
}
