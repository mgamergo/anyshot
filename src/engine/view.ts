import {
  clampAlong,
  clampPoint,
  distance,
  type Point,
  type Rect,
  rectFromPoints,
  snap45,
  squareFrom,
} from '../shared/geometry';
import { roundMs } from '../shared/perf';
import type { TextFont, ToolId } from '../shared/settings';
import type { DocStore } from './document';
import { adjustFilter, GlEffects } from './gl';
import {
  type Annotation,
  type CensorMode,
  type Effects,
  type FillMode,
  isAdjustNeutral,
  type LineStyle,
  newId,
  type Stroke,
  type TextAnnotation,
  type TextStyle,
} from './model';
import {
  type Ctx,
  censorFallback,
  drawAnnotation,
  drawAnnotations,
  type RenderEnv,
  textOutline,
} from './render';
import {
  bounds,
  canvasTextMeasurer,
  dragHandle,
  type HandleId,
  handles,
  setTextMeasurer,
  textFont,
  topmostAt,
  translate,
  TEXT_LINE_HEIGHT,
} from './shapes';

export interface ToolOptions {
  tool: ToolId;
  color: string;
  strokeWidth: number;
  fill: FillMode;
  lineStyle: LineStyle;
  textSize: number;
  textFont: TextFont;
  textBold: boolean;
  textItalic: boolean;
  textUnderline: boolean;
  textOutline: boolean;
  censorMode: CensorMode;
  /** 10–95 percent. */
  spotlightDim: number;
  magnifyZoom: number;
  stampSize: number;
  stamp: string;
}

/** Tool options that restyle existing annotations (the selection, an open text box). */
export type StylePatch = Partial<
  Pick<
    ToolOptions,
    | 'color'
    | 'strokeWidth'
    | 'lineStyle'
    | 'fill'
    | 'textSize'
    | 'textFont'
    | 'textBold'
    | 'textItalic'
    | 'textUnderline'
    | 'textOutline'
  >
>;

export const STYLE_KEYS: readonly (keyof StylePatch)[] = [
  'color',
  'strokeWidth',
  'lineStyle',
  'fill',
  'textSize',
  'textFont',
  'textBold',
  'textItalic',
  'textUnderline',
  'textOutline',
];

/** The text style the tool options describe. */
export function textStyleOf(
  o: Pick<ToolOptions, 'textFont' | 'textBold' | 'textItalic' | 'textUnderline' | 'textOutline'>,
): TextStyle {
  return {
    font: o.textFont,
    bold: o.textBold,
    italic: o.textItalic,
    underline: o.textUnderline,
    outline: o.textOutline,
  };
}

export interface ViewEvents {
  /** The colour picker tool sampled a pixel. */
  onPickColor?(hex: string, copy: boolean): void;
  /** Coarse state changed: selection, undo availability. */
  onStateChange?(): void;
}

type Interaction =
  | { type: 'idle' }
  | { type: 'draw'; start: Point; draft: Annotation }
  | { type: 'move'; start: Point; originals: Annotation[]; delta: Point }
  | { type: 'handle'; original: Annotation; handle: HandleId; current: Annotation };

const HANDLE_RADIUS_CSS = 6;

/**
 * The annotation surface: three stacked canvases (static image, committed
 * annotations, interaction) driven by pointer input. Plain TypeScript; the UI
 * framework only talks to it through methods and coarse callbacks.
 */
export class CanvasView {
  readonly base: HTMLCanvasElement;
  readonly committed: HTMLCanvasElement;
  readonly interaction: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly committedCtx: CanvasRenderingContext2D;
  private readonly interactionCtx: CanvasRenderingContext2D;
  private source: ImageBitmap | null = null;
  private state: Interaction = { type: 'idle' };
  private dirty = { base: false, committed: false, interaction: false };
  private frame = 0;
  private skip = new Set<string>();
  private marksEnv: RenderEnv | null = null;
  private textEditor: HTMLTextAreaElement | null = null;
  private area: Rect | null = null;
  private gl: GlEffects | null | undefined = undefined;
  private committedAllocated = false;
  private interactionAllocated = false;
  private readonly unsubscribe: () => void;
  readonly initPerf: { gl_create: number; canvas_view_init: number };
  paintPerf: { paint_base: number; paint_committed: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private width: number,
    private height: number,
    readonly store: DocStore,
    private readonly options: () => ToolOptions,
    private readonly events: ViewEvents = {},
  ) {
    const viewT0 = performance.now();
    this.base = this.layer('base', this.width, this.height);
    this.committed = this.layer('committed', 0, 0);
    this.interaction = this.layer('interaction', 0, 0);
    this.baseCtx = context(this.base, { alpha: false, willReadFrequently: false });
    this.committedCtx = context(this.committed);
    this.interactionCtx = context(this.interaction);
    setTextMeasurer(canvasTextMeasurer(this.interactionCtx));
    let effects = store.doc.effects;
    this.unsubscribe = store.subscribe((doc) => {
      if (doc.effects !== effects) {
        effects = doc.effects;
        this.previewEffects = null;
        this.invalidate('base');
      }
      this.invalidate('committed', 'interaction');
      this.events.onStateChange?.();
    });
    this.initPerf = {
      gl_create: 0,
      canvas_view_init: roundMs(performance.now() - viewT0),
    };
  }

  private layer(name: string, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.className = `layer layer-${name}`;
    canvas.width = width;
    canvas.height = height;
    this.container.appendChild(canvas);
    return canvas;
  }

  private getGl(): GlEffects | null {
    if (this.gl === undefined) this.gl = GlEffects.create();
    return this.gl;
  }

  private ensureCommitted(): CanvasRenderingContext2D {
    if (
      !this.committedAllocated ||
      this.committed.width !== this.width ||
      this.committed.height !== this.height
    ) {
      this.committed.width = this.width;
      this.committed.height = this.height;
      this.committedAllocated = true;
    }
    return this.committedCtx;
  }

  private ensureInteraction(): CanvasRenderingContext2D {
    if (
      !this.interactionAllocated ||
      this.interaction.width !== this.width ||
      this.interaction.height !== this.height
    ) {
      this.interaction.width = this.width;
      this.interaction.height = this.height;
      this.interactionAllocated = true;
    }
    return this.interactionCtx;
  }

  get unit(): number {
    return this.store.doc.unit;
  }

  /** Image pixels per CSS pixel as currently displayed. */
  get displayScale(): number {
    return this.width / Math.max(1, this.base.getBoundingClientRect().width);
  }

  private previewEffects: Effects | null = null;

  /** Shows effects without committing them (while a slider is being dragged). */
  preview(effects: Effects | null): void {
    this.previewEffects = effects;
    this.invalidate('base', 'committed');
  }

  setSource(bitmap: ImageBitmap): void {
    this.source = bitmap;
    const captureFirst = this.paintPerf === null;
    const baseT0 = performance.now();
    this.paintBase();
    const baseMs = roundMs(performance.now() - baseT0);
    this.dirty.base = false;
    let committedMs = 0;
    if (this.store.doc.annotations.length > 0 || this.committedAllocated) {
      const committedT0 = performance.now();
      this.paintCommitted();
      committedMs = roundMs(performance.now() - committedT0);
    } else {
      this.marksEnv = null;
    }
    this.dirty.committed = false;
    if (captureFirst) {
      this.paintPerf = { paint_base: baseMs, paint_committed: committedMs };
    }
  }

  /** Resizes every layer (editor crop/flip produce a new source of a new size). */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.base.width = width;
    this.base.height = height;
    if (this.committedAllocated) {
      this.committed.width = width;
      this.committed.height = height;
    }
    if (this.interactionAllocated) {
      this.interaction.width = width;
      this.interaction.height = height;
    }
    this.invalidate('base', 'committed', 'interaction');
  }

  /**
   * The part of the source that is the picture (the overlay's selection);
   * null means the crop or the whole source. Measurements stay inside it.
   */
  setImageArea(area: Rect | null): void {
    this.area = area;
  }

  private imageArea(): Rect {
    return (
      this.area ?? this.store.doc.crop ?? { x: 0, y: 0, width: this.width, height: this.height }
    );
  }

  toImage(clientX: number, clientY: number): Point {
    const r = this.base.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * this.width,
      y: ((clientY - r.top) / r.height) * this.height,
    };
  }

  invalidate(...layers: (keyof typeof this.dirty)[]): void {
    for (const l of layers) this.dirty[l] = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }

  private env(): RenderEnv {
    return {
      source: this.base,
      width: this.width,
      height: this.height,
      unit: this.unit,
      censor: (source, rect, mode) => (this.getGl()?.censor ?? censorFallback)(source, rect, mode),
    };
  }

  private paint(): void {
    this.frame = 0;
    const captureFirst = this.paintPerf === null && this.source !== null;
    let baseMs = 0;
    let committedMs = 0;
    if (this.dirty.base) {
      const t0 = performance.now();
      this.paintBase();
      baseMs = roundMs(performance.now() - t0);
    }
    if (this.dirty.committed) {
      const t0 = performance.now();
      this.paintCommitted();
      committedMs = roundMs(performance.now() - t0);
    }
    if (captureFirst) {
      this.paintPerf = { paint_base: baseMs, paint_committed: committedMs };
    }
    if (this.dirty.interaction) this.paintInteraction();
    this.dirty = { base: false, committed: false, interaction: false };
  }

  private paintCommitted(): void {
    if (this.store.doc.annotations.length === 0) {
      if (this.committedAllocated) this.committedCtx.clearRect(0, 0, this.width, this.height);
      this.marksEnv = null;
      return;
    }
    const ctx = this.ensureCommitted();
    ctx.clearRect(0, 0, this.width, this.height);
    this.marksEnv = drawAnnotations(ctx, this.store.doc.annotations, this.env(), this.skip);
  }

  private paintBase(): void {
    const ctx = this.baseCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.source) return;
    const { adjust, invert } = this.previewEffects ?? this.store.doc.effects;
    const adjusted = invert || !isAdjustNeutral(adjust);
    const gl = adjusted ? this.getGl() : null;
    if (gl && adjusted) {
      ctx.drawImage(gl.adjust(this.source, this.width, this.height, adjust, invert), 0, 0);
    } else {
      if (adjusted) ctx.filter = adjustFilter(adjust, invert);
      ctx.drawImage(this.source, 0, 0);
      ctx.filter = 'none';
    }
  }

  private paintInteraction(): void {
    const s = this.state;
    const selected = this.selectedAnnotations();
    if (s.type === 'idle' && selected.length === 0) {
      if (this.interactionAllocated) this.interactionCtx.clearRect(0, 0, this.width, this.height);
      return;
    }
    const ctx = this.ensureInteraction();
    ctx.clearRect(0, 0, this.width, this.height);
    // Drafts read the committed censors too, so a dragged magnifier shows what the export will.
    const env = this.marksEnv ?? this.env();
    if (s.type === 'draw') drawAnnotation(ctx, s.draft, env);
    if (s.type === 'move') {
      for (const a of s.originals) drawAnnotation(ctx, translate(a, s.delta.x, s.delta.y), env);
    }
    if (s.type === 'handle') drawAnnotation(ctx, s.current, env);
    this.paintSelection(ctx, selected);
  }

  private paintSelection(ctx: Ctx, selected: readonly Annotation[]): void {
    const scale = this.displayScale;
    for (const a of selected) {
      const shown =
        this.state.type === 'move'
          ? translate(a, this.state.delta.x, this.state.delta.y)
          : this.state.type === 'handle' && this.state.original.id === a.id
            ? this.state.current
            : a;
      const b = bounds(shown);
      const pad = 4 * scale;
      ctx.save();
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([5 * scale, 4 * scale]);
      ctx.strokeRect(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineDashOffset = 4.5 * scale;
      ctx.strokeRect(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2);
      ctx.setLineDash([]);
      for (const h of handles(shown)) {
        ctx.beginPath();
        ctx.arc(h.at.x, h.at.y, HANDLE_RADIUS_CSS * scale * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeStyle = '#111111';
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private selectedAnnotations(): Annotation[] {
    const ids = this.store.selected;
    return this.store.doc.annotations.filter((a) => ids.has(a.id));
  }

  private stroke(): Stroke {
    const o = this.options();
    return { color: o.color, width: o.strokeWidth * this.unit, style: o.lineStyle };
  }

  /** Starts an interaction. Returns false if the view didn't take the event. */
  pointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    this.commitText();
    const p = this.toImage(e.clientX, e.clientY);
    const o = this.options();
    const tolerance = 6 * this.displayScale;

    // Handles of selected annotations win over everything else.
    for (const a of this.selectedAnnotations()) {
      const h = handles(a).find(
        (h) => distance(h.at, p) <= HANDLE_RADIUS_CSS * 1.6 * this.displayScale,
      );
      if (h) {
        this.state = { type: 'handle', original: a, handle: h.id, current: a };
        this.skipIds([a.id]);
        return true;
      }
    }

    if (o.tool === 'select') {
      const hit = topmostAt(this.store.doc.annotations, p, tolerance);
      if (!hit) {
        this.store.select([]);
        return true;
      }
      if (!this.store.selected.has(hit.id))
        this.store.select(e.shiftKey ? [...this.store.selected, hit.id] : [hit.id]);
      const originals = this.selectedAnnotations();
      this.state = { type: 'move', start: p, originals, delta: { x: 0, y: 0 } };
      this.skipIds(originals.map((a) => a.id));
      return true;
    }

    if (this.store.selected.size > 0) this.store.select([]);

    switch (o.tool) {
      case 'text': {
        const hit = topmostAt(this.store.doc.annotations, p, tolerance);
        this.openTextEditor(hit?.kind === 'text' ? hit : null, p);
        return true;
      }
      case 'number': {
        const value =
          Math.max(
            0,
            ...this.store.doc.annotations.map((a) => (a.kind === 'number' ? a.value : 0)),
          ) + 1;
        this.store.add({
          id: newId(),
          kind: 'number',
          at: p,
          value,
          size: Math.max(22, o.strokeWidth * 7) * this.unit,
          color: o.color,
        });
        return true;
      }
      case 'stamp':
        this.store.add({
          id: newId(),
          kind: 'stamp',
          at: p,
          emoji: o.stamp,
          size: o.stampSize * this.unit,
        });
        return true;
      case 'picker':
        this.pickColor(p, e.shiftKey);
        return true;
      case 'magnify':
        this.state = {
          type: 'draw',
          start: p,
          draft: {
            id: newId(),
            kind: 'magnify',
            at: p,
            radius: 70 * this.unit,
            zoom: o.magnifyZoom,
            color: o.color,
          },
        };
        this.invalidate('interaction');
        return true;
      default: {
        const draft = this.newDraft(
          o.tool,
          o.tool === 'measure' ? clampPoint(p, this.imageArea()) : p,
        );
        if (!draft) return false;
        this.state = { type: 'draw', start: p, draft };
        this.invalidate('interaction');
        return true;
      }
    }
  }

  private newDraft(tool: ToolId, p: Point): Annotation | null {
    const o = this.options();
    const id = newId();
    const rect = { x: p.x, y: p.y, width: 0, height: 0 };
    switch (tool) {
      case 'pencil':
      case 'marker':
        return { id, kind: tool, points: [p], stroke: this.stroke() };
      case 'line':
      case 'arrow':
      case 'measure':
        return { id, kind: tool, a: p, b: p, stroke: this.stroke() };
      case 'rect':
      case 'ellipse':
        return {
          id,
          kind: tool,
          rect,
          stroke: this.stroke(),
          fill: o.fill,
          radius: tool === 'rect' ? 3 * this.unit : 0,
        };
      case 'censor':
        return { id, kind: 'censor', rect, mode: o.censorMode };
      case 'spotlight':
        return { id, kind: 'spotlight', rect, dim: o.spotlightDim / 100 };
      default:
        return null;
    }
  }

  pointerMove(e: PointerEvent): void {
    const s = this.state;
    if (s.type === 'idle') return;
    const p = this.toImage(e.clientX, e.clientY);
    if (s.type === 'draw') {
      const d = s.draft;
      if (d.kind === 'pencil' || d.kind === 'marker') {
        if (d.kind === 'marker' && e.shiftKey) {
          d.points = [s.start, p];
        } else {
          // Coalesced events give every sample the OS delivered for smooth strokes.
          const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const c of samples.length > 0 ? samples : [e])
            d.points.push(this.toImage(c.clientX, c.clientY));
        }
      } else if (d.kind === 'measure') {
        d.b = measureEnd(d.a, p, this.imageArea(), e.shiftKey);
      } else if (d.kind === 'line' || d.kind === 'arrow') {
        d.b = e.shiftKey ? snap45(s.start, p) : p;
      } else if (
        d.kind === 'rect' ||
        d.kind === 'ellipse' ||
        d.kind === 'censor' ||
        d.kind === 'spotlight'
      ) {
        d.rect = rectFromPoints(s.start, e.shiftKey ? squareFrom(s.start, p) : p);
      } else if (d.kind === 'magnify') {
        d.radius = Math.max(70 * this.unit, distance(s.start, p));
      }
    } else if (s.type === 'move') {
      const delta = { x: p.x - s.start.x, y: p.y - s.start.y };
      s.delta = clampMoveDelta(s.originals, delta, this.imageArea());
    } else if (s.type === 'handle') {
      const target = s.original.kind === 'measure' ? clampPoint(p, this.imageArea()) : p;
      s.current = dragHandle(s.original, s.handle, target);
    }
    this.invalidate('interaction');
  }

  pointerUp(_e: PointerEvent): void {
    const s = this.state;
    this.state = { type: 'idle' };
    if (s.type === 'draw' && isMeaningful(s.draft, 3 * this.displayScale)) {
      this.store.add(s.draft);
    } else if (s.type === 'move' && (s.delta.x !== 0 || s.delta.y !== 0)) {
      const ids = new Set(s.originals.map((a) => a.id));
      this.unskip();
      // Clamped again against the current endpoints: an arrow-key nudge during the drag moved them.
      const current = this.store.doc.annotations.filter((a) => ids.has(a.id));
      const delta = clampMoveDelta(current, s.delta, this.imageArea());
      if (delta.x !== 0 || delta.y !== 0)
        this.store.updateSelected((a) => (ids.has(a.id) ? translate(a, delta.x, delta.y) : a));
      return;
    } else if (s.type === 'handle') {
      this.unskip();
      this.store.update(s.original, s.current);
      return;
    }
    this.unskip();
    this.invalidate('interaction');
  }

  get busy(): boolean {
    return this.state.type !== 'idle' || this.textEditor !== null;
  }

  /** Whether p (client px) is over an annotation or a selection handle. */
  hits(clientX: number, clientY: number): boolean {
    const p = this.toImage(clientX, clientY);
    if (
      this.selectedAnnotations().some((a) =>
        handles(a).some((h) => distance(h.at, p) <= HANDLE_RADIUS_CSS * 1.6 * this.displayScale),
      )
    ) {
      return true;
    }
    return topmostAt(this.store.doc.annotations, p, 6 * this.displayScale) !== undefined;
  }

  /** Keyboard handling for annotation edits. Returns true if the key was used. */
  keyDown(e: KeyboardEvent): boolean {
    if (this.textEditor) return false;
    const mod = e.ctrlKey || e.metaKey;
    const hasSelection = this.store.selected.size > 0;
    if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
      this.store.removeSelected();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd' && hasSelection) {
      this.store.duplicateSelected(12 * this.unit, newId);
      return true;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      this.store.select(this.store.doc.annotations.map((a) => a.id));
      return true;
    }
    if (e.key === 'Escape' && hasSelection) {
      this.store.select([]);
      return true;
    }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (nudge && hasSelection) {
      const step = (e.shiftKey ? 10 : 1) * this.unit;
      const [dx = 0, dy = 0] = nudge;
      const selected = this.store.doc.annotations.filter((a) => this.store.selected.has(a.id));
      // Selected measurements stay inside the image, as when dragging them.
      const d = clampMoveDelta(selected, { x: dx * step, y: dy * step }, this.imageArea());
      if (d.x !== 0 || d.y !== 0) this.store.updateSelected((a) => translate(a, d.x, d.y));
      return true;
    }
    return false;
  }

  /** Applies style changes from the toolbar to selected annotations. */
  applyStyle(patch: StylePatch): void {
    this.store.updateSelected((a) => restyle(a, patch, this.unit));
  }

  private skipIds(ids: string[]): void {
    this.skip = new Set(ids);
    this.invalidate('committed', 'interaction');
  }

  private unskip(): void {
    if (this.skip.size === 0) return;
    this.skip = new Set();
    this.invalidate('committed', 'interaction');
  }

  private pickColor(p: Point, copy: boolean): void {
    const x = Math.max(0, Math.min(this.width - 1, Math.floor(p.x)));
    const y = Math.max(0, Math.min(this.height - 1, Math.floor(p.y)));
    const [r = 0, g = 0, b = 0] = this.baseCtx.getImageData(x, y, 1, 1).data;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    this.events.onPickColor?.(hex, copy);
  }

  private openTextEditor(existing: TextAnnotation | null, p: Point): void {
    const o = this.options();
    const size = existing?.size ?? o.textSize * this.unit;
    const draft: TextAnnotation = existing ?? {
      id: newId(),
      kind: 'text',
      at: { x: p.x, y: p.y - size * 0.6 },
      text: '',
      size,
      color: o.color,
      background: false,
      style: textStyleOf(o),
    };
    const editor = document.createElement('textarea');
    editor.className = 'text-editor';
    editor.value = existing?.text ?? '';
    editor.spellcheck = false;
    const fitToContent = () => {
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
      editor.style.width = 'auto';
      editor.style.width = `${Math.max(40, editor.scrollWidth + 8)}px`;
    };
    editor.addEventListener('input', fitToContent);
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeTextEditor(false);
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.closeTextEditor(true);
      }
    });
    editor.addEventListener('pointerdown', (e) => e.stopPropagation());
    editor.addEventListener('blur', () => this.closeTextEditor(true));
    this.container.appendChild(editor);
    this.textEditor = editor;
    this.textTarget = { existing, draft, fit: fitToContent };
    if (existing) this.skipIds([existing.id]);
    this.styleTextEditor();
    // Focus now, not on the next frame: keys typed right after the click must reach the box.
    editor.focus();
  }

  private textTarget: {
    existing: TextAnnotation | null;
    /** The annotation as it will be committed, apart from its text. */
    draft: TextAnnotation;
    fit: () => void;
  } | null = null;

  /** Shows the open text box in its draft's font, size and colour. */
  private styleTextEditor(): void {
    const editor = this.textEditor;
    const target = this.textTarget;
    if (!editor || !target) return;
    const { draft } = target;
    const scale = 1 / this.displayScale;
    Object.assign(editor.style, {
      left: `${this.base.offsetLeft + draft.at.x * scale}px`,
      top: `${this.base.offsetTop + draft.at.y * scale}px`,
      font: textFont(draft.size * scale, draft.style),
      color: draft.color,
      lineHeight: String(TEXT_LINE_HEIGHT),
      textDecoration: draft.style.underline ? 'underline' : 'none',
    });
    // The canvas strokes the outline under the letters, centred on their edge, so half of
    // it shows. A ring of shadows draws the same, and also around the underline.
    const outline = textOutline(draft);
    editor.style.textShadow = outline
      ? outlineShadow((outline.width / 2) * scale, outline.color)
      : 'none';
    target.fit();
  }

  /** Applies style changes to the open text box, if any; the text style popover keeps it open. */
  restyleTextEditor(patch: StylePatch): void {
    const target = this.textTarget;
    if (!target) return;
    const next = restyle(target.draft, patch, this.unit);
    if (next.kind === 'text') target.draft = next;
    this.styleTextEditor();
  }

  /** Commits any open text box (e.g. before exporting). */
  commitText(): void {
    if (this.textEditor) this.closeTextEditor(true);
  }

  private closeTextEditor(commit: boolean): void {
    const editor = this.textEditor;
    const target = this.textTarget;
    if (!editor || !target) return;
    this.textEditor = null;
    this.textTarget = null;
    const text = editor.value.replace(/\s+$/, '');
    editor.remove();
    this.unskip();
    if (!commit) return;
    const { existing, draft } = target;
    if (existing) {
      if (!text)
        this.store.commit({
          type: 'remove',
          annotation: existing,
          index: this.store.doc.annotations.indexOf(existing),
        });
      else if (text !== existing.text || draft !== existing)
        this.store.update(existing, { ...draft, text });
    } else if (text) {
      this.store.add({ ...draft, text });
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.textEditor?.remove();
    for (const c of [this.base, this.committed, this.interaction]) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    this.committedAllocated = false;
    this.interactionAllocated = false;
    this.gl = null;
    this.source = null;
  }
}

/** Text shadows in eight directions at radius r: an outline for HTML text. */
export function outlineShadow(r: number, color: string): string {
  const d = Math.round(r * Math.SQRT1_2 * 100) / 100;
  const at = (x: number, y: number) => `${x}px ${y}px 0 ${color}`;
  return [
    at(r, 0),
    at(-r, 0),
    at(0, r),
    at(0, -r),
    at(d, d),
    at(-d, d),
    at(d, -d),
    at(-d, -d),
  ].join(', ');
}

function context(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings) {
  const ctx = canvas.getContext('2d', options);
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

/**
 * Limits a move of the selection so every selected measurement stays inside
 * `area`; the selection still moves as one. Other kinds move freely. Not
 * moving is always allowed, so a measurement left outside (the overlay
 * selection shrank) can still be moved back in.
 */
export function clampMoveDelta(selected: readonly Annotation[], delta: Point, area: Rect): Point {
  const x = { lo: -Infinity, hi: Infinity };
  const y = { lo: -Infinity, hi: Infinity };
  for (const a of selected) {
    if (a.kind !== 'measure') continue;
    for (const p of [a.a, a.b]) {
      x.lo = Math.max(x.lo, area.x - p.x);
      x.hi = Math.min(x.hi, area.x + area.width - p.x);
      y.lo = Math.max(y.lo, area.y - p.y);
      y.hi = Math.min(y.hi, area.y + area.height - p.y);
    }
  }
  const limit = (v: number, r: { lo: number; hi: number }) =>
    Math.max(Math.min(r.lo, 0), Math.min(Math.max(r.hi, 0), v));
  return { x: limit(delta.x, x), y: limit(delta.y, y) };
}

/**
 * Where a measurement from `start` ends for pointer `p`: at the nearest point
 * of the image when the pointer is outside it, along the snapped direction
 * when snapping to 45°.
 */
export function measureEnd(start: Point, p: Point, area: Rect, snap: boolean): Point {
  const a = clampPoint(start, area);
  return snap ? clampAlong(a, snap45(a, p), area) : clampPoint(p, area);
}

/** Drafts too small to see are treated as accidental clicks. */
export function isMeaningful(a: Annotation, min: number): boolean {
  switch (a.kind) {
    case 'pencil':
    case 'marker':
      return a.points.length > 1;
    case 'line':
    case 'arrow':
    case 'measure':
      return distance(a.a, a.b) >= min;
    case 'rect':
    case 'ellipse':
    case 'censor':
    case 'spotlight':
      return a.rect.width >= min && a.rect.height >= min;
    default:
      return true;
  }
}

export function restyle(a: Annotation, patch: StylePatch, unit: number): Annotation {
  if ('stroke' in a) {
    const stroke: Stroke = {
      color: patch.color ?? a.stroke.color,
      width: patch.strokeWidth !== undefined ? patch.strokeWidth * unit : a.stroke.width,
      style: patch.lineStyle ?? a.stroke.style,
    };
    if (a.kind === 'rect' || a.kind === 'ellipse')
      return { ...a, stroke, fill: patch.fill ?? a.fill };
    return { ...a, stroke };
  }
  if (a.kind === 'text') {
    const s = a.style;
    return {
      ...a,
      color: patch.color ?? a.color,
      size: patch.textSize !== undefined ? patch.textSize * unit : a.size,
      style: {
        font: patch.textFont ?? s.font,
        bold: patch.textBold ?? s.bold,
        italic: patch.textItalic ?? s.italic,
        underline: patch.textUnderline ?? s.underline,
        outline: patch.textOutline ?? s.outline,
      },
    };
  }
  if ((a.kind === 'number' || a.kind === 'magnify') && patch.color) {
    return { ...a, color: patch.color };
  }
  return a;
}
