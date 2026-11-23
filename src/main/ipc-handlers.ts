import { release } from 'node:os';
import { app, type BrowserWindow, shell } from 'electron';
import type { DeliverRequest, EncodedImage, WindowKind } from '../shared/ipc';
import {
  type DeliverPerf,
  epochMs,
  type PerfMeta,
  type PerfMetrics,
  roundMs,
} from '../shared/perf';
import type { ToolChoices } from '../shared/settings';
import { installKind, osName } from '../shared/update';
import { registerBackgrounds } from './backgrounds';
import {
  bufferToArrayBuffer,
  cropRgba,
  encodeFastPng,
  encodeFastThumbnail,
  encodeSaveFormat,
} from './capture/fast-encode';
import { copyText } from './clipboard';
import { getFrame, releaseFrame } from './frames';
import { getHotkeyReport } from './hotkeys';
import { handle } from './ipc';
import { logPerf } from './perf';
import { getSettings, onSettingsChanged, patchSettings } from './settings-store';
import { broadcast } from './windows';

function logDeliverPerf(
  meta: PerfMeta,
  rendererPerf: DeliverPerf | undefined,
  extraMetrics: PerfMetrics,
  ipcTransferMs: number | undefined,
  handlerStart: number,
): void {
  const finishPreIpc = rendererPerf?.metrics.finish_pre_ipc;
  const handlerTotal = roundMs(performance.now() - handlerStart);
  const metrics: PerfMetrics = {
    ...(rendererPerf?.metrics ?? {}),
    ...(ipcTransferMs !== undefined ? { ipc_deliver_transfer: ipcTransferMs } : {}),
    ...extraMetrics,
    ...(finishPreIpc !== undefined && ipcTransferMs !== undefined
      ? { finish_to_deliver_total: roundMs(finishPreIpc + ipcTransferMs + handlerTotal) }
      : {}),
  };
  logPerf({
    phase: 'deliver',
    ts: new Date().toISOString(),
    meta,
    metrics,
  });
}

function transferMs(perf: DeliverPerf | undefined): number | undefined {
  return perf ? Math.max(0, roundMs(epochMs() - perf.sentEpochMs)) : undefined;
}

/** Handlers shared by all windows. Feature modules register their own on import. */
export function registerIpc(): void {
  handle('settings:get', () => getSettings());
  handle('settings:patch', (patch) => patchSettings(patch));
  handle('hotkeys:status', () => getHotkeyReport());
  registerToolChoices();
  registerBackgrounds();
  handle('window:close', (_req, { win }) => win.close());
  handle('window:set-size', ({ width, height }, { win }) => {
    win.setContentSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  });
  handle('frame:release', (id) => releaseFrame(id));
  handle('clipboard:text', (text) => copyText(text));
  // Registered here, not by the capture session: editors opened from history,
  // files or the clipboard deliver too, without any capture having run.
  handle('capture:deliver', async (request, { kind, win }) => {
    const handlerStart = performance.now();
    const ipcTransferMs = transferMs(request.perf);
    const endCaptureT0 = performance.now();
    // The overlay has already encoded everything it needs; close it right away.
    if (kind === 'overlay') (await import('./capture/session')).endCapture(win);
    const endCaptureMs = kind === 'overlay' ? roundMs(performance.now() - endCaptureT0) : undefined;
    // Editors hold the entry their edits go to, which changes on a first save or Save as copy.
    const holdEntry = kind === 'editor' ? (await import('./editor')).holdEntry : undefined;
    const deliverPerf: PerfMetrics = {};
    try {
      return await (await import('./deliver')).deliver(
        request,
        holdEntry && ((id) => holdEntry(win, id)),
        deliverPerf,
      );
    } finally {
      logDeliverPerf(
        {
          action: request.action,
          kind: kind as WindowKind,
          width: request.image.width,
          height: request.image.height,
          pngBytes: request.image.bytes.byteLength,
          ...(request.saveImage ? { saveBytes: request.saveImage.bytes.byteLength } : {}),
        },
        request.perf,
        {
          ...(endCaptureMs !== undefined ? { end_capture: endCaptureMs } : {}),
          ...deliverPerf,
        },
        ipcTransferMs,
        handlerStart,
      );
    }
  });
  handle('capture:deliver-raw', async (request, { kind, win }) => {
    const handlerStart = performance.now();
    const ipcTransferMs = transferMs(request.perf);
    const frame = getFrame(request.frameId);
    if (!frame) {
      (await import('./capture/session')).endCapture(win);
      throw new Error(`Frame ${request.frameId} is no longer available`);
    }

    const cropT0 = performance.now();
    const cropped = cropRgba(frame.rgba, frame.width, frame.height, request.crop);
    const rawCropMs = roundMs(performance.now() - cropT0);

    const pngT0 = performance.now();
    const pngBuf = encodeFastPng(cropped.rgba, cropped.width, cropped.height);
    const fastPngEncodeMs = roundMs(performance.now() - pngT0);

    const settings = getSettings();
    const needsSave =
      request.action === 'save' ||
      request.action === 'saveAs' ||
      (request.action === 'quick' && settings.capture.quickAction.includes('save'));
    let saveEncodeMs: number | undefined;
    let saveImage: EncodedImage | undefined;
    if (needsSave && settings.output.imageFormat !== 'png') {
      const saveT0 = performance.now();
      const encoded = encodeSaveFormat(
        cropped.rgba,
        cropped.width,
        cropped.height,
        pngBuf,
        settings.output.imageFormat,
        settings.output.imageQuality,
      );
      saveEncodeMs = roundMs(performance.now() - saveT0);
      saveImage = {
        bytes: bufferToArrayBuffer(encoded.bytes),
        mime: encoded.mime,
        width: cropped.width,
        height: cropped.height,
      };
    }

    // Cropping & encoding are done; close the overlay and release all display frames now.
    const endCaptureT0 = performance.now();
    (await import('./capture/session')).endCapture(win);
    const endCaptureMs = roundMs(performance.now() - endCaptureT0);

    const deliverRequest: DeliverRequest = {
      action: request.action,
      image: {
        bytes: bufferToArrayBuffer(pngBuf),
        mime: 'image/png',
        width: cropped.width,
        height: cropped.height,
      },
      ...(saveImage ? { saveImage } : {}),
      ...(request.screenRect ? { screenRect: request.screenRect } : {}),
      ...(request.quiet !== undefined ? { quiet: request.quiet } : {}),
      ...(request.perf ? { perf: request.perf } : {}),
    };

    const deliverPerf: PerfMetrics = {};
    try {
      return await (await import('./deliver')).deliver(deliverRequest, undefined, deliverPerf, () =>
        encodeFastThumbnail(pngBuf),
      );
    } finally {
      logDeliverPerf(
        {
          action: request.action,
          kind: kind as WindowKind,
          fastPath: true,
          width: cropped.width,
          height: cropped.height,
          pngBytes: pngBuf.byteLength,
          ...(saveImage ? { saveBytes: saveImage.bytes.byteLength } : {}),
        },
        request.perf,
        {
          raw_crop: rawCropMs,
          fast_png_encode: fastPngEncodeMs,
          ...(saveEncodeMs !== undefined ? { save_encode: saveEncodeMs } : {}),
          end_capture: endCaptureMs,
          ...deliverPerf,
        },
        ipcTransferMs,
        handlerStart,
      );
    }
  });
  handle('shell:open-url', async (url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    os: osName(process.platform, release(), process.arch),
    install: installKind(process.platform, process.env, app.isPackaged),
    packaged: app.isPackaged,
  }));
  // The update module loads on first use, so this works before the startup check has run.
  handle('update:check', async () => (await import('./update')).checkNow());
  onSettingsChanged((next) => broadcast('settings:changed', next));
}

function registerToolChoices(): void {
  const observed = new WeakSet<BrowserWindow>();
  let pending: Partial<ToolChoices> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    clearTimeout(timer);
    if (Object.keys(pending).length === 0) return;
    const tools = pending;
    pending = {};
    void patchSettings({ tools }).catch((error) =>
      console.error('[settings] could not remember tool choices', error),
    );
  }

  // Main receives the choices before an overlay is destroyed. Disk writes can
  // still be debounced even when the renderer that sent them is already gone.
  handle('settings:remember-tools', (tools, { win }) => {
    Object.assign(pending, tools);
    if (!observed.has(win)) {
      observed.add(win);
      win.once('closed', flush);
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
}
