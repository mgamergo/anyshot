import { type AutoBeautify, autoBeautifyApplies, type Background } from '../shared/background';
import type { Point, Rect } from '../shared/geometry';
import type { TextFont } from '../shared/settings';

export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type FillMode = 'stroke' | 'fill' | 'both';
export type CensorMode = 'pixelate' | 'blur' | 'solid';

export interface Stroke {
  color: string;
  /** Width in image pixels. */
  width: number;
  style: LineStyle;
}

interface Base {
  id: string;
}

export interface PathAnnotation extends Base {
  kind: 'pencil' | 'marker';
  points: Point[];
  stroke: Stroke;
}

export interface SegmentAnnotation extends Base {
  kind: 'line' | 'arrow' | 'measure';
  a: Point;
  b: Point;
  stroke: Stroke;
}

export interface BoxAnnotation extends Base {
  kind: 'rect' | 'ellipse';
  rect: Rect;
  stroke: Stroke;
  fill: FillMode;
  radius: number;
}

export interface TextStyle {
  font: TextFont;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** A contrasting outline around the letters (not drawn on a background box). */
  outline: boolean;
}

/** How text looked before it had styles; also what older documents get. */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'sans',
  bold: true,
  italic: false,
  underline: false,
  outline: true,
};

export interface TextAnnotation extends Base {
  kind: 'text';
  at: Point;
  text: string;
  size: number;
  color: string;
  background: boolean;
  style: TextStyle;
}

export interface NumberAnnotation extends Base {
  kind: 'number';
  at: Point;
  value: number;
  size: number;
  color: string;
}

export interface CensorAnnotation extends Base {
  kind: 'censor';
  rect: Rect;
  mode: CensorMode;
}

export interface SpotlightAnnotation extends Base {
  kind: 'spotlight';
  rect: Rect;
  /** 0–1 darkness outside the spotlight. */
  dim: number;
}

export interface MagnifyAnnotation extends Base {
  kind: 'magnify';
  at: Point;
  radius: number;
  zoom: number;
  color: string;
}

export interface StampAnnotation extends Base {
  kind: 'stamp';
  at: Point;
  emoji: string;
  size: number;
}

export type Annotation =
  | PathAnnotation
  | SegmentAnnotation
  | BoxAnnotation
  | TextAnnotation
  | NumberAnnotation
  | CensorAnnotation
  | SpotlightAnnotation
  | MagnifyAnnotation
  | StampAnnotation;

export type AnnotationKind = Annotation['kind'];

export interface Adjust {
  brightness: number; // -0.5..0.5
  contrast: number; // 0.5..2
  saturation: number; // 0..2
  sharpness: number; // 0..2
}

export interface Beautify {
  enabled: boolean;
  padding: number;
  radius: number;
  shadow: number;
  background: Background;
}

export interface Effects {
  invert: boolean;
  adjust: Adjust;
  beautify: Beautify;
}

export interface Doc {
  version: 1;
  /** Image pixels per CSS pixel when the doc was created (display scale). */
  unit: number;
  annotations: Annotation[];
  effects: Effects;
  /** Editor crop, in image pixels; null means the whole image. */
  crop: Rect | null;
}

export const NEUTRAL_ADJUST: Adjust = { brightness: 0, contrast: 1, saturation: 1, sharpness: 0 };

export const DEFAULT_EFFECTS: Effects = {
  invert: false,
  adjust: NEUTRAL_ADJUST,
  beautify: { enabled: false, padding: 48, radius: 12, shadow: 40, background: 0 },
};

export function emptyDoc(unit = 1): Doc {
  return { version: 1, unit, annotations: [], effects: DEFAULT_EFFECTS, crop: null };
}

/** New screenshots start with the saved frame sizes, and the saved background when it applies. */
export function screenshotDoc(unit: number, defaults: AutoBeautify, mode: string): Doc {
  const doc = emptyDoc(unit);
  const base = DEFAULT_EFFECTS.beautify;
  const auto = autoBeautifyApplies(defaults, mode);
  const { padding, radius, shadow } = defaults;
  if (!auto && padding === base.padding && radius === base.radius && shadow === base.shadow) {
    return doc;
  }
  return {
    ...doc,
    effects: {
      ...doc.effects,
      beautify: {
        ...base,
        padding,
        radius,
        shadow,
        ...(auto && { enabled: true, background: defaults.background }),
      },
    },
  };
}

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function isAdjustNeutral(a: Adjust): boolean {
  return a.brightness === 0 && a.contrast === 1 && a.saturation === 1 && a.sharpness === 0;
}
