import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EditableSource, HistoryEntry } from '../shared/ipc';
import { type PerfMetrics, roundMs } from '../shared/perf';
import { isProjectDoc, type Project, packProject, unpackProject } from '../shared/project';
import { isRecord } from '../shared/schema';
import { readJson, writeFileAtomic } from './atomic-file';
import { paths } from './paths';
import { registerMediaRoute } from './protocol';
import { serialQueue } from './serial';
import { getSettings } from './settings-store';
import { send, windowsOf } from './windows';

/**
 * Capture history: one PNG and one WebP thumbnail per entry plus a JSON index,
 * all under userData/history. Thumbnails are written at capture time so the
 * history window never decodes full images. Annotated entries also keep an
 * `.anyshot` project (original pixels + annotation document) so they reopen
 * editable; the PNG stays the rendered result used for copy, pin and export.
 */
let entries: HistoryEntry[] | null = null;
let loading: Promise<HistoryEntry[]> | null = null;
let dirCreatedFor: string | null = null;
/** Serialises index updates so concurrent captures can't lose entries. */
const serial = serialQueue();
/** How many consumers (pins, previews, editors, a delivery) hold each entry. */
const holds = new Map<string, number>();
/** Entries queued for background disk flush, served immediately from memory until persisted. */
const pendingEntries = new Map<string, HistoryEntry>();
const pendingMedia = new Map<
  string,
  { png: Uint8Array; thumb?: Uint8Array; edit?: EditableSource }
>();
const pendingWrites = new Map<string, Promise<void>>();
/** Monotonic creation sequence for deterministic newest-first ordering within a session. */
let nextCreationSeq = 0;
const creationSeq = new Map<string, number>();

const indexFile = () => join(paths.historyDir, 'index.json');
export const imagePath = (id: string) => join(paths.historyDir, `${id}.png`);
export const thumbPath = (id: string) => join(paths.historyDir, `${id}.thumb.webp`);
export const projectPath = (id: string) => join(paths.historyDir, `${id}.anyshot`);

async function ensureHistoryDir(): Promise<void> {
  const dir = paths.historyDir;
  if (dirCreatedFor === dir) return;
  await mkdir(dir, { recursive: true });
  dirCreatedFor = dir;
}

function detectImageMime(bytes: Uint8Array, fallback: string): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return fallback;
}

function isEntry(v: unknown): v is HistoryEntry {
  const e = v as HistoryEntry;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    /^[\w-]+$/.test(e.id) &&
    typeof e.createdAt === 'number' &&
    typeof e.width === 'number' &&
    typeof e.height === 'number'
  );
}

async function load(): Promise<HistoryEntry[]> {
  if (entries) return entries;
  loading ??= readJson(indexFile())
    .then((raw) => {
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('Invalid history index');
      entries = raw?.filter(isEntry) ?? [];
      return entries;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function notifyHistoryChanged(): void {
  // Open history windows reload, so captures finished after they opened still appear.
  for (const win of windowsOf('history')) send(win, 'history:changed', undefined);
}

async function persist(next: HistoryEntry[]): Promise<void> {
  await writeFileAtomic(indexFile(), JSON.stringify(next, null, 1));
  entries = next;
  notifyHistoryChanged();
}

function deletePending(id: string): boolean {
  const hadEntry = pendingEntries.delete(id);
  const hadMedia = pendingMedia.delete(id);
  return hadEntry || hadMedia;
}

function recordCreation(id: string): void {
  creationSeq.set(id, ++nextCreationSeq);
}

function compareNewestFirst(a: HistoryEntry, b: HistoryEntry): number {
  return (creationSeq.get(b.id) ?? 0) - (creationSeq.get(a.id) ?? 0);
}

function pendingNewestFirst(): HistoryEntry[] {
  return [...pendingEntries.values()].reverse().sort(compareNewestFirst);
}

/**
 * Entries used by open pins, previews or editors survive pruning until every
 * holder has released them. Each retain must be balanced by one release.
 */
export function retain(id: string): void {
  holds.set(id, (holds.get(id) ?? 0) + 1);
}

export function release(id: string): void {
  const count = (holds.get(id) ?? 0) - 1;
  if (count > 0) holds.set(id, count);
  else holds.delete(id);
  void serial(prune).catch((error) => console.error('[history] pruning failed', error));
}

function removeFiles(list: readonly HistoryEntry[]): Promise<unknown> {
  return Promise.all(
    list.flatMap((e) => [
      rm(imagePath(e.id), { force: true }),
      rm(thumbPath(e.id), { force: true }),
      rm(projectPath(e.id), { force: true }),
    ]),
  );
}

async function prune(): Promise<void> {
  const list = await load();
  const limit = getSettings().output.historySize;
  const keep: HistoryEntry[] = [];
  const drop: HistoryEntry[] = [];
  for (const [i, entry] of list.entries()) {
    (i < limit || holds.has(entry.id) ? keep : drop).push(entry);
  }
  let droppedPending = false;
  if (pendingEntries.size > 0) {
    for (const [i, entry] of pendingNewestFirst().entries()) {
      if (pendingWrites.has(entry.id) || holds.has(entry.id)) continue;
      const newerOnDisk = keep.filter(
        (d) => d.id !== entry.id && compareNewestFirst(d, entry) < 0,
      ).length;
      if (i + newerOnDisk >= limit && deletePending(entry.id)) {
        creationSeq.delete(entry.id);
        droppedPending = true;
      }
    }
  }
  if (drop.length > 0) {
    await persist(keep);
    await removeFiles(drop);
    for (const entry of drop) creationSeq.delete(entry.id);
  } else if (droppedPending) {
    notifyHistoryChanged();
  }
}

const isSide = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/**
 * Accepts an editable source from a window only if it is a PNG with a
 * well-formed document; anything else is stored as a plain image. The shape
 * is checked too: a renderer's payload is untrusted, and a broken one must
 * not fail the whole delivery.
 */
export function checkEditable(edit: unknown): EditableSource | undefined {
  if (edit === undefined) return undefined;
  const source = isRecord(edit) ? edit.source : undefined;
  if (
    isRecord(edit) &&
    isRecord(source) &&
    source.mime === 'image/png' &&
    source.bytes instanceof ArrayBuffer &&
    source.bytes.byteLength > 0 &&
    isSide(source.width) &&
    isSide(source.height) &&
    isProjectDoc(edit.doc, { width: source.width, height: source.height })
  ) {
    return {
      doc: edit.doc,
      source: {
        mime: 'image/png',
        bytes: source.bytes,
        width: source.width,
        height: source.height,
      },
    };
  }
  console.warn('[history] ignoring a malformed annotation document');
  return undefined;
}

async function readIfExists(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes (or, without an edit, removes) the entry's editable project. */
async function writeEditable(id: string, edit: EditableSource | undefined): Promise<void> {
  if (!edit) {
    await rm(projectPath(id), { force: true });
    return;
  }
  const { width, height, bytes } = edit.source;
  await writeFileAtomic(
    projectPath(id),
    packProject({
      doc: edit.doc,
      image: { mime: 'image/png', width, height },
      bytes: new Uint8Array(bytes),
    }),
  );
}

function editableToProject(edit: EditableSource): Project {
  return {
    doc: edit.doc,
    image: {
      mime: edit.source.mime,
      width: edit.source.width,
      height: edit.source.height,
    },
    bytes: new Uint8Array(edit.source.bytes),
  };
}

async function writeEntryMedia(
  id: string,
  png: Uint8Array,
  thumb: Uint8Array | undefined,
  edit: EditableSource | undefined,
): Promise<void> {
  // Settle every write before cleanup so an in-flight writeEditable rename cannot outlive removeFiles.
  const results = await Promise.allSettled([
    writeFile(imagePath(id), png),
    ...(thumb ? [writeFile(thumbPath(id), thumb)] : []),
    ...(edit ? [writeEditable(id, edit)] : []),
  ]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * The entry's original pixels and annotation document, or null when it only
 * has a rendered image (older entries, plain captures) or the stored project
 * is malformed; callers then open the rendered image instead.
 */
export async function readEditable(id: string): Promise<Project | null> {
  const media = pendingMedia.get(id);
  if (media?.edit) return editableToProject(media.edit);
  const write = pendingWrites.get(id);
  if (write) await write;
  const retained = pendingMedia.get(id);
  if (retained?.edit) return editableToProject(retained.edit);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(projectPath(id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[history] could not read the document of', id, error);
    return null;
  }
  try {
    const project = unpackProject(bytes);
    if (project.image.mime === 'image/png' && isProjectDoc(project.doc, project.image))
      return project;
  } catch {
    // Reported below like any other malformed project.
  }
  console.warn('[history] ignoring the malformed document of', id);
  return null;
}

export interface QueueEntryInput {
  png: Uint8Array;
  thumb?: ArrayBuffer | Uint8Array | (() => Uint8Array | ArrayBuffer | undefined);
  width: number;
  height: number;
  savedPath?: string | null;
  edit?: EditableSource;
}

export function addEntry(
  input: {
    png: Uint8Array;
    thumb?: ArrayBuffer;
    width: number;
    height: number;
    savedPath?: string | null;
    edit?: EditableSource;
  },
  perf?: PerfMetrics,
): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    width: input.width,
    height: input.height,
    kind: 'image',
    savedPath: input.savedPath ?? null,
  };
  recordCreation(entry.id);
  return serial(async () => {
    try {
      const loadT0 = performance.now();
      const list = await load();
      if (perf) perf.history_load = roundMs(performance.now() - loadT0);
      await ensureHistoryDir();
      const pngT0 = performance.now();
      await writeFile(imagePath(entry.id), input.png);
      if (perf) perf.history_png_write = roundMs(performance.now() - pngT0);
      if (input.thumb) {
        const thumbT0 = performance.now();
        await writeFile(thumbPath(entry.id), new Uint8Array(input.thumb));
        if (perf) perf.history_thumb_write = roundMs(performance.now() - thumbT0);
      }
      if (input.edit) {
        const editT0 = performance.now();
        await writeEditable(entry.id, input.edit);
        if (perf) perf.history_edit_write = roundMs(performance.now() - editT0);
      }
      const persistT0 = performance.now();
      await persist([entry, ...list]);
      if (perf) perf.history_index_persist = roundMs(performance.now() - persistT0);
    } catch (error) {
      creationSeq.delete(entry.id);
      await removeFiles([entry]).catch(() => undefined);
      throw error;
    }
    retain(entry.id);
    return entry;
  });
}

/**
 * Registers and retains a history entry immediately in memory while flushing
 * PNG, thumbnail, editable project and `index.json` writes asynchronously in
 * the serialized background queue.
 */
export function queueEntry(input: QueueEntryInput, perf?: PerfMetrics): HistoryEntry {
  const t0 = performance.now();
  const entry: HistoryEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    width: input.width,
    height: input.height,
    kind: 'image',
    savedPath: input.savedPath ?? null,
  };
  retain(entry.id);
  recordCreation(entry.id);
  pendingEntries.set(entry.id, entry);
  const eagerThumb =
    typeof input.thumb === 'function'
      ? undefined
      : input.thumb
        ? new Uint8Array(input.thumb)
        : undefined;
  pendingMedia.set(entry.id, {
    png: input.png,
    ...(eagerThumb ? { thumb: eagerThumb } : {}),
    ...(input.edit ? { edit: input.edit } : {}),
  });

  const writePromise = serial(async () => {
    // Yield one turn so deliver() and IPC reply complete before thumbnail encoding or disk I/O.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let persisted = false;
    try {
      await ensureHistoryDir();
      const list = await load();
      const rawThumb = typeof input.thumb === 'function' ? input.thumb() : input.thumb;
      const thumbArr = rawThumb ? new Uint8Array(rawThumb) : undefined;
      const media = pendingMedia.get(entry.id);
      if (media && thumbArr) media.thumb = thumbArr;
      await writeEntryMedia(entry.id, input.png, thumbArr, input.edit);
      await persist([entry, ...list]);
      persisted = true;
    } catch (error) {
      await removeFiles([entry]).catch(() => undefined);
      console.error(
        '[history] background write failed; keeping entry in memory for this session',
        error,
      );
    } finally {
      pendingWrites.delete(entry.id);
      if (persisted) deletePending(entry.id);
      else if (!pendingEntries.has(entry.id)) creationSeq.delete(entry.id);
    }
  });
  pendingWrites.set(entry.id, writePromise);
  if (perf) perf.history_queue = roundMs(performance.now() - t0);
  return entry;
}

/** Waits until all queued history writes and pruning tasks have settled. */
export async function flushHistory(): Promise<void> {
  await serial(async () => {});
}

export async function listEntries(): Promise<HistoryEntry[]> {
  const limit = getSettings().output.historySize;
  const disk = await load();
  if (pendingEntries.size === 0) {
    return disk.filter((e, i) => i < limit || holds.has(e.id));
  }
  const merged = [...pendingNewestFirst(), ...disk.filter((e) => !pendingEntries.has(e.id))].sort(
    compareNewestFirst,
  );
  return merged.filter((e, i) => i < limit || holds.has(e.id));
}

export async function getEntry(id: string): Promise<HistoryEntry | undefined> {
  return pendingEntries.get(id) ?? (await load()).find((e) => e.id === id);
}

export function getRetainedEntry(id: string): Promise<HistoryEntry | undefined> {
  return serial(async () => {
    const entry = await getEntry(id);
    if (entry) retain(id);
    return entry;
  });
}

export function updateEntry(id: string, patch: Partial<Omit<HistoryEntry, 'id'>>): Promise<void> {
  return serial(async () => {
    const pending = pendingEntries.get(id);
    if (pending) {
      pendingEntries.set(id, { ...pending, ...patch });
      notifyHistoryChanged();
      return;
    }
    const list = await load();
    await persist(list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  });
}

export async function readImage(id: string): Promise<Uint8Array> {
  const media = pendingMedia.get(id);
  if (media) return media.png;
  const write = pendingWrites.get(id);
  if (write) await write;
  return new Uint8Array(await readFile(imagePath(id)));
}

export function removeEntry(id: string): Promise<void> {
  return serial(async () => {
    const list = await load();
    const hadPending = deletePending(id);
    const next = list.filter((e) => e.id !== id);
    const dropped = list.filter((e) => e.id === id);
    if (dropped.length > 0) {
      await persist(next);
      await removeFiles(dropped);
      if (!pendingWrites.has(id)) creationSeq.delete(id);
    } else if (hadPending) {
      if (!pendingWrites.has(id)) creationSeq.delete(id);
      notifyHistoryChanged();
    }
  });
}

export function clearHistory(): Promise<void> {
  return serial(async () => {
    const list = await load();
    // Decide once: a hold released during the write must not delete a kept entry.
    const keep = list.filter((e) => holds.has(e.id));
    const drop = list.filter((e) => !holds.has(e.id));
    let droppedPending = false;
    for (const id of new Set([...pendingEntries.keys(), ...pendingMedia.keys()])) {
      if (!holds.has(id) && deletePending(id)) {
        if (!pendingWrites.has(id)) creationSeq.delete(id);
        droppedPending = true;
      }
    }
    if (drop.length > 0) {
      await persist(keep);
      await removeFiles(drop);
      for (const entry of drop) {
        if (!pendingWrites.has(entry.id)) creationSeq.delete(entry.id);
      }
    } else if (droppedPending) {
      notifyHistoryChanged();
    }
  });
}

registerMediaRoute('history', async (rest) => {
  const [id, what] = rest.split('/');
  if (!id || !/^[\w-]+$/.test(id)) return null;
  try {
    if (what === 'thumb') {
      const media = pendingMedia.get(id);
      if (media?.thumb) {
        return new Response(media.thumb as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': detectImageMime(media.thumb, 'image/webp') },
        });
      }
      const write = pendingWrites.get(id);
      if (write) await write;
      const retained = pendingMedia.get(id);
      if (retained?.thumb) {
        return new Response(retained.thumb as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': detectImageMime(retained.thumb, 'image/webp') },
        });
      }
      // Entries added without a thumbnail (e.g. pinned from the clipboard) fall back to the image.
      const thumb = await readFile(thumbPath(id)).catch(() => null);
      if (thumb) {
        return new Response(thumb, {
          headers: { 'content-type': detectImageMime(thumb, 'image/webp') },
        });
      }
      if (retained?.png) {
        return new Response(retained.png as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(await readFile(imagePath(id)), {
        headers: { 'content-type': 'image/png' },
      });
    }
    if (what === 'image') {
      const media = pendingMedia.get(id);
      if (media) {
        return new Response(media.png as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'image/png' },
        });
      }
      const write = pendingWrites.get(id);
      if (write) await write;
      return new Response(await readFile(imagePath(id)), {
        headers: { 'content-type': 'image/png' },
      });
    }
  } catch {
    return null;
  }
  return null;
});

/**
 * Replaces an entry's image and editable document (edits saved back from the
 * editor); without `edit` the entry becomes a plain image. `savedPath` is
 * updated when the edit was also saved to a file.
 */
export function replaceImage(
  id: string,
  input: {
    png: Uint8Array;
    thumb?: ArrayBuffer;
    width: number;
    height: number;
    savedPath?: string;
    edit?: EditableSource;
  },
): Promise<HistoryEntry | undefined> {
  return serial(async () => {
    const list = await load();
    const diskEntry = list.find((e) => e.id === id);
    const pendingEntry = diskEntry ? undefined : pendingEntries.get(id);
    const entry = diskEntry ?? pendingEntry;
    if (!entry) return undefined;
    const updated: HistoryEntry = {
      ...entry,
      width: input.width,
      height: input.height,
      updatedAt: Date.now(),
      ...(input.savedPath ? { savedPath: input.savedPath } : {}),
    };
    if (pendingEntry) {
      const thumbArr = input.thumb ? new Uint8Array(input.thumb) : undefined;
      try {
        await ensureHistoryDir();
        await writeEntryMedia(id, input.png, thumbArr, input.edit);
        await persist([updated, ...list].sort(compareNewestFirst));
        deletePending(id);
      } catch (error) {
        await removeFiles([updated]).catch(() => undefined);
        pendingEntries.set(id, updated);
        pendingMedia.set(id, {
          png: input.png,
          ...(thumbArr ? { thumb: thumbArr } : {}),
          ...(input.edit ? { edit: input.edit } : {}),
        });
        notifyHistoryChanged();
        console.error(
          '[history] background write failed; keeping updated entry in memory for this session',
          error,
        );
      }
      return updated;
    }
    // All or nothing: if any file or the index can't be written, the previous
    // image, thumbnail and project come back, so the entry never shows a new
    // image with an old document (or the reverse).
    const files = [imagePath(id), thumbPath(id), projectPath(id)];
    const previous = await Promise.all(files.map(readIfExists));
    try {
      await writeFileAtomic(imagePath(id), input.png);
      if (input.thumb) await writeFileAtomic(thumbPath(id), new Uint8Array(input.thumb));
      await writeEditable(id, input.edit);
      await persist(list.map((e) => (e.id === id ? updated : e)));
    } catch (error) {
      await Promise.all(
        files.map((file, i) => {
          const bytes = previous[i];
          return (bytes ? writeFileAtomic(file, bytes) : rm(file, { force: true })).catch(
            (restoreError: unknown) =>
              console.error('[history] could not restore', file, restoreError),
          );
        }),
      );
      throw error;
    }
    return updated;
  });
}
