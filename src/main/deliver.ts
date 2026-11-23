import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, type Rectangle } from 'electron';
import { EXTENSIONS, expandTemplate } from '../shared/filename';
import type { DeliverAction, DeliverRequest, DeliverResult, EncodedImage } from '../shared/ipc';
import { type PerfMetrics, roundMs } from '../shared/perf';
import type { Settings } from '../shared/settings';
import { createUniqueFile, writeFileAtomic } from './atomic-file';
import { copyPng, copyText } from './clipboard';
import { checkEditable, queueEntry, release, replaceImage } from './history';
import { paths } from './paths';
import { getSettings } from './settings-store';

export function saveDir(settings: Settings): string {
  return settings.output.saveDir || paths.defaultSaveDir;
}

function templatePath(settings: Settings): string {
  return join(saveDir(settings), expandTemplate(settings.output.filenameTemplate, new Date()));
}

/** Suggests a non-existing path in the save folder from the filename template. */
export function defaultSavePath(mime: EncodedImage['mime'], settings = getSettings()): string {
  const base = templatePath(settings);
  const ext = EXTENSIONS[mime];
  let candidate = `${base}.${ext}`;
  for (let i = 2; existsSync(candidate); i++) candidate = `${base} (${i}).${ext}`;
  return candidate;
}

/** Writes through a temporary file, so a failed overwrite keeps the previous file. */
export function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  return writeFileAtomic(path, bytes);
}

/** Saves to a new file named from the template; never overwrites, even when saves race. */
async function saveToNewFile(bytes: Uint8Array, mime: EncodedImage['mime']): Promise<string> {
  const { path, handle } = await createUniqueFile(templatePath(getSettings()), EXTENSIONS[mime]);
  try {
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

export async function askSavePath(mime: EncodedImage['mime']): Promise<string | null> {
  const ext = EXTENSIONS[mime];
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultSavePath(mime),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return canceled || !filePath ? null : filePath;
}

/** Saves bytes either to the default folder or wherever the user picks. */
export async function saveBytes(
  bytes: Uint8Array,
  mime: EncodedImage['mime'],
  ask: boolean,
): Promise<DeliverResult> {
  let path: string;
  if (ask) {
    const chosen = await askSavePath(mime);
    if (!chosen) return { ok: false, error: 'cancelled' };
    // The user confirmed this name in the dialog, including any overwrite.
    await writeBytes(chosen, bytes);
    path = chosen;
  } else {
    path = await saveToNewFile(bytes, mime);
  }
  const settings = getSettings();
  if (settings.output.copyPathAfterSave || settings.capture.quickAction === 'save+copyPath') {
    await copyText(path);
  }
  return { ok: true, path };
}

/** Resolves the "quick" action (Enter) to concrete steps from settings. */
export function quickSteps(settings: Settings): DeliverAction[] {
  switch (settings.capture.quickAction) {
    case 'copy':
      return ['copy'];
    case 'save':
    case 'save+copyPath':
      return ['save'];
    case 'copy+save':
      return ['copy', 'save'];
    case 'none':
      return [];
  }
}

/**
 * Finishes a capture: runs the requested action, records the image in
 * history and shows the follow-up UI (floating preview, pin, OCR, upload).
 * `onEntry` gets the resulting entry id while this delivery still holds it,
 * so a caller (an editor) can take its own hold first.
 */
export async function deliver(
  request: DeliverRequest,
  onEntry?: (id: string) => void,
  perf?: PerfMetrics,
  thumbFactory?: () => Uint8Array | ArrayBuffer | undefined,
): Promise<DeliverResult> {
  const deliverT0 = performance.now();
  const settings = getSettings();
  const png = new Uint8Array(request.image.bytes);
  const steps = request.action === 'quick' ? quickSteps(settings) : [request.action];
  let result: DeliverResult = { ok: true };

  // Populate the clipboard first and immediately so the user can paste right away.
  if (steps.includes('copy')) await copyPng(png, perf);

  for (const step of steps) {
    if (step === 'save' || step === 'saveAs') {
      const file = request.saveImage ?? request.image;
      const ask = step === 'saveAs' || settings.output.saveAction === 'ask';
      const saveT0 = performance.now();
      result = await saveBytes(new Uint8Array(file.bytes), file.mime, ask);
      if (perf) perf.file_save = roundMs(performance.now() - saveT0);
      if (!result.ok) {
        if (perf) perf.deliver_total = roundMs(performance.now() - deliverT0);
        return result;
      }
    }
  }

  const edit = checkEditable(request.edit);
  const historyT0 = performance.now();
  const existing = request.historyId
    ? await replaceImage(request.historyId, {
        png,
        width: request.image.width,
        height: request.image.height,
        ...(request.thumb ? { thumb: request.thumb } : {}),
        ...(edit ? { edit } : {}),
        ...(result.path ? { savedPath: result.path } : {}),
      })
    : undefined;
  if (existing) {
    if (perf) perf.history_write = roundMs(performance.now() - historyT0);
    result.historyId = existing.id;
    onEntry?.(existing.id);
    if (steps.includes('pin')) await (await import('./pins')).pinEntry(existing.id);
    if (perf) perf.deliver_total = roundMs(performance.now() - deliverT0);
    return result;
  }
  const thumb = request.thumb ?? thumbFactory;
  const entry = queueEntry(
    {
      png,
      width: request.image.width,
      height: request.image.height,
      savedPath: result.path ?? null,
      ...(thumb ? { thumb } : {}),
      ...(edit ? { edit } : {}),
    },
    perf,
  );
  if (perf) perf.history_write = roundMs(performance.now() - historyT0);
  result.historyId = entry.id;

  try {
    onEntry?.(entry.id);
    if (steps.includes('pin')) {
      await (await import('./pins')).pinEntry(
        entry.id,
        request.screenRect as Rectangle | undefined,
      );
    } else if (steps.includes('ocr')) {
      await (await import('./ocr')).recognizeEntry(entry.id);
    } else if (steps.includes('upload')) {
      await (await import('./uploads')).uploadEntry(entry.id);
    } else if (settings.capture.showThumbnail && request.action !== 'none' && !request.quiet) {
      const floatT0 = performance.now();
      await (await import('./floating')).showFloating(entry);
      if (perf) perf.floating_show = roundMs(performance.now() - floatT0);
    }
    // The editor takes its own hold, so open it before this delivery's hold goes.
    if (settings.capture.openEditorAfterQuick && request.action === 'quick') {
      const edT0 = performance.now();
      await (await import('./editor')).openHistoryEntry(entry.id);
      if (perf) perf.open_editor_after_quick = roundMs(performance.now() - edT0);
    }
  } finally {
    release(entry.id);
    if (perf) perf.deliver_total = roundMs(performance.now() - deliverT0);
  }
  return result;
}
