import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '../../src/main/app-state';
import {
  dropWarm,
  endCapture,
  isCapturing,
  prewarm,
  startCapture,
  WARM_IDLE_MS,
} from '../../src/main/capture/session';
import { frameCount, type Frame } from '../../src/main/frames';

const { createWindow, send, grabDisplay, state, handlers } = vi.hoisted(() => ({
  createWindow: vi.fn(),
  send: vi.fn(),
  grabDisplay: vi.fn<() => Promise<Frame>>(),
  state: { instantCapture: false, nextId: 1 },
  handlers: new Map<string, (req: unknown, ctx: { win: Overlay }) => unknown>(),
}));

vi.mock('electron', () => {
  const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } };
  return {
    app: { isPackaged: false, getAppPath: () => '.' },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => display,
      getAllDisplays: () => [display],
    },
  };
});
vi.mock('../../src/main/capture/grab', () => ({ grabDisplay }));
vi.mock('../../src/main/windows', () => ({ createWindow, send }));
vi.mock('../../src/main/ipc', () => ({
  handle: (channel: string, fn: (req: unknown, ctx: { win: Overlay }) => unknown) => {
    handlers.set(channel, fn);
  },
}));
vi.mock('../../src/main/settings-store', () => ({
  getSettings: () => ({ capture: { instantCapture: state.instantCapture, instantPreview: false } }),
}));
vi.mock('../../src/main/test-hooks', () => ({ recordTiming: () => {} }));

class Overlay extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { id: state.nextId++ });
  isDestroyed = () => this.closed;
  setAlwaysOnTop = vi.fn();
  setVisibleOnAllWorkspaces = vi.fn();
  setBounds = vi.fn();
  setFullScreen = vi.fn();
  isFullScreen = () => false;
  show = vi.fn();
  hide = vi.fn();
  focus = vi.fn();
  closed = false;

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed');
  }
}

const frame: Frame = { width: 1, height: 1, rgba: new Uint8Array(4) };

beforeEach(() => {
  vi.useFakeTimers();
  state.instantCapture = false;
  state.nextId = 1;
  createWindow.mockReset().mockImplementation(() => new Overlay());
  send.mockReset();
  grabDisplay.mockReset().mockResolvedValue(frame);
});

afterEach(() => {
  endCapture();
  dropWarm();
  appState.delaySeconds = 0;
  vi.useRealTimers();
});

describe('capture sessions', () => {
  it('starts one session for overlapping delayed requests', async () => {
    appState.delaySeconds = 1;
    const requests = Promise.all([startCapture('area'), startCapture('area')]);
    await vi.advanceTimersByTimeAsync(1000);
    await requests;
    expect(createWindow).toHaveBeenCalledTimes(1);
    endCapture();
    expect(isCapturing()).toBe(false);
    expect(frameCount()).toBe(0);
  });

  it('discards a display grab that resolves after cancellation', async () => {
    let resolveGrab: (frame: Frame) => void = () => {};
    const grab = new Promise<Frame>((resolve) => {
      resolveGrab = resolve;
    });
    grabDisplay.mockReturnValue(grab);
    const started = startCapture('area');
    expect(isCapturing()).toBe(true);
    endCapture();
    resolveGrab(frame);
    await started;
    expect(isCapturing()).toBe(false);
    expect(frameCount()).toBe(0);
  });

  it('destroys the overlay on endCapture and skips warm pool when instantCapture is false', async () => {
    state.instantCapture = false;
    prewarm();
    expect(createWindow).not.toHaveBeenCalled();

    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(1);
    const firstWin = createWindow.mock.results[0]?.value as Overlay;
    handlers.get('overlay:painted')?.(undefined, { win: firstWin });

    endCapture();
    expect(firstWin.isDestroyed()).toBe(true);
    expect(send).not.toHaveBeenCalledWith(firstWin, 'overlay:standby', undefined);

    await vi.advanceTimersByTimeAsync(1000);
    expect(createWindow).toHaveBeenCalledTimes(1);

    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it('reuses warm overlays on instantCapture and auto-unloads after 30s idle', async () => {
    state.instantCapture = true;
    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(1);
    const win = createWindow.mock.results[0]?.value as Overlay;

    handlers.get('overlay:painted')?.(undefined, { win });
    endCapture();
    expect(win.isDestroyed()).toBe(false);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(win, 'overlay:standby', undefined);

    // Immediate repeat capture reuses the standby overlay instead of creating a new window.
    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      win,
      'overlay:reset',
      expect.objectContaining({ warm: true }),
    );

    // Returning to standby starts the 30s idle auto-unload timer.
    endCapture();
    await vi.advanceTimersByTimeAsync(WARM_IDLE_MS - 1);
    expect(win.isDestroyed()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(win.isDestroyed()).toBe(true);

    // Next capture after idle unload creates a fresh overlay.
    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it('unloads prewarmed overlays after 30s idle and cancels the timer on startCapture', async () => {
    state.instantCapture = true;
    prewarm();
    expect(createWindow).toHaveBeenCalledTimes(1);
    const prewarmed = createWindow.mock.results[0]?.value as Overlay;

    // Starting a capture at 20s cancels the 30s idle timer so the window stays alive past 30s.
    await vi.advanceTimersByTimeAsync(20_000);
    await startCapture('area');
    expect(createWindow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(prewarmed.isDestroyed()).toBe(false);

    // Painted + endCapture restarts the 30s idle window from scratch.
    handlers.get('overlay:painted')?.(undefined, { win: prewarmed });
    endCapture();
    await vi.advanceTimersByTimeAsync(WARM_IDLE_MS - 1);
    expect(prewarmed.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(prewarmed.isDestroyed()).toBe(true);
  });

  it('ends the session when a standby capture fails to grab', async () => {
    state.instantCapture = true;
    await startCapture('area');
    const win = createWindow.mock.results[0]?.value as Overlay;
    handlers.get('overlay:painted')?.(undefined, { win });
    endCapture();

    grabDisplay.mockRejectedValueOnce(new Error('grab failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startCapture('area');
      await Promise.resolve();
      expect(isCapturing()).toBe(false);
      expect(send).not.toHaveBeenCalledWith(win, 'overlay:reset', expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('destroys an active overlay and ends the session on render-process-gone', async () => {
    state.instantCapture = true;
    await startCapture('area');
    const win = createWindow.mock.results[0]?.value as Overlay;
    expect(isCapturing()).toBe(true);

    win.webContents.emit('render-process-gone');
    expect(win.isDestroyed()).toBe(true);
    expect(isCapturing()).toBe(false);
  });

  it('recycles overlays even when overlay:painted arrives after overlay:hide', async () => {
    state.instantCapture = true;
    await startCapture('screen');
    const win = createWindow.mock.results[0]?.value as Overlay;

    handlers.get('overlay:hide')?.(undefined, { win });
    handlers.get('overlay:painted')?.(undefined, { win });
    expect(win.show).not.toHaveBeenCalled();

    endCapture();
    expect(win.isDestroyed()).toBe(false);
    expect(send).toHaveBeenCalledWith(win, 'overlay:standby', undefined);
  });
});
