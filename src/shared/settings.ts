import { autoBeautifySchema } from './background';
import { recordingQuality } from './recording-quality';
import { bool, type Infer, int, list, num, obj, oneOf, pattern, str } from './schema';

const MODIFIER = '(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Shift|Super|Meta)';
const KEY =
  "(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|PrintScreen|Plus|Minus|=|,|\\.|/|;|'|\\[|\\]|\\\\|`)";
/** An Electron accelerator such as `Alt+Shift+X`, or empty for "no shortcut". */
export const ACCELERATOR = new RegExp(`^(?:(?:${MODIFIER}\\+)*${KEY})?$`);
const accel = (def: string) => pattern(def, ACCELERATOR);
const color = (def: string) => pattern(def, /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const HOTKEY_ACTIONS = [
  'captureArea',
  'captureScreen',
  'captureOcr',
  'quickCapture',
  'captureLastArea',
  'scrollCapture',
  'recordArea',
  'recordGif',
  'history',
  'pinClipboard',
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  captureArea: 'Capture area',
  captureScreen: 'Capture screen',
  captureOcr: 'Capture text (OCR)',
  quickCapture: 'Quick capture',
  captureLastArea: 'Capture last area',
  scrollCapture: 'Scroll capture',
  recordArea: 'Record area (again to stop)',
  recordGif: 'Record GIF',
  history: 'History',
  pinClipboard: 'Pin from clipboard',
};

/** Font families for the text tool, each mapped to fonts Windows and Linux ship. */
export const TEXT_FONTS = ['sans', 'serif', 'mono', 'hand'] as const;
export type TextFont = (typeof TEXT_FONTS)[number];

export const TOOL_IDS = [
  'select',
  'pencil',
  'line',
  'arrow',
  'rect',
  'ellipse',
  'marker',
  'text',
  'number',
  'censor',
  'spotlight',
  'magnify',
  'stamp',
  'picker',
  'measure',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const DEFAULT_COLORS = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#00c7be',
  '#007aff',
  '#5856d6',
  '#af52de',
  '#ff2d55',
  '#ffffff',
  '#8e8e93',
  '#000000',
];

export const settingsSchema = obj({
  version: int(1, 1, 1),
  general: obj({
    launchAtLogin: bool(false),
    toolbarTheme: oneOf(['dark', 'light', 'system'], 'dark'),
    accent: color('#14b8a6'),
    /** Look for a newer release on GitHub at startup (packaged builds only). */
    checkForUpdates: bool(true),
  }),
  capture: obj({
    quickAction: oneOf(['copy', 'save', 'copy+save', 'save+copyPath', 'none'], 'copy'),
    openEditorAfterQuick: bool(false),
    /** Show the edit tools on the selection instead of capturing it at once. */
    instantPreview: bool(false),
    beautify: autoBeautifySchema,
    doubleClickToCopy: bool(true),
    hideInstructions: bool(false),
    dimOutside: bool(true),
    rememberLastTool: bool(true),
    instantCapture: bool(true),
    delaySeconds: int(0, 0, 30),
    showThumbnail: bool(true),
    thumbnailDismissSeconds: int(5, 0, 60),
    thumbnailCorner: oneOf(
      ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
      'bottom-right',
    ),
    thumbnailStacking: oneOf(['stack', 'replace'], 'stack'),
    pinPlacement: oneOf(['center', 'original'], 'original'),
    ocrAction: oneOf(['window+copy', 'window', 'copy'], 'window+copy'),
  }),
  output: obj({
    saveAction: oneOf(['default-folder', 'ask'], 'default-folder'),
    saveDir: str(''),
    copyPathAfterSave: bool(false),
    filenameTemplate: str('anyshot {date} at {time}', 200),
    imageFormat: oneOf(['png', 'jpeg', 'webp'], 'png'),
    imageQuality: int(85, 10, 100),
    historySize: int(30, 0, 1000),
  }),
  hotkeys: obj({
    captureArea: accel('Alt+Shift+X'),
    captureScreen: accel('Alt+Shift+F'),
    captureOcr: accel('Alt+Shift+T'),
    quickCapture: accel(''),
    captureLastArea: accel(''),
    scrollCapture: accel(''),
    recordArea: accel('Alt+Shift+R'),
    recordGif: accel(''),
    history: accel('Alt+Shift+H'),
    pinClipboard: accel(''),
  }),
  tools: obj({
    lastTool: oneOf(TOOL_IDS, 'arrow'),
    color: color('#ff3b30'),
    strokeWidth: int(4, 1, 30),
    fill: oneOf(['stroke', 'fill', 'both'], 'stroke'),
    lineStyle: oneOf(['solid', 'dashed', 'dotted'], 'solid'),
    textSize: int(28, 8, 200),
    textFont: oneOf(TEXT_FONTS, 'sans'),
    textBold: bool(true),
    textItalic: bool(false),
    textUnderline: bool(false),
    /** An outline around the letters keeps text readable on busy backgrounds. */
    textOutline: bool(true),
    censorMode: oneOf(['pixelate', 'blur', 'solid'], 'pixelate'),
    spotlightDim: int(55, 10, 95),
    magnifyZoom: num(2, 1.1, 6),
    stampSize: int(48, 16, 256),
    stamp: str('👆', 16),
    presetColors: list(color('#ff3b30'), DEFAULT_COLORS, 24),
    enabledTools: list(oneOf(TOOL_IDS, 'select'), [...TOOL_IDS], TOOL_IDS.length),
  }),
  editor: obj({
    /** What Save does for a capture that has a history entry (the last choice). */
    saveMode: oneOf(['replace', 'copy'], 'replace'),
  }),
  recording: obj({
    fps: int(30, 5, 60),
    quality: recordingQuality(),
    microphone: bool(false),
    /** Computer (system) audio. Windows only: Electron provides it as loopback there. */
    systemAudio: bool(false),
    saveDir: str(''),
    filenameTemplate: str('anyshot recording {date} at {time}', 200),
    whenDone: oneOf(['reveal', 'open', 'copyPath'], 'reveal'),
    showControls: bool(true),
  }),
  scroll: obj({
    maxHeight: int(30_000, 1000, 100_000),
  }),
  uploads: obj({
    provider: oneOf(['none', 'http', 's3'], 'none'),
    confirmBeforeUpload: bool(true),
    /** Linux without a keyring: allow obfuscated-only storage of credentials. */
    allowWeakSecretStorage: bool(false),
    http: obj({
      url: str(''),
      fileField: str('file', 64),
      responseUrlPath: str('data.url', 128),
    }),
    s3: obj({
      endpoint: str(''),
      region: str('auto', 64),
      bucket: str('', 128),
      publicUrlBase: str(''),
      pathPrefix: str('anyshot/{yyyy}/{MM}/', 256),
      publicRead: bool(false),
    }),
  }),
});

export type Settings = Infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = settingsSchema.def;

export function parseSettings(input: unknown): Settings {
  return settingsSchema.parse(input);
}

/** The patch behind Settings ▸ Tools ▸ Reset to defaults: everything that page shows. */
export function toolsPageDefaults(): DeepPartial<Settings> {
  return { tools: { enabledTools: [...DEFAULT_SETTINGS.tools.enabledTools] } };
}

/** A recursive partial used for settings patches sent from windows. */
export type ToolChoices = Omit<Settings['tools'], 'presetColors' | 'enabledTools'>;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
