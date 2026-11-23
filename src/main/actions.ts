import { app } from 'electron';
import type { CaptureMode } from '../shared/ipc';
import type { HotkeyAction } from '../shared/settings';
import { appState, setAppState } from './app-state';
import type { AppAction } from './cli';

const CAPTURE_MODES: Partial<Record<AppAction, CaptureMode>> = {
  captureArea: 'area',
  captureScreen: 'screen',
  captureOcr: 'ocr',
  quickCapture: 'quick',
  captureLastArea: 'last',
  scrollCapture: 'scroll',
  recordArea: 'record',
  recordGif: 'gif',
};

export function isCaptureAction(action: AppAction): action is HotkeyAction {
  return action in CAPTURE_MODES;
}

let captureSession: typeof import('./capture/session') | null = null;

/** Loads and caches the capture session module so hotkeys pay 0ms import latency. */
export async function loadCaptureSession(): Promise<typeof import('./capture/session')> {
  captureSession ??= await import('./capture/session');
  return captureSession;
}

/** Returns the capture session module if it has already been loaded, without triggering an import. */
export function getLoadedCaptureSession(): typeof import('./capture/session') | null {
  return captureSession;
}

/**
 * The single entry point for tray items, global shortcuts, command-line flags
 * and tests. Feature modules are imported on first use to keep idle memory low.
 */
export async function runAction(action: AppAction, file?: string): Promise<void> {
  const triggeredAt = performance.now();
  const mode = CAPTURE_MODES[action];
  if (mode) {
    if (appState.recording && (mode === 'record' || mode === 'gif')) {
      return runAction('stopRecording');
    }
    const { startCapture } = captureSession ?? (await loadCaptureSession());
    return startCapture(mode, triggeredAt);
  }
  switch (action) {
    case 'stopRecording':
      return (await import('./recording')).stopRecording();
    case 'togglePauseRecording':
      return (await import('./recording')).togglePauseRecording();
    case 'history':
      return (await import('./history-window')).openHistory();
    case 'settings':
      return (await import('./settings-window')).openSettings();
    case 'checkForUpdates':
      return (await import('./update')).checkFromTray();
    case 'openImage':
      await (await import('./editor')).openImage(file);
      return;
    case 'openClipboard':
      return (await import('./editor')).openClipboard();
    case 'pinClipboard':
      return (await import('./pins')).pinClipboard();
    case 'quit':
      app.quit();
      return;
  }
}

export function setCaptureDelay(seconds: number): void {
  setAppState({ delaySeconds: seconds });
}
