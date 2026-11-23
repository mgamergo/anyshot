import { app, Menu } from 'electron';
import { PerfTimer } from '../shared/perf';
import type { Settings } from '../shared/settings';
import { getLoadedCaptureSession, loadCaptureSession, runAction, setCaptureDelay } from './actions';
import { onAppState } from './app-state';
import { type AppAction, handleSecondInstance, parseCli } from './cli';
import { flushHistory } from './history';
import { notifyHotkeyFailures, registerHotkeys, unregisterHotkeys } from './hotkeys';
import { registerIpc } from './ipc-handlers';
import { isTest } from './paths';
import { logPerf } from './perf';
import { registerAppScheme } from './protocol';
import { getSettings, loadSettings, onSettingsChanged } from './settings-store';
import { createTray, trayTemplate, updateTray } from './tray';
import { broadcast, focusExisting } from './windows';

const indexStart = performance.now();
const uptimeAtIndex = process.uptime() * 1000;
const STARTUP_PREWARM_DELAY_MS = 2000;
let startupPrewarmTimer: ReturnType<typeof setTimeout> | null = null;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
if (isWayland) {
  // Lets globalShortcut go through the desktop's GlobalShortcuts portal.
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}
registerAppScheme();

function dispatch(action: AppAction, file?: string): void {
  runAction(action, file).catch((error) => console.error(`[action] ${action} failed`, error));
}

function refreshTray(settings: Settings): void {
  const template = trayTemplate(settings, dispatch, setCaptureDelay);
  const menu = updateTray(template);
  // Tests drive the same menu the tray shows.
  if (isTest) Menu.setApplicationMenu(menu);
}

function applyHotkeys(hotkeys: Settings['hotkeys']): void {
  const report = registerHotkeys(hotkeys, (action) => dispatch(action));
  broadcast('hotkeys:changed', report);
  if (report.failed.length > 0 && !isTest) notifyHotkeyFailures(report.failed);
}

app.on('second-instance', (_event, argv, workingDirectory) => {
  handleSecondInstance(argv, workingDirectory, dispatch, () =>
    (['settings', 'history', 'editor'] as const).some(focusExisting),
  );
});

// Stay in the tray when the last window closes.
app.on('window-all-closed', () => {});

let quittingAfterFlush = false;

app.on('before-quit', (event) => {
  if (startupPrewarmTimer) {
    clearTimeout(startupPrewarmTimer);
    startupPrewarmTimer = null;
  }
  getLoadedCaptureSession()?.disposeOverlaysForQuit();
  if (quittingAfterFlush) return;
  event.preventDefault();
  quittingAfterFlush = true;
  void flushHistory()
    .catch((error) => console.error('[history] flush on quit failed', error))
    .finally(() => app.quit());
});

app.on('will-quit', () => unregisterHotkeys());

app.whenReady().then(async () => {
  const perf = new PerfTimer(indexStart);
  perf.set('process_uptime_at_index', uptimeAtIndex);
  perf.set('process_to_whenReady', process.uptime() * 1000);
  perf.mark('index_to_whenReady');
  Menu.setApplicationMenu(null);
  perf.sync('register_ipc', () => registerIpc());
  const settings = await perf.async('load_settings', () => loadSettings());
  perf.sync('tray_ready', () => {
    createTray();
    refreshTray(settings);
  });
  perf.sync('hotkeys_ready', () => applyHotkeys(settings.hotkeys));
  perf.mark('index_to_tray_hotkeys_ready');
  perf.set('process_to_tray_hotkeys_ready', process.uptime() * 1000);
  onSettingsChanged((next, prev) => {
    refreshTray(next);
    if (next.capture.instantCapture !== prev.capture.instantCapture) {
      if (!next.capture.instantCapture && startupPrewarmTimer) {
        clearTimeout(startupPrewarmTimer);
        startupPrewarmTimer = null;
      }
      void loadCaptureSession().then((m) =>
        next.capture.instantCapture ? m.prewarm() : m.dropWarm(),
      );
    }
    if (next.general.launchAtLogin !== prev.general.launchAtLogin) {
      void import('./login-item')
        .then((m) => m.applyLaunchAtLogin(next.general.launchAtLogin))
        .catch((error) => console.error('[login-item] could not update autostart', error));
    }
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      applyHotkeys(next.hotkeys);
    }
  });
  onAppState(() => refreshTray(getSettings()));
  if (isTest) (await import('./test-hooks')).installTestHooks(dispatch);
  logPerf({
    phase: 'cold-launch',
    ts: new Date().toISOString(),
    meta: { platform: process.platform, instantCapture: settings.capture.instantCapture },
    metrics: perf.metrics,
  });
  // Idle pre-warming right after tray + hotkeys are ready: keeps startup unblocked
  // while ensuring the first hotkey pays 0ms for native addon and module imports.
  // Do NOT touch session.defaultSession here: Chromium would pre-spawn an idle Tab process.
  setImmediate(() => {
    void (async () => {
      try {
        const [{ prewarmGrab }, sessionMod] = await Promise.all([
          import('./capture/grab'),
          loadCaptureSession(),
        ]);
        prewarmGrab();
        if (getSettings().capture.instantCapture) {
          startupPrewarmTimer = setTimeout(() => {
            startupPrewarmTimer = null;
            if (getSettings().capture.instantCapture) sessionMod.prewarm();
          }, STARTUP_PREWARM_DELAY_MS);
        }
      } catch (error) {
        console.warn('[prewarm] background prewarm failed', error);
      }
    })();
  });
  // Look for an update once startup has settled; it never blocks or fails startup.
  setTimeout(() => {
    import('./update')
      .then((m) => m.checkAtStartup())
      .catch((error) => console.warn('[update] check skipped', error));
  }, 5000);
  for (const command of parseCli(process.argv)) dispatch(command.action, command.file);
});
