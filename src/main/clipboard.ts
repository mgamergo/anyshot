import { ClipboardItem, clipboard } from 'electron';
import { type PerfMetrics, roundMs } from '../shared/perf';

// Electron 45 replaced the synchronous clipboard with an async, W3C-style API.

export async function copyPng(png: Uint8Array, perf?: PerfMetrics): Promise<void> {
  const t0 = performance.now();
  try {
    const blob = new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } finally {
    if (perf) perf.clipboard_copy = roundMs(performance.now() - t0);
  }
}

export async function copyText(text: string): Promise<void> {
  await clipboard.writeText(text);
}

/** The clipboard's image as PNG bytes, or null if it holds no image. */
export async function readPng(): Promise<Uint8Array | null> {
  for (const item of await clipboard.read()) {
    if (item.types.includes('image/png')) {
      const blob = await item.getType('image/png');
      if (blob instanceof Blob) return new Uint8Array(await blob.arrayBuffer());
    }
  }
  return null;
}

export async function readText(): Promise<string> {
  return clipboard.readText();
}
