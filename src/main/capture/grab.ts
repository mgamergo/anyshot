import { createRequire } from 'node:module';
import { type Display, desktopCapturer } from 'electron';
import { type PerfMetrics, roundMs } from '../../shared/perf';
import type { Frame } from '../frames';
import { bgraToRgba, matchMonitor } from './match';

type NodeScreenshots = typeof import('node-screenshots');

const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
const forced = process.env.ANYSHOT_CAPTURE_BACKEND;

let native: NodeScreenshots | null | undefined;

/** Loads node-screenshots on first use; null when unavailable (Wayland, missing binary). */
function nativeBackend(): NodeScreenshots | null {
  if (native !== undefined) return native;
  if (isWayland || forced === 'desktop-capturer') {
    native = null;
    return native;
  }
  try {
    native = createRequire(import.meta.url)('node-screenshots') as NodeScreenshots;
  } catch (error) {
    console.warn('[capture] node-screenshots unavailable, using desktopCapturer', error);
    native = null;
  }
  return native;
}

export function captureBackend(): 'node-screenshots' | 'desktop-capturer' {
  return nativeBackend() ? 'node-screenshots' : 'desktop-capturer';
}

/** Pre-loads the native capture addon so the first hotkey pays 0ms `native_load`. */
export function prewarmGrab(): void {
  nativeBackend();
}

/** Grabs one display at full physical resolution as raw RGBA. */
export async function grabDisplay(display: Display, perf?: PerfMetrics): Promise<Frame> {
  const grabT0 = performance.now();
  const nsT0 = performance.now();
  const ns = nativeBackend();
  if (perf) perf.native_load = roundMs(performance.now() - nsT0);
  if (ns) {
    try {
      const monT0 = performance.now();
      const monitors = ns.Monitor.all();
      const monitor = matchMonitor(
        monitors.map((m) => ({
          id: m.id(),
          x: m.x(),
          y: m.y(),
          width: m.width(),
          height: m.height(),
          m,
        })),
        display,
      );
      if (perf) perf.Monitor_all = roundMs(performance.now() - monT0);
      if (monitor) {
        const capT0 = performance.now();
        const image = await monitor.m.captureImage();
        if (perf) perf.captureImage = roundMs(performance.now() - capT0);
        const rawT0 = performance.now();
        const rgba = await image.toRaw();
        if (perf) {
          perf.toRaw = roundMs(performance.now() - rawT0);
          perf.grab_total = roundMs(performance.now() - grabT0);
        }
        return { rgba, width: image.width, height: image.height };
      }
    } catch (error) {
      console.warn('[capture] native grab failed, falling back', error);
    }
  }
  const frame = await grabWithDesktopCapturer(display, perf);
  if (perf) perf.grab_total = roundMs(performance.now() - grabT0);
  return frame;
}

/**
 * Grabs all requested displays concurrently. Calls `ns.Monitor.all()` once and
 * captures every display in parallel via `Promise.all`.
 */
export async function grabDisplays(displays: Display[], perfs?: PerfMetrics[]): Promise<Frame[]> {
  if (displays.length === 0) return [];
  if (displays.length === 1) {
    const first = displays[0];
    return first ? [await grabDisplay(first, perfs?.[0])] : [];
  }
  const grabT0 = performance.now();
  const nsT0 = performance.now();
  const ns = nativeBackend();
  const nativeLoadMs = roundMs(performance.now() - nsT0);
  if (perfs) {
    for (const p of perfs) p.native_load = nativeLoadMs;
  }
  let monitors:
    | {
        id: number;
        x: number;
        y: number;
        width: number;
        height: number;
        m: ReturnType<NodeScreenshots['Monitor']['all']>[number];
      }[]
    | null = null;
  if (ns) {
    try {
      const monT0 = performance.now();
      monitors = ns.Monitor.all().map((m) => ({
        id: m.id(),
        x: m.x(),
        y: m.y(),
        width: m.width(),
        height: m.height(),
        m,
      }));
      const monAllMs = roundMs(performance.now() - monT0);
      if (perfs) {
        for (const p of perfs) p.Monitor_all = monAllMs;
      }
    } catch (error) {
      console.warn('[capture] native Monitor.all failed, falling back', error);
    }
  }
  const frames: (Frame | undefined)[] = new Array(displays.length);
  if (monitors) {
    const resolvedMonitors = monitors;
    await Promise.all(
      displays.map(async (display, idx) => {
        const perf = perfs?.[idx];
        const monitor = matchMonitor(resolvedMonitors, display);
        if (!monitor) return;
        try {
          const capT0 = performance.now();
          const image = await monitor.m.captureImage();
          if (perf) perf.captureImage = roundMs(performance.now() - capT0);
          const rawT0 = performance.now();
          const rgba = await image.toRaw();
          if (perf) {
            perf.toRaw = roundMs(performance.now() - rawT0);
            perf.grab_total = roundMs(performance.now() - grabT0);
          }
          frames[idx] = { rgba, width: image.width, height: image.height };
        } catch (error) {
          console.warn('[capture] native grab failed for display, falling back', error);
        }
      }),
    );
  }
  // Run desktopCapturer sequentially so Wayland/PipeWire does not coalesce
  // concurrent getSources() calls for same-resolution monitors into one screen.
  for (let idx = 0; idx < displays.length; idx++) {
    if (frames[idx]) continue;
    const display = displays[idx];
    if (!display) continue;
    const perf = perfs?.[idx];
    const frame = await grabWithDesktopCapturer(display, perf);
    if (perf) perf.grab_total = roundMs(performance.now() - grabT0);
    frames[idx] = frame;
  }
  return frames as Frame[];
}

/**
 * Electron's own capturer. On Wayland this goes through the desktop's
 * screen-share portal and may show a system picker.
 */
async function grabWithDesktopCapturer(display: Display, perf?: PerfMetrics): Promise<Frame> {
  const width = Math.round(display.bounds.width * display.scaleFactor);
  const height = Math.round(display.bounds.height * display.scaleFactor);
  const srcT0 = performance.now();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  if (perf) perf.desktopCapturer_getSources = roundMs(performance.now() - srcT0);
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('No screen source available');
  const image = source.thumbnail;
  const size = image.getSize();
  if (size.width === 0 || size.height === 0)
    throw new Error('Screen capture returned an empty image');
  const bmpT0 = performance.now();
  const bitmap = image.toBitmap();
  if (perf) perf.desktopCapturer_toBitmap = roundMs(performance.now() - bmpT0);
  const convT0 = performance.now();
  const rgba = bgraToRgba(new Uint8Array(bitmap));
  if (perf) perf.desktopCapturer_bgraToRgba = roundMs(performance.now() - convT0);
  return {
    rgba,
    width: size.width,
    height: size.height,
  };
}
