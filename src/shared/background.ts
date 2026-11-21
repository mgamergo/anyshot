import {
  bool,
  type Field,
  type Infer,
  int,
  isRecord,
  list,
  obj,
  oneOf,
  pattern,
  str,
} from './schema';

export const GRADIENT_TYPES = ['linear', 'radial', 'conic', 'mesh'] as const;
export const PATTERNS = ['none', 'dots', 'grid', 'stripes', 'waves', 'diamonds'] as const;
export const BLENDS = ['normal', 'soft-light', 'overlay', 'multiply', 'screen'] as const;
export const IMAGE_FITS = ['cover', 'contain'] as const;
export const MAX_BACKGROUND_DATA = 1_400_000;
export const MAX_BACKGROUNDS = 32;
export const MAX_GRADIENT_COLORS = 8;

const color = (fallback: string) => pattern(fallback, /^#[\da-f]{6}$/i);
const percent = (fallback: number) => int(fallback, 0, 100);
const stop = obj({ color: color('#ffffff'), position: percent(50) });
const point = obj({ color: color('#ffffff'), x: percent(50), y: percent(50) });

const gradientSchema = obj({
  kind: oneOf(['gradient'], 'gradient'),
  type: oneOf(GRADIENT_TYPES, 'linear'),
  angle: int(135, 0, 360),
  x: percent(50),
  y: percent(50),
  stops: list(
    stop,
    [
      { color: '#5eead4', position: 0 },
      { color: '#6366f1', position: 100 },
    ],
    MAX_GRADIENT_COLORS,
  ),
  points: list(
    point,
    [
      { color: '#12345b', x: 12, y: 18 },
      { color: '#6258e9', x: 80, y: 25 },
      { color: '#2dd4bf', x: 22, y: 88 },
      { color: '#ed9cc0', x: 86, y: 90 },
    ],
    MAX_GRADIENT_COLORS,
  ),
  softness: percent(55),
  grain: percent(0),
  pattern: obj({
    type: oneOf(PATTERNS, 'none'),
    color: color('#ffffff'),
    opacity: percent(24),
    scale: int(34, 8, 100),
    angle: int(0, 0, 360),
    blend: oneOf(BLENDS, 'soft-light'),
  }),
});

const imageSchema = obj({
  kind: oneOf(['image'], 'image'),
  data: str('', MAX_BACKGROUND_DATA),
  fit: oneOf(IMAGE_FITS, 'cover'),
  x: percent(50),
  y: percent(50),
  matte: color('#16181d'),
});

export type GradientBackground = Infer<typeof gradientSchema>;
export type ImageBackground = Infer<typeof imageSchema>;
export type CustomBackground = GradientBackground | ImageBackground;
/** Numbers preserve the built-in gradient indices in existing projects. */
export type Background = number | CustomBackground;

export const DEFAULT_GRADIENT = gradientSchema.def;
export const DEFAULT_IMAGE = imageSchema.def;

export function parseCustomBackground(input: unknown): CustomBackground | null {
  if (!isRecord(input)) return null;
  if (input.kind === 'gradient') {
    const gradient = gradientSchema.parse(input);
    return {
      ...gradient,
      stops: gradient.stops.length < 2 ? DEFAULT_GRADIENT.stops : gradient.stops,
      points: gradient.points.length < 2 ? DEFAULT_GRADIENT.points : gradient.points,
    };
  }
  if (input.kind === 'image') {
    const image = imageSchema.parse(input);
    if (/^data:image\/webp;base64,UklGR[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return image;
  }
  return null;
}

export const backgroundField: Field<Background> = {
  def: 0,
  parse: (input) => parseCustomBackground(input) ?? int(0, 0, 99).parse(input),
};

export const SCREENSHOT_MODES = [
  ['area', 'Area'],
  ['last', 'Last area'],
  ['screen', 'Full screen'],
  ['scroll', 'Scrolling'],
] as const;

export const autoBeautifySchema = obj({
  enabled: bool(false),
  background: backgroundField,
  modes: obj({ area: bool(true), last: bool(true), screen: bool(true), scroll: bool(true) }),
  /** Frame for new screenshots, saved from the Beautify popover. */
  padding: int(48, 0, 200),
  radius: int(12, 0, 60),
  shadow: int(40, 0, 100),
});
export type AutoBeautify = Infer<typeof autoBeautifySchema>;

export function autoBeautifyApplies(defaults: AutoBeautify, mode: string): boolean {
  switch (mode) {
    case 'quick':
    case 'area':
      return defaults.enabled && defaults.modes.area;
    case 'last':
    case 'screen':
    case 'scroll':
      return defaults.enabled && defaults.modes[mode];
    default:
      return false;
  }
}

export interface SavedBackground {
  id: string;
  name: string;
  background: CustomBackground;
}
