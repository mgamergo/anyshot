/**
 * The single IPC contract shared by main, preload and windows. Every channel is
 * declared once with its request and response types, and with the window kinds
 * allowed to call it. Main rejects calls from any other sender.
 */
import type { AutoBeautify, CustomBackground, SavedBackground } from './background';
import type { Point, Rect, Size } from './geometry';
import type { DeliverPerf, OverlayPaintedPerf } from './perf';
import type { RecordingQuality } from './recording-quality';
import type { DeepPartial, HotkeyAction, Settings, ToolChoices, ToolId } from './settings';
import type { UpdateCheckResult, UpdateOffer, UpdateStatus } from './update';

export const APP_ORIGIN = 'app://local';

export type WindowKind =
  | 'overlay'
  | 'editor'
  | 'floating'
  | 'pin'
  | 'history'
  | 'settings'
  | 'recorder'
  | 'scroll'
  | 'ocr'
  | 'update';

export type CaptureMode =
  | 'area'
  | 'screen'
  | 'ocr'
  | 'quick'
  | 'last'
  | 'record'
  | 'gif'
  | 'scroll';

export interface OverlayInit {
  mode: CaptureMode;
  frameId: string;
  /** Physical pixel size of the frame; the canvas backing store uses this. */
  frame: Size;
  scaleFactor: number;
  /** Display bounds in CSS pixels; the window covers exactly this. */
  bounds: Rect;
  /** The previous selection on this display (CSS px), restored with R or "capture last area". */
  lastSelection: Rect | null;
  /** Full-screen modes select the whole display immediately. */
  selectAll: boolean;
  settings: Settings;
  /** Computer audio can be recorded on this platform (Windows loopback). */
  systemAudio: boolean;
  /** Non-empty when the overlay is a warm instance that will be reused. */
  warm: boolean;
}

export type DeliverAction =
  | 'copy'
  | 'save'
  | 'saveAs'
  | 'quick'
  | 'pin'
  | 'upload'
  | 'ocr'
  | 'editor'
  | 'none';

export interface EncodedImage {
  /** Encoded bytes (PNG unless `mime` says otherwise). */
  bytes: ArrayBuffer;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

/**
 * What keeps a capture editable in history: the original pixels (before
 * annotations, effects and crop) and the annotation document, in the
 * document's own coordinates.
 */
export interface EditableSource {
  doc: unknown;
  /** Lossless PNG of the original pixels. */
  source: EncodedImage;
}

export interface DeliverRequest {
  action: DeliverAction;
  /** Lossless PNG master: clipboard, history and pins use this. */
  image: EncodedImage;
  /** The same image in the configured save format, when that isn't PNG. */
  saveImage?: EncodedImage;
  /** Small WebP preview for history and the floating thumbnail. */
  thumb?: ArrayBuffer;
  /** Screen-space rectangle (CSS px) the image came from, for pins in place. */
  screenRect?: Rect;
  /** Present when annotations or effects were applied: history keeps them editable. */
  edit?: EditableSource;
  /** History entry being edited: its image is replaced instead of adding a new entry. */
  historyId?: string;
  /** Skip the floating preview (the editor is already showing the image). */
  quiet?: boolean;
  /** Benchmark timings collected in renderer/worker before IPC transfer. */
  perf?: DeliverPerf;
}

/**
 * Fast-path delivery for unannotated captures: overlay sends only the frameId
 * and physical-pixel crop rect; main crops the raw RGBA buffer and encodes
 * natively without spawning a Web Worker or running Chromium's convertToBlob.
 */
export interface DeliverRawRequest {
  action: DeliverAction;
  frameId: string;
  /** Crop rectangle in physical pixels of the captured frame. */
  crop: Rect;
  /** Screen-space rectangle (CSS px) the image came from, for pins in place. */
  screenRect?: Rect;
  /** Skip the floating preview. */
  quiet?: boolean;
  /** Benchmark timings collected in renderer before IPC transfer. */
  perf?: DeliverPerf;
}

export interface DeliverResult {
  ok: boolean;
  path?: string;
  url?: string;
  error?: string;
  historyId?: string;
}

export interface RawImage {
  rgba: ArrayBuffer;
  width: number;
  height: number;
}

export type EditorSource =
  | { kind: 'frame'; frameId: string; width: number; height: number }
  | { kind: 'url'; url: string };

export interface EditorInit {
  source: EditorSource;
  /** Serialised annotation document carried over from the overlay or a project. */
  doc: unknown;
  title: string;
  projectPath: string | null;
  historyId: string | null;
  settings: Settings;
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  width: number;
  height: number;
  kind: 'image' | 'video' | 'gif';
  /** Absolute path of the saved file if the user saved it somewhere. */
  savedPath: string | null;
  /** When the image was last replaced by an edit (its id stays the same). */
  updatedAt?: number;
}

export interface FloatingItem {
  id: string;
  historyId: string;
  width: number;
  height: number;
  createdAt: number;
}

export type ItemAction =
  | 'copy'
  | 'save'
  | 'saveAs'
  | 'pin'
  | 'edit'
  | 'delete'
  | 'reveal'
  | 'drag'
  | 'upload'
  | 'ocr';

export interface PinInit {
  src: string;
  width: number;
  height: number;
  historyId: string;
}

/** The audio a recording takes, as chosen on the record bar. */
export interface RecordAudio {
  microphone: boolean;
  systemAudio: boolean;
}

export interface RecordRequest {
  /** Region in CSS px relative to the sender overlay's display. */
  rect: Rect;
  gif: boolean;
  audio?: RecordAudio;
}

export interface RecorderInit {
  displayId: number;
  /** Physical pixel size of the whole display, to scale the crop to the stream's size. */
  displaySize: Size;
  /** Crop region in physical pixels of the captured display stream. */
  crop: Rect;
  scaleFactor: number;
  fps: number;
  quality: RecordingQuality;
  microphone: boolean;
  /** Computer audio, from the display stream (Windows loopback). */
  systemAudio: boolean;
  gif: boolean;
}

export interface RecorderStatus {
  state: 'starting' | 'recording' | 'paused' | 'finishing' | 'done' | 'error';
  elapsedMs: number;
  bytes: number;
  error?: string;
}

export interface ScrollInit {
  displayId: number;
  displaySize: Size;
  crop: Rect;
  scaleFactor: number;
  maxHeight: number;
  beautify: AutoBeautify;
}

export interface OcrResult {
  text: string;
  confidence: number;
  qr: string[];
}

export interface HotkeyFailure {
  action: HotkeyAction;
  accelerator: string;
  /** Set when another action in settings already uses this accelerator. */
  conflictWith?: HotkeyAction;
}

export interface HotkeyReport {
  registered: HotkeyAction[];
  /** Submitted to the Wayland GlobalShortcuts portal; binding confirmation is unavailable. */
  unconfirmed: HotkeyAction[];
  failed: HotkeyFailure[];
}

/** Version details shown in Settings ▸ About. */
export interface AppInfo {
  version: string;
  electron: string;
  chromium: string;
  node: string;
  v8: string;
  os: string;
  /** How anyshot was installed: Windows installer, AppImage, Debian package, development build. */
  install: string;
  /** False when run from source; its version then has no release. */
  packaged: boolean;
}

export interface Metrics {
  processes: { type: string; pid: number; cpu: number; memoryKB: number }[];
  mainHeapMB: number;
}

type Req<T> = { req: T };
type Res<T> = { res: T };
type Channel<Q, R> = Req<Q> & Res<R>;

export interface InvokeContract {
  'settings:get': Channel<void, Settings>;
  'settings:patch': Channel<DeepPartial<Settings>, Settings>;
  'settings:remember-tools': Channel<Partial<ToolChoices>, void>;
  'window:close': Channel<void, void>;
  'window:set-size': Channel<Size, void>;
  'clipboard:text': Channel<string, void>;
  'shell:open-url': Channel<string, void>;
  'app:info': Channel<void, AppInfo>;

  'overlay:init': Channel<void, OverlayInit>;
  'overlay:painted': Channel<OverlayPaintedPerf | undefined, void>;
  'overlay:selection-start': Channel<void, void>;
  'overlay:cancel': Channel<void, void>;
  'overlay:hide': Channel<void, void>;
  'frame:release': Channel<string, void>;

  'capture:deliver': Channel<DeliverRequest, DeliverResult>;
  'capture:deliver-raw': Channel<DeliverRawRequest, DeliverResult>;
  'capture:to-editor': Channel<{ image: RawImage; doc: unknown }, void>;
  'capture:record': Channel<RecordRequest, void>;
  'capture:scroll': Channel<RecordRequest, void>;
  'capture:remember-area': Channel<{ rect: Rect }, void>;

  'editor:init': Channel<void, EditorInit>;
  'editor:open': Channel<void, boolean>;
  'editor:save-project': Channel<{ bytes: ArrayBuffer; saveAs: boolean }, string | null>;
  'editor:set-title': Channel<{ title: string; dirty: boolean }, void>;
  /** The content size the toolbars need; main makes it the window's minimum. */
  'editor:min-size': Channel<{ width: number; height: number }, void>;

  'history:list': Channel<void, HistoryEntry[]>;
  'history:clear': Channel<void, void>;
  'item:action': Channel<{ historyId: string; action: ItemAction }, DeliverResult>;

  'floating:dismiss': Channel<string, void>;
  'floating:ready': Channel<void, { items: FloatingItem[]; dismissSeconds: number }>;

  'pin:init': Channel<void, PinInit>;
  'pin:move-by': Channel<{ dx: number; dy: number }, void>;
  'pin:ready': Channel<void, void>;

  'recorder:init': Channel<void, RecorderInit>;
  'recorder:open-file': Channel<{ ext: 'mp4' | 'webm' | 'gif' }, string>;
  'recorder:write': Channel<{ path: string; data: Uint8Array; position: number }, void>;
  'recorder:close-file': Channel<{ path: string }, void>;
  'recorder:status': Channel<RecorderStatus, void>;
  'recorder:finish': Channel<{ ok: boolean; error?: string }, void>;
  'recorder:control': Channel<'stop' | 'pause' | 'resume', void>;

  'scroll:init': Channel<void, ScrollInit>;
  'scroll:finish': Channel<
    { image: EncodedImage | null; thumb?: ArrayBuffer; edit?: EditableSource },
    void
  >;
  /** The mouse pointer in physical pixels relative to the crop (screen captures draw it in). */
  'scroll:pointer': Channel<void, Point | null>;

  'ocr:init': Channel<void, OcrResult>;

  'update:init': Channel<void, { offer: UpdateOffer; status: UpdateStatus }>;
  /** Downloads the offered update, then quits, installs it and restarts. */
  'update:install': Channel<void, void>;
  /** Checks for a newer release now; one found also opens the update window. */
  'update:check': Channel<void, UpdateCheckResult>;

  'secrets:status': Channel<
    void,
    { available: boolean; backend: string; keys: string[]; weakOptIn: boolean }
  >;
  'secrets:set': Channel<{ key: string; value: string }, void>;
  'uploads:test': Channel<void, DeliverResult>;
  'settings:choose-dir': Channel<'output' | 'recording', string | null>;
  'backgrounds:list': Channel<void, SavedBackground[]>;
  'backgrounds:save': Channel<
    { id?: string; name: string; background: CustomBackground },
    SavedBackground
  >;
  'backgrounds:remove': Channel<string, void>;
  'settings:set-tool-enabled': Channel<{ tool: ToolId; enabled: boolean }, void>;
  'hotkeys:status': Channel<void, HotkeyReport>;
}

export type InvokeChannel = keyof InvokeContract;
export type InvokeReq<K extends InvokeChannel> = InvokeContract[K]['req'];
export type InvokeRes<K extends InvokeChannel> = InvokeContract[K]['res'];
export type InvokeArgs<K extends InvokeChannel> = InvokeReq<K> extends void ? [] : [InvokeReq<K>];

const ALL: readonly WindowKind[] = [
  'overlay',
  'editor',
  'floating',
  'pin',
  'history',
  'settings',
  'recorder',
  'scroll',
  'ocr',
  'update',
];

/** Which window kinds may call each channel. Main enforces this per call. */
export const INVOKE_ACCESS: { readonly [K in InvokeChannel]: readonly WindowKind[] } = {
  'settings:get': ALL,
  'settings:patch': ['settings', 'overlay', 'editor'],
  'settings:remember-tools': ['overlay', 'editor'],
  'window:close': ALL,
  'window:set-size': ['floating', 'pin'],
  'clipboard:text': ['ocr', 'editor', 'overlay', 'settings'],
  'shell:open-url': ['ocr', 'settings', 'floating', 'update'],
  'app:info': ['settings'],

  'overlay:init': ['overlay'],
  'overlay:painted': ['overlay'],
  'overlay:selection-start': ['overlay'],
  'overlay:cancel': ['overlay'],
  'overlay:hide': ['overlay'],
  'frame:release': ['overlay', 'editor'],

  'capture:deliver': ['overlay', 'editor', 'scroll'],
  'capture:deliver-raw': ['overlay'],
  'capture:to-editor': ['overlay'],
  'capture:record': ['overlay'],
  'capture:scroll': ['overlay'],
  'capture:remember-area': ['overlay'],

  'editor:init': ['editor'],
  'editor:open': ['editor'],
  'editor:save-project': ['editor'],
  'editor:set-title': ['editor'],
  'editor:min-size': ['editor'],

  'history:list': ['history'],
  'history:clear': ['history'],
  'item:action': ['history', 'floating', 'pin'],

  'floating:dismiss': ['floating'],
  'floating:ready': ['floating'],

  'pin:init': ['pin'],
  'pin:move-by': ['pin'],
  'pin:ready': ['pin'],

  'recorder:init': ['recorder'],
  'recorder:open-file': ['recorder'],
  'recorder:write': ['recorder'],
  'recorder:close-file': ['recorder'],
  'recorder:status': ['recorder'],
  'recorder:finish': ['recorder'],
  'recorder:control': ['recorder'],

  'scroll:init': ['scroll'],
  'scroll:finish': ['scroll'],
  'scroll:pointer': ['scroll'],

  'ocr:init': ['ocr'],

  'update:init': ['update'],
  'update:install': ['update'],
  'update:check': ['settings'],

  'secrets:status': ['settings'],
  'secrets:set': ['settings'],
  'uploads:test': ['settings'],
  'settings:choose-dir': ['settings'],
  'backgrounds:list': ['settings', 'overlay', 'editor'],
  'backgrounds:save': ['settings', 'overlay', 'editor'],
  'backgrounds:remove': ['settings', 'overlay', 'editor'],
  'settings:set-tool-enabled': ['settings'],
  'hotkeys:status': ['settings'],
};

/** Events pushed from main to windows. */
export interface EventContract {
  'backgrounds:changed': undefined;
  'settings:changed': Settings;
  'hotkeys:changed': HotkeyReport;
  'overlay:clear-selection': undefined;
  'overlay:reset': OverlayInit;
  'overlay:standby': undefined;
  'floating:items': FloatingItem[];
  'history:changed': undefined;
  'recorder:command': 'stop' | 'pause' | 'resume' | 'toggle';
  'recorder:status': RecorderStatus;
  'scroll:command': 'stop' | 'cancel' | 'copy';
  'update:status': UpdateStatus;
}
export type EventChannel = keyof EventContract;

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'backgrounds:changed',
  'settings:changed',
  'hotkeys:changed',
  'overlay:clear-selection',
  'overlay:reset',
  'overlay:standby',
  'floating:items',
  'history:changed',
  'recorder:command',
  'recorder:status',
  'scroll:command',
  'update:status',
];

/** The API the preload exposes on `window.anyshot`. */
export interface AnyshotApi {
  kind: WindowKind;
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeRes<K>>;
  on<K extends EventChannel>(channel: K, listener: (payload: EventContract[K]) => void): () => void;
}
