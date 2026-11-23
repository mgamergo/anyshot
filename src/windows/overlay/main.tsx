import '../common/ui.css';
import './overlay.css';
import type { ComponentChildren } from 'preact';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isBlankDoc, translateDoc } from '../../engine/document';
import { DEFAULT_EFFECTS, emptyDoc, screenshotDoc } from '../../engine/model';
import type { Point, Rect } from '../../shared/geometry';
import type { DeliverAction, OverlayInit, RawImage, RecordAudio } from '../../shared/ipc';
import { epochMs, PerfTimer } from '../../shared/perf';
import {
  flippedHandle,
  moveSelection,
  placeToolbar,
  popoverSide,
  resizeSelection,
  SELECTION_HANDLES,
  type SelectionHandle,
  toImageRegion,
} from '../../shared/selection';
import { type Annotator, createAnnotator, nativeInputOwnsKey } from '../common/annotator';
import { EffectButtons, EffectPopovers } from '../common/effects-ui';
import { exportImage } from '../common/export';
import { createStore, useStore } from '../common/store';
import { TextPopover } from '../common/text-style-ui';
import { applyTheme } from '../common/theme';
import { Bar, Button, ColorPopover, OptionsRow, ToolStrip } from '../common/toolbar';

const api = window.anyshot;

type Phase = 'loading' | 'idle' | 'selecting' | 'selected';
interface OverlayUi {
  phase: Phase;
  dragging: boolean;
  /** Committed selection (CSS px). Updated when a drag ends, not on every move. */
  selection: Rect | null;
  busy: boolean;
  toast: string | null;
  /** Audio for the recording, toggled on the record bar. */
  audio: RecordAudio;
}

type Drag =
  | { type: 'new'; start: Point }
  | { type: 'resize'; handle: SelectionHandle }
  | { type: 'move'; start: Point; origin: Rect }
  | { type: 'engine' };

const ui = createStore<OverlayUi>({
  phase: 'loading',
  dragging: false,
  selection: null,
  busy: false,
  toast: null,
  audio: { microphone: false, systemAudio: false },
});

const stage = byId('stage');
const dimEl = byId('dim');
const selEl = byId('selection');
const sizeEl = byId('size');

let init: OverlayInit;
let bitmap: ImageBitmap | null = null;
let annotator: Annotator | null = null;
let selection: Rect | null = null;
let automaticBeautify = DEFAULT_EFFECTS.beautify;
let drag: Drag | null = null;
let spaceHeld = false;
let chromeFrame = 0;
let sessionGen = 0;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

// The display's size, not the window's: a capture taken at load runs before the window has its final size.
const screenSize = () => ({ width: init.bounds.width, height: init.bounds.height });

function pointOf(e: MouseEvent): Point {
  return { x: e.clientX, y: e.clientY };
}

/** Repaints the selection rectangle and size readout once per frame. */
function scheduleChrome(): void {
  if (chromeFrame) return;
  chromeFrame = requestAnimationFrame(() => {
    chromeFrame = 0;
    paintChrome();
  });
}

function paintChrome(): void {
  const dimOutside = init.settings.capture.dimOutside;
  dimEl.classList.toggle('off', !dimOutside || selection !== null);
  if (!selection) {
    selEl.hidden = true;
    sizeEl.hidden = true;
    return;
  }
  const { x, y, width, height } = selection;
  selEl.hidden = false;
  selEl.classList.toggle('no-dim', !dimOutside);
  selEl.classList.toggle('dragging', drag !== null && drag.type !== 'engine');
  Object.assign(selEl.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
  const region = toImageRegion(selection, init.scaleFactor, init.frame);
  sizeEl.hidden = false;
  sizeEl.textContent = `${region.width} × ${region.height}`;
  const above = y - 26;
  Object.assign(sizeEl.style, { left: `${x}px`, top: `${above >= 4 ? above : y + 6}px` });
}

function buildHandles(): void {
  for (const h of SELECTION_HANDLES) {
    const el = document.createElement('div');
    el.className = 'handle';
    el.dataset.h = h;
    const left = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
    const top = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
    Object.assign(el.style, { left, top });
    selEl.appendChild(el);
  }
}

function setSelection(rect: Rect | null, commit = true): void {
  selection = rect;
  // The selection is the picture here: measurements stay inside it.
  annotator?.view.setImageArea(rect && toImageRegion(rect, init.scaleFactor, init.frame));
  scheduleChrome();
  if (commit) {
    ui.set({ selection: rect, phase: rect ? 'selected' : 'idle' });
    if (rect) void api.invoke('capture:remember-area', { rect });
  }
}

function fullScreen(): Rect {
  return { x: 0, y: 0, ...screenSize() };
}

function selectCapture(rect: Rect, mode: 'area' | 'last' | 'screen'): void {
  if (!annotator) return;
  const { docs } = annotator;
  if (init.mode !== 'ocr' && !isRecordingSetup()) {
    const { beautify } = screenshotDoc(docs.doc.unit, init.settings.capture.beautify, mode).effects;
    if (
      beautify.enabled !== automaticBeautify.enabled ||
      beautify.background !== automaticBeautify.background ||
      beautify.padding !== automaticBeautify.padding ||
      beautify.radius !== automaticBeautify.radius ||
      beautify.shadow !== automaticBeautify.shadow
    ) {
      docs.setBeautifyDefault(automaticBeautify, beautify);
      automaticBeautify = beautify;
    }
  }
  setSelection(rect);
}

// ---------------------------------------------------------------- pointer

function onPointerDown(e: PointerEvent): void {
  const state = ui.get();
  if (state.busy || state.phase === 'loading' || e.button !== 0) return;
  ui.set({ toast: null });
  const p = pointOf(e);
  const handle = (e.target as HTMLElement).dataset?.h as SelectionHandle | undefined;
  if (state.phase === 'idle') {
    drag = { type: 'new', start: p };
    void api.invoke('overlay:selection-start');
    ui.set({ phase: 'selecting', dragging: true });
  } else if (state.phase === 'selected' && selection) {
    if (handle) drag = { type: 'resize', handle };
    else if (spaceHeld) drag = { type: 'move', start: p, origin: selection };
    else if (isRecordingSetup()) return;
    else if (annotator?.view.pointerDown(e)) drag = { type: 'engine' };
    else return;
    if (drag.type !== 'engine') ui.set({ dragging: true });
  } else {
    return;
  }
  document.documentElement.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const p = pointOf(e);
  switch (drag.type) {
    case 'engine':
      annotator?.view.pointerMove(e);
      return;
    case 'new': {
      const { start } = drag;
      setSelection(
        resizeSelection({ ...start, width: 0, height: 0 }, 'se', p, screenSize()),
        false,
      );
      return;
    }
    case 'resize': {
      if (!selection) return;
      const { handle } = drag;
      drag = { type: 'resize', handle: flippedHandle(selection, handle, p) };
      setSelection(resizeSelection(selection, handle, p, screenSize()), false);
      return;
    }
    case 'move':
      setSelection(
        moveSelection(drag.origin, p.x - drag.start.x, p.y - drag.start.y, screenSize()),
        false,
      );
      return;
  }
}

function onPointerUp(e: PointerEvent): void {
  const current = drag;
  drag = null;
  if (!current) return;
  if (current.type === 'engine') {
    annotator?.view.pointerUp(e);
    return;
  }
  // A click without a drag selects the whole display.
  if (current.type !== 'new') setSelection(selection);
  else if (selection && selection.width >= 4 && selection.height >= 4)
    selectCapture(selection, 'area');
  else selectCapture(fullScreen(), 'screen');
  ui.set({ dragging: false });
  if (current.type === 'new') afterSelected();
}

/**
 * Without instant preview a chosen area is captured at once (quick action and
 * the floating thumbnail, whose Edit opens the editor); with it, the selection
 * stays open with the edit tools.
 */
function capturesAtOnce(): boolean {
  if (init.mode === 'quick') return true;
  const plain = init.mode === 'area' || init.mode === 'screen' || init.mode === 'last';
  return plain && !init.settings.capture.instantPreview;
}

/** Modes that act as soon as an area is chosen. */
function afterSelected(): void {
  if (init.mode === 'ocr') void finish('ocr');
  else if (capturesAtOnce()) void finish('quick');
}

/** Video recordings take audio; GIFs and scroll captures don't. */
function recordsAudio(): boolean {
  return init.mode === 'record';
}

function toggleAudio(key: keyof RecordAudio): void {
  if (!recordsAudio() || (key === 'systemAudio' && !init.systemAudio)) return;
  const audio = { ...ui.get().audio, [key]: !ui.get().audio[key] };
  ui.set({ audio });
  // Also the default for the next recording.
  void api.invoke('settings:patch', { recording: { [key]: audio[key] } });
}

function isRecordingSetup(): boolean {
  return init.mode === 'record' || init.mode === 'gif' || init.mode === 'scroll';
}

function onDoubleClick(e: MouseEvent): void {
  if (!selection || ui.get().phase !== 'selected' || isRecordingSetup()) return;
  if (!init.settings.capture.doubleClickToCopy) return;
  if (e.target instanceof Element && e.target.closest('.popover')) return;
  const p = pointOf(e);
  const inside =
    p.x >= selection.x &&
    p.x <= selection.x + selection.width &&
    p.y >= selection.y &&
    p.y <= selection.y + selection.height;
  if (inside && annotator && !annotator.view.busy && !annotator.view.hits(e.clientX, e.clientY))
    void finish('copy');
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(e: KeyboardEvent): void {
  if (ui.get().busy) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && e.key !== 'Escape' && nativeInputOwnsKey(e)) return;
  // A record-bar button reached with Tab keeps its own Enter and Space.
  if (
    (e.key === 'Enter' || e.key === ' ') &&
    e.target instanceof HTMLButtonElement &&
    e.target.closest('[data-testid="record-actions"]')
  )
    return;
  const key = e.key.toLowerCase();
  if (e.key === ' ') {
    spaceHeld = true;
    document.body.style.cursor = 'move';
    e.preventDefault();
    return;
  }
  // An open popover takes Esc first (see dismissPopovers).
  if (e.key === 'Escape') {
    if (!annotator?.view.keyDown(e)) void api.invoke('overlay:cancel');
    return;
  }
  const phase = ui.get().phase;
  if (phase === 'idle') {
    if (key === 'f') selectCapture(fullScreen(), 'screen');
    else if (key === 'r' && init.lastSelection) selectCapture(init.lastSelection, 'last');
    if (key === 'f' || key === 'r') afterSelected();
    return;
  }
  if (phase !== 'selected') return;
  if (isRecordingSetup()) {
    if (e.key === 'Enter') startRecordingOrScroll();
    else if (!mod && key === 'm') toggleAudio('microphone');
    else if (!mod && key === 'a') toggleAudio('systemAudio');
    return;
  }
  if (e.key === 'Enter') void finish('quick');
  else if (mod && key === 'c') void finish('copy');
  else if (mod && key === 's') void finish(e.shiftKey ? 'saveAs' : 'save');
  else if (!mod && key === 'e') void finish('editor');
  else if (!mod && key === 'f') void finish('pin');
  else if (!mod && key === 'u') void finish('upload');
  else if (annotator?.handleKey(e)) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ') {
    spaceHeld = false;
    document.body.style.cursor = '';
  }
}

// ---------------------------------------------------------------- finishing

function rawRegion(source: ImageBitmap, region: Rect): RawImage {
  const canvas = new OffscreenCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(source, -region.x, -region.y);
  const data = ctx.getImageData(0, 0, region.width, region.height).data;
  return { rgba: data.buffer as ArrayBuffer, width: region.width, height: region.height };
}

function wantsSaveFormat(action: DeliverAction): boolean {
  const s = init.settings;
  if (s.output.imageFormat === 'png') return false;
  if (action === 'save' || action === 'saveAs') return true;
  return action === 'quick' && s.capture.quickAction.includes('save');
}

/** Produces the final image and hands it to main, which closes the overlays. */
async function finish(action: DeliverAction): Promise<void> {
  if (!selection || ui.get().busy || !annotator || !bitmap) return;
  const gen = sessionGen;
  const currentBitmap = bitmap;
  const perf = new PerfTimer();
  ui.set({ busy: true });
  annotator.controller.store.set({ popover: null });
  annotator.view.commitText();
  const region = toImageRegion(selection, init.scaleFactor, init.frame);
  const doc = translateDoc(annotator.docs.doc, -region.x, -region.y);
  const screenRect = {
    x: init.bounds.x + selection.x,
    y: init.bounds.y + selection.y,
    width: selection.width,
    height: selection.height,
  };
  try {
    if (action === 'editor') {
      await api.invoke('capture:to-editor', { image: rawRegion(currentBitmap, region), doc });
      return;
    }
    const blank = isBlankDoc(doc);
    const saveFormat = wantsSaveFormat(action);
    const format = init.settings.output.imageFormat;
    // Fire-and-forget hide so encoding or native delivery starts without waiting for an IPC roundtrip.
    void api.invoke('overlay:hide');
    // fast-encode.ts cannot encode WebP natively yet, so WebP saves stay on the worker export path.
    if (blank && !(saveFormat && format === 'webp')) {
      perf.mark('finish_pre_ipc');
      await api.invoke('capture:deliver-raw', {
        action,
        frameId: init.frameId,
        crop: region,
        screenRect,
        perf: { metrics: perf.metrics, sentEpochMs: epochMs() },
      });
      return;
    }
    const exportStart = performance.now();
    const [out, original] = await Promise.all([
      exportImage({
        source: currentBitmap,
        region,
        doc,
        ...(saveFormat
          ? {
              save: {
                mime: format === 'jpeg' ? ('image/jpeg' as const) : ('image/webp' as const),
                quality: init.settings.output.imageQuality,
              },
            }
          : {}),
      }),
      // Annotated captures also keep their original pixels, so history reopens them editable.
      blank ? null : exportImage({ source: currentBitmap, region, thumbMax: 16 }),
    ]);
    if (gen !== sessionGen) return;
    perf.mark('export_all_total', exportStart);
    perf.merge(out.perf);
    perf.mark('finish_pre_ipc');
    await api.invoke('capture:deliver', {
      action,
      image: out.png,
      thumb: out.thumb,
      screenRect,
      ...(out.save ? { saveImage: out.save } : {}),
      ...(original ? { edit: { doc, source: original.png } } : {}),
      perf: { metrics: perf.metrics, sentEpochMs: epochMs() },
    });
  } catch (error) {
    console.error('[overlay] finish failed', error);
    if (gen === sessionGen) await api.invoke('overlay:cancel');
  }
}

function startRecordingOrScroll(): void {
  if (!selection || ui.get().busy) return;
  ui.set({ busy: true });
  if (init.mode === 'scroll') void api.invoke('capture:scroll', { rect: selection, gif: false });
  else
    void api.invoke('capture:record', {
      rect: selection,
      gif: init.mode === 'gif',
      ...(recordsAudio() ? { audio: ui.get().audio } : {}),
    });
}

// ---------------------------------------------------------------- chrome UI

function Floating(props: {
  anchor: Rect;
  side: 'below' | 'right';
  children: ComponentChildren;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Point | null>(null);
  const [popoverUp, setPopoverUp] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setPos(
        placeToolbar(
          props.anchor,
          { width: el.offsetWidth, height: el.offsetHeight },
          screenSize(),
          props.side,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.anchor, props.side]);
  // Popovers hang off the bar (outside its measured size): open them upwards when
  // there is no room below, so they never run off the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pos) return;
    const place = () => {
      const popover = el.querySelector<HTMLElement>('.popover');
      if (!popover) return;
      const bar = el.getBoundingClientRect();
      if (popover.classList.contains('beautify')) {
        const { width, height } = screenSize();
        const above = bar.top - 12;
        const below = height - bar.bottom - 12;
        popover.style.setProperty('--beautify-height', `${Math.max(above, below)}px`);
        popover.style.left = `${Math.min(0, width - bar.left - popover.offsetWidth - 8)}px`;
      }
      setPopoverUp(popoverSide(bar, popover.offsetHeight, screenSize().height) === 'above');
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pos]);
  return (
    <div
      ref={ref}
      class={`floating-bar${popoverUp ? ' popover-up' : ''}`}
      data-testid={props.testId}
      style={{
        left: `${pos?.x ?? 0}px`,
        top: `${pos?.y ?? 0}px`,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {props.children}
    </div>
  );
}

/** Two toggles on the record bar: computer audio and the microphone. */
function AudioToggles() {
  const { microphone, systemAudio } = useStore(ui, (s) => s.audio);
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  // A click doesn't move focus here, so Enter afterwards still starts the recording.
  return (
    <div class="audio-toggles" onMouseDown={(e) => e.preventDefault()}>
      <Button
        icon={systemAudio ? 'speaker' : 'speakerOff'}
        label={
          init.systemAudio
            ? `Computer audio: ${onOff(systemAudio)} (A)`
            : 'Computer audio can only be recorded on Windows'
        }
        active={systemAudio}
        disabled={!init.systemAudio}
        onClick={() => toggleAudio('systemAudio')}
        testId="audio-system"
      />
      <Button
        icon={microphone ? 'mic' : 'micOff'}
        label={`Microphone: ${onOff(microphone)} (M)`}
        active={microphone}
        onClick={() => toggleAudio('microphone')}
        testId="audio-mic"
      />
    </div>
  );
}

function Actions() {
  const act = (a: DeliverAction) => () => void finish(a);
  if (isRecordingSetup()) {
    const scroll = init.mode === 'scroll';
    return (
      <Bar vertical testId="record-actions">
        <Button
          icon={scroll ? 'scroll' : init.mode === 'gif' ? 'gif' : 'record'}
          label={scroll ? 'Start scroll capture (Enter)' : 'Start recording (Enter)'}
          onClick={startRecordingOrScroll}
          testId="start"
        />
        {recordsAudio() && <AudioToggles />}
        <Button
          icon="close"
          label="Cancel (Esc)"
          danger
          onClick={() => void api.invoke('overlay:cancel')}
          testId="cancel"
        />
      </Bar>
    );
  }
  return (
    <Bar vertical testId="actions">
      <Button
        icon="close"
        label="Cancel (Esc)"
        danger
        onClick={() => void api.invoke('overlay:cancel')}
        testId="cancel"
      />
      <Button
        icon="editor"
        label="Open in editor (E)"
        onClick={act('editor')}
        testId="action-editor"
      />
      <Button icon="copy" label="Copy (Ctrl+C)" onClick={act('copy')} testId="action-copy" />
      <Button icon="save" label="Save (Ctrl+S)" onClick={act('save')} testId="action-save" />
      <Button icon="pin" label="Pin to screen (F)" onClick={act('pin')} testId="action-pin" />
      <Button icon="ocr" label="Recognise text" onClick={act('ocr')} testId="action-ocr" />
      {init.settings.uploads.provider !== 'none' && (
        <Button icon="upload" label="Upload (U)" onClick={act('upload')} testId="action-upload" />
      )}
      <span class="sep" />
      <Button
        icon="scroll"
        label="Scroll capture"
        onClick={() => switchMode('scroll')}
        testId="action-scroll"
      />
      <Button
        icon="record"
        label="Record this area"
        onClick={() => switchMode('record')}
        testId="action-record"
      />
    </Bar>
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A message at the bottom of the screen that goes away by itself (a picked colour). */
function showToast(message: string): void {
  clearTimeout(toastTimer);
  ui.set({ toast: message });
  toastTimer = setTimeout(() => {
    if (ui.get().toast === message) ui.set({ toast: null });
  }, 2500);
}

function switchMode(mode: 'record' | 'scroll'): void {
  init = { ...init, mode };
  ui.set({ toast: null, selection: selection ? { ...selection } : null });
}

function Chrome() {
  const s = useStore(ui, (s) => s);
  const hint =
    s.phase === 'idle' && !init.settings.capture.hideInstructions
      ? init.mode === 'ocr'
        ? 'Drag over the text to read · Esc cancels'
        : 'Drag to select an area · Click or F for the whole screen · R for the last area · Esc cancels'
      : null;
  return (
    <>
      {hint && <div class="pill">{hint}</div>}
      {s.toast && (
        <div class="toast" role="status" data-testid="overlay-toast">
          {s.toast}
        </div>
      )}
      {s.phase === 'selected' && s.selection && !s.dragging && !s.busy && annotator && (
        <>
          {!isRecordingSetup() && (
            <Floating anchor={s.selection} side="below" testId="bottom">
              <Bar testId="tools">
                <ToolStrip
                  c={annotator.controller}
                  extra={<EffectButtons c={annotator.controller} />}
                />
              </Bar>
              <OptionsRow c={annotator.controller} />
              <ColorPopover c={annotator.controller} />
              <EffectPopovers c={annotator.controller} />
              <TextPopover c={annotator.controller} />
            </Floating>
          )}
          <Floating anchor={s.selection} side="right" testId="right">
            <Actions />
          </Floating>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- boot

async function loadFrame(
  frameId: string,
  width: number,
  height: number,
  perf: PerfTimer,
): Promise<ImageBitmap> {
  const response = await perf.async('fetch_frame', () => fetch(`/@frame/${frameId}`));
  if (!response.ok) throw new Error(`frame ${frameId}: ${response.status}`);
  const buffer = await perf.async('arrayBuffer', () => response.arrayBuffer());
  const pixels = new Uint8ClampedArray(buffer);
  // Keep the raw frame in main until endCapture() so unannotated delivery can use capture:deliver-raw.
  return perf.async('createImageBitmap', () =>
    createImageBitmap(new ImageData(pixels, width, height)),
  );
}

/** Releases per-capture GPU resources and resets UI state so a warm overlay can be reused. */
function standby(): void {
  sessionGen++;
  if (chromeFrame) {
    cancelAnimationFrame(chromeFrame);
    chromeFrame = 0;
  }
  clearTimeout(toastTimer);
  toastTimer = undefined;
  selection = null;
  automaticBeautify = DEFAULT_EFFECTS.beautify;
  drag = null;
  spaceHeld = false;
  document.body.style.cursor = '';
  dimEl.classList.add('off');
  selEl.hidden = true;
  sizeEl.hidden = true;
  if (annotator) {
    annotator.dispose();
    annotator = null;
  }
  if (bitmap) {
    bitmap.close();
    bitmap = null;
  }
  ui.set({
    phase: 'loading',
    dragging: false,
    selection: null,
    busy: false,
    toast: null,
  });
}

async function activate(
  nextInit: OverlayInit,
  action: 'start' | 'reset',
  perf = new PerfTimer(),
): Promise<void> {
  standby();
  const gen = sessionGen;
  try {
    init = nextInit;
    const activeStart = performance.now();
    applyTheme(init.settings);
    ui.set({
      audio: {
        microphone: init.settings.recording.microphone,
        systemAudio: init.systemAudio && init.settings.recording.systemAudio,
      },
    });
    const loaded = await loadFrame(init.frameId, init.frame.width, init.frame.height, perf);
    if (gen !== sessionGen) {
      loaded.close();
      return;
    }
    bitmap = loaded;
    const currentAnnotator = createAnnotator(
      stage,
      init.frame,
      emptyDoc(init.scaleFactor),
      init.settings,
      showToast,
    );
    annotator = currentAnnotator;
    perf.merge(currentAnnotator.view.initPerf);
    perf.sync('setSource', () => currentAnnotator.view.setSource(loaded));
    perf.sync('ui_setup', () => {
      ui.set({ phase: 'idle' });
      if (init.selectAll) selectCapture(fullScreen(), 'screen');
      else if (init.mode === 'last' && init.lastSelection)
        selectCapture(init.lastSelection, 'last');
      if (chromeFrame) {
        cancelAnimationFrame(chromeFrame);
        chromeFrame = 0;
      }
      paintChrome();
      if (init.selectAll || (init.mode === 'last' && init.lastSelection)) afterSelected();
    });
    // Base canvas and chrome are painted synchronously; one frame lets the compositor commit them.
    // When a reused warm overlay is hidden (`document.hidden`), Chromium can suspend rAF until show(),
    // so yield a macrotask instead of deadlocking on rAF before `win.show()`.
    const rafStart = performance.now();
    const notifyPainted = () => {
      if (gen !== sessionGen) return;
      perf.mark('raf_wait', rafStart);
      if (annotator?.view.paintPerf) perf.merge(annotator.view.paintPerf);
      perf.mark('boot_active_total', activeStart);
      perf.mark('boot_total');
      void api.invoke('overlay:painted', { metrics: perf.metrics, sentEpochMs: epochMs() });
    };
    if (document.hidden) {
      setTimeout(notifyPainted, 0);
    } else {
      requestAnimationFrame(notifyPainted);
    }
  } catch (error) {
    console.error(`[overlay] failed to ${action}`, error);
    if (gen === sessionGen) void api.invoke('overlay:cancel');
  }
}

function setupOnce(): void {
  buildHandles();
  render(<Chrome />, byId('ui'));
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  api.on('settings:changed', applyTheme);
  api.on('overlay:clear-selection', () => {
    if (ui.get().phase !== 'loading') setSelection(null);
  });
  api.on('overlay:standby', () => {
    standby();
  });
  api.on('overlay:reset', (nextInit) => {
    void activate(nextInit, 'reset');
  });
}

async function boot(): Promise<void> {
  setupOnce();
  const bootGen = sessionGen;
  const perf = new PerfTimer();
  const initial = await perf.async('overlay_init_ipc', () => api.invoke('overlay:init'));
  if (bootGen !== sessionGen) return;
  await activate(initial, 'start', perf);
}

boot().catch((error) => {
  console.error('[overlay] failed to start', error);
  if (sessionGen === 0) void api.invoke('overlay:cancel');
});
