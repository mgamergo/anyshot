import zlib from 'node:zlib';
import { nativeImage } from 'electron';
import type { Rect } from '../../shared/geometry';
import type { EncodedImage } from '../../shared/ipc';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND_CRC = 0xae426082;

let crcTable: Uint32Array | undefined;

function fallbackCrc32(data: Uint8Array, initial = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }
  let c = (initial ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    const entry = crcTable[(c ^ byte) & 0xff] ?? 0;
    c = (entry ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const nativeCrc32 = (zlib as typeof zlib & { crc32?: (d: Uint8Array, v?: number) => number }).crc32;

function crc32(data: Uint8Array, initial?: number): number {
  if (typeof nativeCrc32 === 'function') {
    return (initial !== undefined ? nativeCrc32(data, initial) : nativeCrc32(data)) >>> 0;
  }
  return fallbackCrc32(data, initial);
}

function toBufferView(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Converts a Node `Buffer` to a standalone `ArrayBuffer` without copying when
 * the Buffer already owns its entire backing `ArrayBuffer`.
 */
export function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  if (
    buf.byteOffset === 0 &&
    buf.byteLength === buf.buffer.byteLength &&
    buf.buffer instanceof ArrayBuffer
  ) {
    return buf.buffer;
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Crops an RGBA pixel buffer to `rect`, clamping safely to `[0, srcWidth] × [0, srcHeight]`
 * with a minimum 1×1 region. Avoids copying on full-frame or full-width contiguous crops.
 */
export function cropRgba(
  rgba: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  rect: Rect,
): { rgba: Buffer; width: number; height: number } {
  const wSrc = Math.max(1, Math.floor(srcWidth));
  const hSrc = Math.max(1, Math.floor(srcHeight));
  const srcStride = wSrc * 4;
  const required = hSrc * srcStride;
  if (rgba.byteLength < required) {
    throw new RangeError(`RGBA buffer too small: got ${rgba.byteLength}, need ${required}`);
  }

  const rx = Number.isFinite(rect.x) ? Math.round(rect.x) : 0;
  const ry = Number.isFinite(rect.y) ? Math.round(rect.y) : 0;
  const rw = Number.isFinite(rect.width) ? Math.round(rect.width) : 0;
  const rh = Number.isFinite(rect.height) ? Math.round(rect.height) : 0;

  const x1 = Math.max(0, Math.min(wSrc - 1, rx));
  const y1 = Math.max(0, Math.min(hSrc - 1, ry));
  const x2 = Math.max(x1 + 1, Math.min(wSrc, rx + rw));
  const y2 = Math.max(y1 + 1, Math.min(hSrc, ry + rh));

  const width = x2 - x1;
  const height = y2 - y1;
  const src = toBufferView(rgba);

  if (x1 === 0 && width === wSrc) {
    const start = y1 * srcStride;
    const len = height * srcStride;
    const view = start === 0 && src.byteLength === len ? src : src.subarray(start, start + len);
    return { rgba: view, width, height };
  }

  const dstStride = width * 4;
  const dst = Buffer.allocUnsafe(height * dstStride);
  let srcOffset = y1 * srcStride + x1 * 4;
  let dstOffset = 0;
  for (let row = 0; row < height; row++) {
    src.copy(dst, dstOffset, srcOffset, srcOffset + dstStride);
    srcOffset += srcStride;
    dstOffset += dstStride;
  }
  return { rgba: dst, width, height };
}

/**
 * Encodes raw 32-bit RGBA pixels into a standard-compliant PNG (bit depth 8,
 * color type 6) using fast zlib level 1 compression and native CRC32.
 */
export function encodeFastPng(rgba: Uint8Array, width: number, height: number): Buffer {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w < 1 || h < 1) throw new RangeError(`Invalid PNG dimensions: ${width}x${height}`);
  const stride = w * 4;
  const required = h * stride;
  if (rgba.byteLength < required) {
    throw new RangeError(`RGBA buffer too small: got ${rgba.byteLength}, need ${required}`);
  }

  const scanlineSize = 1 + stride;
  const raw = Buffer.allocUnsafe(h * scanlineSize);
  const src = toBufferView(rgba);
  let srcOffset = 0;
  let dstOffset = 0;
  for (let y = 0; y < h; y++) {
    raw[dstOffset] = 0;
    src.copy(raw, dstOffset + 1, srcOffset, srcOffset + stride);
    srcOffset += stride;
    dstOffset += scanlineSize;
  }

  const compressed = zlib.deflateSync(raw, { level: 1 });
  const idatOffset = 33;
  const iendOffset = idatOffset + 12 + compressed.length;
  const out = Buffer.allocUnsafe(iendOffset + 12);

  // PNG signature (8 bytes)
  PNG_SIGNATURE.copy(out, 0);

  // IHDR chunk (25 bytes at offset 8)
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(w, 16);
  out.writeUInt32BE(h, 20);
  out[24] = 8; // bit depth
  out[25] = 6; // color type: RGBA
  out[26] = 0; // compression method
  out[27] = 0; // filter method
  out[28] = 0; // interlace method
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);

  // IDAT chunk
  out.writeUInt32BE(compressed.length, idatOffset);
  out.write('IDAT', idatOffset + 4, 'ascii');
  compressed.copy(out, idatOffset + 8);
  out.writeUInt32BE(crc32(out.subarray(idatOffset + 4, iendOffset - 4)), iendOffset - 4);

  // IEND chunk (12 bytes)
  out.writeUInt32BE(0, iendOffset);
  out.write('IEND', iendOffset + 4, 'ascii');
  out.writeUInt32BE(IEND_CRC, iendOffset + 8);

  return out;
}

/**
 * Encodes an image in the configured save format. Reuses `pngBuf` for PNG,
 * uses Electron's native JPEG encoder for JPEG, and falls back to PNG for WebP
 * since `nativeImage` has no built-in WebP encoder.
 */
export function encodeSaveFormat(
  _rgba: Uint8Array,
  _width: number,
  _height: number,
  pngBuf: Buffer,
  format: 'png' | 'jpeg' | 'webp',
  quality: number,
): { bytes: Buffer; mime: EncodedImage['mime'] } {
  if (format === 'jpeg' && typeof nativeImage?.createFromBuffer === 'function') {
    const img = nativeImage.createFromBuffer(pngBuf);
    if (!img.isEmpty()) {
      const normalized = quality <= 1 ? quality * 100 : quality;
      const q = Math.max(1, Math.min(100, Math.round(normalized)));
      return { bytes: img.toJPEG(q), mime: 'image/jpeg' };
    }
  }
  return { bytes: pngBuf, mime: 'image/png' };
}

/**
 * Generates a small JPEG thumbnail from an encoded PNG buffer using Electron's
 * native image decoder and resizer.
 */
export function encodeFastThumbnail(pngBuf: Buffer, maxSize = 480): Buffer | undefined {
  if (typeof nativeImage?.createFromBuffer !== 'function') return undefined;
  const img = nativeImage.createFromBuffer(pngBuf);
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  if (width <= 0 || height <= 0) return undefined;
  const maxSide = Math.max(1, Math.round(maxSize));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));
  const resized =
    targetW < width || targetH < height
      ? img.resize({ width: targetW, height: targetH, quality: 'good' })
      : img;
  return resized.toJPEG(82);
}
