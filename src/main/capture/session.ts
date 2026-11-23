import { type BrowserWindow, type Display, screen } from 'electron';
import type { Rect } from '../../shared/geometry';
import type { CaptureMode, OverlayInit } from '../../shared/ipc';
import { epochMs, type PerfMetrics, roundMs } from '../../shared/perf';
import { appState } from '../app-state';
import { type Frame, putFrame, releaseFrame } from '../frames';
import { handle } from '../ipc';
import { logPerf } from '../perf';
import { getSettings } from '../settings-store';
import { SYSTEM_AUDIO_AVAILABLE } from '../system-audio';
import { recordTiming } from '../test-hooks';
import { createWindow, send } from '../windows';
import { grabDisplay, grabDisplays } from './grab';

interface OverlayState {
  win: BrowserWindow;
  display: Display;
  init: Promise<OverlayInit>;
  frameId: string | null;
  perf: PerfMetrics;
  isWarm: boolean;
  /** True once the renderer finished initial boot and can be recycled via standby/reset. */
  reusable: boolean;
}

interface Session {
  mode: CaptureMode;
  startedAt: number;
  hotkeyAt: number;
  overlays: Map<number, OverlayState>;
  shown: boolean;
  /** Overlays are hidden while the result is encoded; the session ends soon. */
  finishing: boolean;
  ended: Promise<void>;
  end: () => void;
}

let session: Session | null = null;
let delaying = false;
let quitting = false;
let lastArea: { displayId: number; rect: Rect } | null = null;

const isLinux = process.platform === 'linux';
export const WARM_IDLE_MS = 30_000;

export function isCapturing(): boolean {
  return session !== null;
}

/** Starts a capture: freezes every display and shows one overlay per display. */
export async function startCapture(
  mode: CaptureMode,
  triggeredAt = performance.now(),
): Promise<void> {
  const hotkeyToStart = roundMs(performance.now() - triggeredAt);
  if (session?.finishing) {
    // A hotkey pressed while the previous capture is still being delivered starts a new one after it.
    await session.ended;
  }
  if (session) {
    focusFirstOverlay();
    return;
  }
  const delay = appState.delaySeconds;
  if (delaying) return;
  clearWarmIdleTimer();
  if (prewarmTimer) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
  if (delay > 0 && mode !== 'last') {
    delaying = true;
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    delaying = false;
    if (session) return;
  }

  const startedAt = performance.now();
  const hotkeyAt = delay > 0 && mode !== 'last' ? startedAt : triggeredAt;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const current: Session = {
    mode,
    startedAt,
    hotkeyAt,
    overlays: new Map(),
    shown: false,
    finishing: false,
    ended,
    end,
  };
  session = current;

  // The display under the pointer goes first so its overlay appears soonest.
  const lookupT0 = performance.now();
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const displays = [cursor, ...screen.getAllDisplays().filter((d) => d.id !== cursor.id)];
  const displayLookupMs = roundMs(performance.now() - lookupT0);
  const single = mode === 'record' || mode === 'gif' || mode === 'scroll';
  const targets = single ? [cursor] : displays;
  const targetIds = new Set(targets.map((d) => d.id));
  const instantCapture = getSettings().capture.instantCapture;

  // Kick off all display grabs concurrently BEFORE window lookup/creation so they overlap
  // and no newly shown overlay can ever land in another display's grab.
  const grabPerfs: PerfMetrics[] = targets.map(() => ({}));
  let grabPromises: Promise<Frame>[];
  if (targets.length > 1 && typeof grabDisplays === 'function') {
    const allGrabs = grabDisplays(targets, grabPerfs);
    grabPromises = targets.map((_, idx) =>
      allGrabs.then((frames) => {
        const frame = frames[idx];
        if (!frame) throw new Error(`Missing grabbed frame for display index ${idx}`);
        return frame;
      }),
    );
  } else {
    grabPromises = targets.map((display, idx) => grabDisplay(display, grabPerfs[idx]));
  }

  for (let i = 0; i < targets.length; i++) {
    const display = targets[i];
    const grab = grabPromises[i];
    const grabPerf = grabPerfs[i];
    if (!display || !grab || !grabPerf) continue;
    const winT0 = performance.now();
    const reused = takeWarm(display, targetIds);
    const win = reused?.win ?? createOverlayWindow(display);
    const windowReadyMs = roundMs(performance.now() - winT0);
    const isStandby = reused?.phase === 'standby';
    const statePerf: PerfMetrics = {
      hotkey_to_startCapture: hotkeyToStart,
      display_lookup: displayLookupMs,
      window_ready: windowReadyMs,
    };
    const state: OverlayState = {
      win,
      display,
      frameId: null,
      perf: statePerf,
      isWarm: Boolean(reused),
      reusable: isStandby,
      init: grab.then((frame) => {
        if (session !== current || win.isDestroyed()) throw new Error('Capture ended');
        const frameT0 = performance.now();
        const frameId = putFrame(frame);
        statePerf.putFrame = roundMs(performance.now() - frameT0);
        const initT0 = performance.now();
        const init = buildInit(
          mode,
          display,
          frameId,
          frame,
          display.id === cursor.id,
          instantCapture,
        );
        statePerf.buildInit = roundMs(performance.now() - initT0);
        Object.assign(statePerf, grabPerf);
        statePerf.init_ready = roundMs(performance.now() - startedAt);
        state.frameId = frameId;
        return init;
      }),
    };
    if (isStandby) {
      // Recycled overlay is already booted and listening for `overlay:reset`.
      void state.init.then(
        (init) => {
          if (session === current && !win.isDestroyed()) send(win, 'overlay:reset', init);
        },
        (error) => {
          if (session === current) {
            console.error('[capture] standby capture failed', error);
            endCapture();
          }
        },
      );
    } else {
      // The renderer may close before it asks for the grab result.
      void state.init.catch(() => undefined);
      reused?.claim?.(state.init);
    }
    const contentsId = win.webContents.id;
    current.overlays.set(contentsId, state);
  }

  await Promise.allSettled(grabPromises);
}

function buildInit(
  mode: CaptureMode,
  display: Display,
  frameId: string,
  frame: { width: number; height: number },
  underCursor: boolean,
  warm: boolean,
): OverlayInit {
  const settings = getSettings();
  const last = lastArea && lastArea.displayId === display.id ? lastArea.rect : null;
  return {
    mode,
    frameId,
    frame: { width: frame.width, height: frame.height },
    scaleFactor: frame.width / display.bounds.width,
    bounds: display.bounds,
    lastSelection: last,
    // Without instant preview the full screen is captured at once: only the display under the pointer.
    selectAll: mode === 'screen' && (settings.capture.instantPreview || underCursor),
    settings,
    systemAudio: SYSTEM_AUDIO_AVAILABLE,
    warm,
  };
}

function boundsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createOverlayWindow(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;
  const win = createWindow('overlay', {
    x,
    y,
    width,
    height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    // Keep warm/hidden overlays unthrottled so `overlay:reset` paints and signals immediately.
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBounds(display.bounds);
  attachOverlayLifecycle(win);
  return win;
}

/** Attaches a single lifecycle handler per overlay window so reused windows never leak listeners. */
function attachOverlayLifecycle(win: BrowserWindow): void {
  const contentsId = win.webContents.id;
  win.once('closed', () => {
    for (const [displayId, entry] of warmPool) {
      if (entry.win === win) {
        warmPool.delete(displayId);
        if (warmPool.size === 0) clearWarmIdleTimer();
        break;
      }
    }
    if (session) {
      const state = session.overlays.get(contentsId);
      if (state) {
        if (state.frameId) releaseFrame(state.frameId);
        session.overlays.delete(contentsId);
        if (session.overlays.size === 0) {
          const finished = session;
          session = null;
          finished.end();
          schedulePrewarm();
        }
      }
    }
  });
  win.webContents.on?.('render-process-gone', () => {
    for (const [displayId, entry] of warmPool) {
      if (entry.win === win) {
        warmPool.delete(displayId);
        if (warmPool.size === 0) clearWarmIdleTimer();
        break;
      }
    }
    if (!win.isDestroyed()) win.destroy();
  });
}

function stateOf(win: BrowserWindow): OverlayState {
  const state = session?.overlays.get(win.webContents.id);
  if (!state) throw new Error('No capture session for this overlay');
  return state;
}

function focusFirstOverlay(): void {
  const first = session?.overlays.values().next().value;
  first?.win.focus();
}

/**
 * Ends the active capture session. When `instantCapture` is enabled, booted
 * overlays are hidden, put into standby (`overlay:standby`), and returned to
 * the warm pool for instant reuse instead of being destroyed.
 */
export function endCapture(owner?: BrowserWindow): void {
  const current = session;
  if (!current || (owner && ![...current.overlays.values()].some(({ win }) => win === owner))) {
    return;
  }
  session = null;
  current.end();
  const keepWarm = getSettings().capture.instantCapture && !quitting;
  for (const state of current.overlays.values()) {
    const { win, display, frameId } = state;
    if (frameId) releaseFrame(frameId);
    if (win.isDestroyed()) continue;
    if (keepWarm && state.reusable) {
      if (isLinux && win.isFullScreen?.()) win.setFullScreen(false);
      win.hide();
      send(win, 'overlay:standby', undefined);
      const prev = warmPool.get(display.id);
      if (prev && prev.win !== win && !prev.win.isDestroyed()) prev.win.destroy();
      warmPool.set(display.id, {
        win,
        displayId: display.id,
        bounds: { ...display.bounds },
        phase: 'standby',
      });
    } else {
      win.destroy();
    }
  }
  current.overlays.clear();
  if (keepWarm) {
    if (warmPool.size > 0) resetWarmIdleTimer();
    schedulePrewarm();
  }
}

// ---------------------------------------------------------------- instant capture

interface WarmEntry {
  win: BrowserWindow;
  displayId: number;
  bounds: Rect;
  /**
   * 'fresh': freshly spawned by prewarm(); waiting for its initial `overlay:init`.
   * 'standby': already booted in a prior capture and reset via `overlay:standby`;
   *            listening for `overlay:reset`.
   */
  phase: 'fresh' | 'standby';
  pendingInit?: Promise<OverlayInit>;
  claim?: (init: Promise<OverlayInit>) => void;
}

const warmPool = new Map<number, WarmEntry>();
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let warmIdleTimer: ReturnType<typeof setTimeout> | null = null;

function clearWarmIdleTimer(): void {
  if (warmIdleTimer) {
    clearTimeout(warmIdleTimer);
    warmIdleTimer = null;
  }
}

function resetWarmIdleTimer(): void {
  clearWarmIdleTimer();
  if (warmPool.size === 0 || session || quitting || !getSettings().capture.instantCapture) return;
  warmIdleTimer = setTimeout(() => {
    warmIdleTimer = null;
    dropWarm();
  }, WARM_IDLE_MS);
}

/**
 * Instant capture keeps one hidden overlay per active display ready in a pool.
 * Fresh windows wait on `overlay:init`; recycled windows wait in standby for
 * `overlay:reset`. Costs one hidden renderer per display while warm, and auto-unloads
 * after {@link WARM_IDLE_MS} of inactivity to return idle RAM to baseline.
 */
export function prewarm(): void {
  if (prewarmTimer) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
  if (!getSettings().capture.instantCapture || session || quitting) return;
  const activeDisplays = screen.getAllDisplays();
  const activeIds = new Set(activeDisplays.map((d) => d.id));
  // Evict destroyed or unplugged-display entries.
  for (const [displayId, entry] of warmPool) {
    if (entry.win.isDestroyed() || !activeIds.has(displayId)) {
      warmPool.delete(displayId);
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
  }
  let createdAny = false;
  for (const display of activeDisplays) {
    const existing = warmPool.get(display.id);
    if (existing && !existing.win.isDestroyed()) {
      if (!boundsEqual(existing.bounds, display.bounds)) {
        existing.win.setBounds(display.bounds);
        existing.bounds = { ...display.bounds };
      }
      continue;
    }
    const win = createOverlayWindow(display);
    createdAny = true;
    let claim: (init: Promise<OverlayInit>) => void = () => {};
    const pendingInit = new Promise<OverlayInit>((resolve, reject) => {
      claim = (p) => p.then(resolve, reject);
    });
    void pendingInit.catch(() => undefined);
    warmPool.set(display.id, {
      win,
      displayId: display.id,
      bounds: { ...display.bounds },
      phase: 'fresh',
      pendingInit,
      claim,
    });
  }
  if (warmPool.size > 0 && (createdAny || !warmIdleTimer)) {
    resetWarmIdleTimer();
  }
}

function takeWarm(display: Display, reservedIds: Set<number>): WarmEntry | null {
  const exact = warmPool.get(display.id);
  if (exact) {
    warmPool.delete(display.id);
    if (!exact.win.isDestroyed()) {
      if (!boundsEqual(exact.bounds, display.bounds)) {
        exact.win.setBounds(display.bounds);
        exact.bounds = { ...display.bounds };
      }
      return exact;
    }
  }
  // Fallback: reuse an unreserved warm window if display IDs changed.
  for (const [id, entry] of warmPool) {
    if (reservedIds.has(id)) continue;
    warmPool.delete(id);
    if (!entry.win.isDestroyed()) {
      entry.displayId = display.id;
      if (!boundsEqual(entry.bounds, display.bounds)) {
        entry.win.setBounds(display.bounds);
        entry.bounds = { ...display.bounds };
      }
      return entry;
    }
  }
  return null;
}

export function dropWarm(): void {
  clearWarmIdleTimer();
  if (prewarmTimer) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }
  for (const entry of warmPool.values()) {
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }
  warmPool.clear();
}

export function disposeOverlaysForQuit(): void {
  quitting = true;
  endCapture();
  dropWarm();
}

function schedulePrewarm(): void {
  if (!getSettings().capture.instantCapture || quitting) return;
  if (prewarmTimer) clearTimeout(prewarmTimer);
  // Top up any missing displays (no-op if all active displays were returned to the pool).
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    prewarm();
  }, 300);
}

/** Hides overlays immediately (e.g. while an image is being encoded) without destroying them. */
export function hideOverlays(): void {
  if (session) session.finishing = true;
  for (const { win } of session?.overlays.values() ?? []) if (!win.isDestroyed()) win.hide();
}

export function overlayDisplay(win: BrowserWindow): Display | undefined {
  return session?.overlays.get(win.webContents.id)?.display;
}

handle('overlay:init', (_req, { win }) => {
  for (const entry of warmPool.values()) {
    if (entry.win === win && entry.phase === 'fresh' && entry.pendingInit) {
      return entry.pendingInit;
    }
  }
  const state = stateOf(win);
  if (session) {
    state.perf.overlay_init_requested = roundMs(performance.now() - session.startedAt);
  }
  return state.init;
});

handle('overlay:painted', (paintedPerf, { win }) => {
  const state = session?.overlays.get(win.webContents.id);
  if (!session || !state) return;
  state.reusable = true;
  if (session.finishing) return;
  const ipcLatency = paintedPerf
    ? Math.max(0, roundMs(epochMs() - paintedPerf.sentEpochMs))
    : undefined;
  // X11 window managers keep panels above plain always-on-top windows.
  if (isLinux) win.setFullScreen(true);
  const showT0 = performance.now();
  win.show();
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (state.display.id === cursor.id) win.focus();
  const winShowMs = roundMs(performance.now() - showT0);
  if (!session.shown) {
    session.shown = true;
    const overlayShown = roundMs(performance.now() - session.hotkeyAt);
    recordTiming('hotkeyToOverlay', performance.now() - session.startedAt);
    const metrics: PerfMetrics = {
      ...state.perf,
      ...(paintedPerf?.metrics ?? {}),
      ...(ipcLatency !== undefined ? { overlay_painted_ipc: ipcLatency } : {}),
      win_show: winShowMs,
      startCapture_to_overlay_shown: roundMs(performance.now() - session.startedAt),
      overlay_shown: overlayShown,
    };
    logPerf({
      phase: 'open-overlay',
      ts: new Date().toISOString(),
      meta: {
        mode: session.mode,
        warm: state.isWarm,
        width: state.display.bounds.width,
        height: state.display.bounds.height,
        scaleFactor: state.display.scaleFactor,
      },
      metrics,
    });
  }
});

handle('overlay:selection-start', (_req, { win }) => {
  for (const { win: other } of session?.overlays.values() ?? []) {
    if (other !== win) send(other, 'overlay:clear-selection', undefined);
  }
});

handle('overlay:cancel', (_req, { win }) => endCapture(win));
handle('overlay:hide', (_req, { win }) => {
  if (overlayDisplay(win)) hideOverlays();
});

handle('capture:remember-area', ({ rect }, { win }) => {
  const display = overlayDisplay(win);
  if (display) lastArea = { displayId: display.id, rect };
});

handle('capture:to-editor', async ({ image, doc }) => {
  endCapture();
  const { openEditorWithImage } = await import('../editor');
  await openEditorWithImage(
    { rgba: new Uint8Array(image.rgba), width: image.width, height: image.height },
    doc,
  );
});

handle('capture:record', async (request, { win }) => {
  const display = overlayDisplay(win);
  endCapture();
  if (!display) return;
  const { startRecording } = await import('../recording');
  await startRecording(display, request.rect, request.gif, request.audio);
});

handle('capture:scroll', async (request, { win }) => {
  const display = overlayDisplay(win);
  endCapture();
  if (!display) return;
  const { startScrollCapture } = await import('../scroll');
  await startScrollCapture(display, request.rect);
});
