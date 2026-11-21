import { describe, expect, it } from 'vitest';
import { BACKGROUNDS } from '../../src/engine/background-render';
import { beautifyBackgroundCss } from '../../src/engine/beautify';
import { DocStore, parseDoc } from '../../src/engine/document';
import { DEFAULT_EFFECTS, emptyDoc, screenshotDoc } from '../../src/engine/model';
import { DEFAULT_GRADIENT } from '../../src/shared/background';
import { parseSettings } from '../../src/shared/settings';

const b = (background: number) => ({ ...DEFAULT_EFFECTS.beautify, enabled: true, background });

describe('beautify preview background', () => {
  it('runs corner to corner like the exported canvas gradient', () => {
    // Square: straight to the bottom-right corner.
    expect(beautifyBackgroundCss(b(0), 100, 100)).toBe(
      `linear-gradient(135deg, ${BACKGROUNDS[0]?.[0]}, ${BACKGROUNDS[0]?.[1]})`,
    );
    // Wide frames tilt towards horizontal, tall ones towards vertical.
    const angle = (w: number, h: number) =>
      Number(/linear-gradient\(([\d.]+)deg/.exec(beautifyBackgroundCss(b(0), w, h))?.[1]);
    expect(angle(400, 100)).toBeCloseTo(180 - (Math.atan(4) * 180) / Math.PI, 2);
    expect(angle(100, 400)).toBeCloseTo(180 - (Math.atan(0.25) * 180) / Math.PI, 2);
  });

  it('uses the chosen background and wraps around the list', () => {
    expect(beautifyBackgroundCss(b(2), 10, 10)).toContain(BACKGROUNDS[2]?.[0]);
    expect(beautifyBackgroundCss(b(BACKGROUNDS.length + 1), 10, 10)).toContain(BACKGROUNDS[1]?.[1]);
  });
});

describe('automatic Beautify', () => {
  it('changes the inherited frame without adding an undo step or dropping redo and manual frames', () => {
    const docs = new DocStore();
    const first = docs.doc.effects.beautify;
    const area = b(1);
    const full = b(2);
    const manual = b(3);
    docs.setEffects({ ...docs.doc.effects, invert: true });
    docs.setBeautifyDefault(first, area);
    expect(docs.undo()).toBe(true);
    expect(docs.doc.effects).toMatchObject({ invert: false, beautify: area });
    expect(docs.canUndo).toBe(false);

    docs.setBeautifyDefault(area, full);
    expect(docs.redo()).toBe(true);
    expect(docs.doc.effects).toMatchObject({ invert: true, beautify: full });

    docs.setEffects({ ...docs.doc.effects, beautify: manual });
    docs.setBeautifyDefault(full, area);
    expect(docs.doc.effects.beautify).toBe(manual);
    expect(docs.undo()).toBe(true);
    expect(docs.doc.effects.beautify).toBe(area);
    expect(docs.redo()).toBe(true);
    expect(docs.doc.effects.beautify).toBe(manual);
  });

  it('keeps existing profiles opt-in and uses the configured capture modes', () => {
    const fallback = parseSettings(undefined).capture.beautify;
    expect(screenshotDoc(1, fallback, 'area')).toEqual(emptyDoc(1));
    expect(Object.values(fallback.modes)).toEqual([true, true, true, true]);
    const defaults = parseSettings({
      capture: { beautify: { enabled: true, background: 3, modes: { last: false } } },
    }).capture.beautify;
    for (const mode of ['area', 'quick', 'screen', 'scroll']) {
      expect(screenshotDoc(1, defaults, mode).effects.beautify).toMatchObject({
        enabled: true,
        background: 3,
      });
    }
    for (const mode of ['last', 'ocr', 'gif', 'record']) {
      expect(screenshotDoc(1, defaults, mode)).toEqual(emptyDoc(1));
    }
  });

  it('starts new screenshots with the saved padding, corners and shadow', () => {
    const frame = { padding: 64, radius: 20, shadow: 70 };
    const off = parseSettings({ capture: { beautify: frame } }).capture.beautify;
    expect(screenshotDoc(1, off, 'area').effects.beautify).toEqual({
      ...DEFAULT_EFFECTS.beautify,
      ...frame,
    });
    const on = parseSettings({ capture: { beautify: { ...frame, enabled: true, background: 2 } } })
      .capture.beautify;
    expect(screenshotDoc(1, on, 'screen').effects.beautify).toEqual({
      ...frame,
      enabled: true,
      background: 2,
    });
    expect(screenshotDoc(1, on, 'ocr').effects.beautify).toMatchObject({ ...frame, enabled: false });
  });

  it('round-trips custom recipes and falls back safely for invalid image data', () => {
    const background = {
      ...DEFAULT_GRADIENT,
      pattern: { ...DEFAULT_GRADIENT.pattern, type: 'waves' },
    };
    const defaults = parseSettings({ capture: { beautify: { enabled: true, background } } }).capture
      .beautify;
    const doc = screenshotDoc(1, defaults, 'area');
    expect(parseDoc(JSON.parse(JSON.stringify(doc))).effects.beautify.background).toEqual(
      background,
    );
    const invalid = parseSettings({
      capture: {
        beautify: {
          enabled: true,
          background: { kind: 'image', data: 'https://example.com/background.png' },
        },
      },
    });
    expect(invalid.capture.beautify.background).toBe(0);
  });
});
