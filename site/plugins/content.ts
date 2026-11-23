/*
  The words search engines and AI agents read about anyshot: the feature list and the
  FAQ. One source for the page (rendered into the HTML at build time, so crawlers that
  don't run JavaScript see it), the JSON-LD, llms.txt, llms-full.txt and index.md.
  Keep every claim true to the app and the README.
*/

export const SITE = 'https://anyshot.xyz/';
export const REPO_URL = 'https://github.com/mgamergo/anyshot';
export const NAME = 'anyshot';
export const DESCRIPTION =
  'anyshot is a free, open-source (MIT) screenshot, annotation and screen-recording app for Windows and Linux. Capture an area, mark it up with arrows, text, blur and numbered steps, record MP4 or GIF, copy text with offline OCR, and pin or share it in one keystroke.';

export const FEATURES: [string, string][] = [
  [
    'Capture anything',
    'An area, a whole screen, the last area again, or just the text in it. Works across multiple monitors at full resolution, with an optional countdown.',
  ],
  [
    'Annotate in place',
    'Pencil, lines, arrows, shapes, highlighter, text, numbered badges, stamps, spotlight, magnifier, measuring and a colour picker, with full undo and redo.',
  ],
  [
    'Hide what matters',
    "Pixelate, blur or black out passwords, emails and anything else you don't want to share.",
  ],
  [
    'Make it look good',
    'Beautify wraps a capture in a gradient background with padding, rounded corners and a soft shadow.',
  ],
  [
    'Share it your way',
    'Copy, save as PNG, JPEG or WebP, pin it on screen, drag it into another app, or upload to your own server or S3-compatible storage.',
  ],
  [
    'Record your screen',
    'Save an area as MP4 or GIF, with your microphone (and system audio on Windows).',
  ],
  ['Scrolling capture', 'Scroll through a long page and get one stitched image.'],
  ['Read text from images', 'Offline OCR copies the text out of any capture.'],
  [
    'History and editor',
    'Everything you capture is a keystroke away, and annotations stay editable.',
  ],
  [
    'Stays out of the way',
    'No windows and next to no resources while idle. Every shortcut and option is yours to change.',
  ],
];

export const SHORTCUTS: [string, string][] = [
  ['Capture area', 'Alt+Shift+X'],
  ['Capture screen', 'Alt+Shift+F'],
  ['Capture text (OCR)', 'Alt+Shift+T'],
  ['Record area (again to stop)', 'Alt+Shift+R'],
  ['History', 'Alt+Shift+H'],
];

export const FAQ: [string, string][] = [
  [
    'Is anyshot free?',
    'Yes. anyshot is free and open source under the MIT licence. There is no paid tier, account, telemetry or tracking.',
  ],
  [
    'Which operating systems does anyshot support?',
    'Windows 10 and 11 (x64 and ARM64) and Linux (a .deb package for Debian and Ubuntu, and an AppImage for other distributions).',
  ],
  [
    'Is anyshot a Snipping Tool alternative?',
    'Yes. Like the Windows Snipping Tool it captures an area or a whole screen on a shortcut, and it adds in-place annotation, blur and pixelate, numbered steps, pinning, scrolling capture, offline OCR and MP4 or GIF recording.',
  ],
  [
    'How does anyshot compare to ShareX, Greenshot and Flameshot?',
    'anyshot focuses on a fast capture-annotate-copy flow with a polished editor and Beautify frames, on both Windows and Linux. ShareX is Windows-only and leans towards automation and many upload services; Greenshot is Windows-only and simpler; Flameshot is a long-standing cross-platform tool. anyshot is newer and smaller than all three.',
  ],
  [
    'Is there a CleanShot X or macshot alternative for Windows and Linux?',
    'anyshot takes its inspiration and feature ideas from macshot, the open-source macOS screenshot app, and brings that workflow to Windows and Linux. It is written from scratch and contains no macshot code.',
  ],
  [
    'Can anyshot record my screen?',
    'Yes. Press Alt+Shift+R, select an area and anyshot records it to MP4 or GIF, with your microphone and, on Windows, system audio.',
  ],
  [
    'Does anyshot work offline?',
    'Yes. Capture, annotation, recording and OCR all run on your machine. The only network request it makes on its own is an optional update check against GitHub, which you can turn off.',
  ],
];

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
