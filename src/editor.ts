/**
 * Crop/rotate view (v0.2): the full captured image with the frame at its
 * stored geometry. Crop drags and fine rotation only change a pending copy of
 * the frame; the caller bakes the rotation on confirm.
 *
 * Display: the image is turned by the frame's base angle (multiples of 90°),
 * so 90° taps are visible, and letterboxed into the stage. During fine
 * rotation the image stays still and only the frame turns (decision 2026-09-22).
 */

import * as icons from './icons';
import type { Capture, Frame } from './model';
import {
  affineScale,
  applyAffine,
  baseAngle,
  clampSkew,
  frameCorners,
  HANDLES,
  handleLocalPosition,
  hitHandle,
  insideFrame,
  invertAffine,
  moveFrame,
  resizeFrame,
  rotate90Right,
  toFrameLocal,
  viewTransform,
  type Affine,
  type Handle,
  type Point,
} from './geometry';
import { releaseCanvas } from './share';
import { iconButton, segmentButton } from './ui';

export type EditMode = 'crop' | 'rotate';

export interface EditorCallbacks {
  /** Back: discard the pending frame. */
  onCancel(): void;
  /** Confirm with the pending frame (angle may be non-zero: the caller bakes it). */
  onConfirm(frame: Frame): void;
}

/** Touch target radius of a crop handle in CSS pixels (44 px target). */
const HANDLE_HIT_RADIUS = 22;
/** Drawn handle radius in CSS pixels. */
const HANDLE_RADIUS = 9;
/** Cap for the display canvas backing store (device pixels per CSS pixel). */
const MAX_DPR = 2;

const SVG_NS = 'http://www.w3.org/2000/svg';

type Drag =
  | { kind: 'move'; start: Frame; startImage: Point }
  | { kind: 'resize'; start: Frame; handle: Handle; startLocal: Point }
  | { kind: 'rotate'; startAngle: number; base: number; startTouch: number; centreView: Point; radius: number };

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;

export class CropRotateView {
  readonly element: HTMLElement;

  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: SVGSVGElement;
  private readonly shade: SVGPathElement;
  private readonly frameGroup: SVGGElement;
  private readonly frameRect: SVGRectElement;
  private readonly handles: Map<Handle, SVGCircleElement>;
  private readonly arc: SVGPathElement;
  private readonly modeButtons: Record<EditMode, HTMLButtonElement>;

  private capture: Capture | null = null;
  private pending: Frame | null = null;
  private mode: EditMode = 'crop';
  private transform: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  /** Base angle the display canvas was last drawn with. */
  private drawnBase: number | null = null;
  private drag: Drag | null = null;

  constructor(private readonly callbacks: EditorCallbacks) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'edit-canvas';

    this.overlay = svgEl('svg', { class: 'edit-overlay' });
    this.overlay.setAttribute('aria-hidden', 'true');
    this.shade = svgEl('path', { class: 'edit-shade', 'fill-rule': 'evenodd' });
    this.frameGroup = svgEl('g');
    this.frameRect = svgEl('rect', { class: 'edit-frame' });
    this.frameGroup.append(this.frameRect);
    this.handles = new Map();
    for (const handle of HANDLES) {
      const circle = svgEl('circle', { class: 'edit-handle', r: String(HANDLE_RADIUS) });
      this.handles.set(handle, circle);
      this.frameGroup.append(circle);
    }
    this.arc = svgEl('path', { class: 'edit-arc' });
    this.arc.setAttribute('visibility', 'hidden');
    this.overlay.append(this.shade, this.frameGroup, this.arc);

    this.stage = document.createElement('div');
    this.stage.className = 'edit-stage';
    this.stage.append(this.canvas, this.overlay);
    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.stage.addEventListener('pointerup', (event) => this.onPointerEnd(event));
    this.stage.addEventListener('pointercancel', (event) => this.onPointerEnd(event));

    const back = iconButton(icons.arrowLeft, 'Zurück', 'compact');
    back.addEventListener('click', () => this.cancel());

    const segmented = document.createElement('div');
    segmented.className = 'segmented segmented-modes';
    segmented.setAttribute('role', 'radiogroup');
    segmented.setAttribute('aria-label', 'Modus');
    this.modeButtons = {} as Record<EditMode, HTMLButtonElement>;
    const modes: [EditMode, string, string][] = [
      ['crop', icons.crop, 'Zuschneiden'],
      ['rotate', icons.rotate, 'Drehen'],
    ];
    for (const [mode, icon, label] of modes) {
      const button = segmentButton(icon, label, () => this.setMode(mode));
      this.modeButtons[mode] = button;
      segmented.append(button);
    }

    const rotate90 = iconButton(icons.rotate90Right, 'Um 90° nach rechts drehen', 'compact');
    rotate90.addEventListener('click', () => this.rotate90());
    const confirm = iconButton(icons.check, 'Bestätigen', 'primary compact');
    confirm.addEventListener('click', () => this.confirm());

    const bar = document.createElement('div');
    bar.className = 'button-bar button-bar-compact';
    bar.append(back, segmented, rotate90, confirm);

    this.element = document.createElement('section');
    this.element.className = 'screen screen-edit';
    this.element.append(this.stage, bar);
    this.element.hidden = true;

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this.layout()).observe(this.stage);
    }
  }

  /** Shows the capture with a fresh pending copy of its frame, in crop mode. */
  open(capture: Capture): void {
    this.capture = capture;
    this.pending = { ...capture.frame };
    this.mode = 'crop';
    this.drag = null;
    this.drawnBase = null;
    this.element.hidden = false;
    this.renderMode();
    this.layout();
  }

  /** Hides the view and drops the display copy. Never touches the capture. */
  close(): void {
    this.element.hidden = true;
    this.capture = null;
    this.pending = null;
    this.drag = null;
    this.drawnBase = null;
    releaseCanvas(this.canvas);
  }

  // ---- buttons ---------------------------------------------------------

  private setMode(mode: EditMode): void {
    if (this.drag) return;
    this.mode = mode;
    this.renderMode();
    this.renderOverlay();
  }

  private rotate90(): void {
    if (!this.pending || this.drag) return;
    this.pending = rotate90Right(this.pending);
    this.layout();
  }

  private cancel(): void {
    this.drag = null;
    this.callbacks.onCancel();
  }

  private confirm(): void {
    if (!this.pending || this.drag) return;
    this.callbacks.onConfirm({ ...this.pending });
  }

  private renderMode(): void {
    for (const mode of ['crop', 'rotate'] as const) {
      this.modeButtons[mode].setAttribute('aria-checked', String(mode === this.mode));
    }
    this.stage.dataset.mode = this.mode;
  }

  // ---- display ---------------------------------------------------------

  /** Recomputes the view transform for the current stage size and base angle, then redraws. */
  layout(): void {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending || this.element.hidden) return;
    const viewW = this.stage.clientWidth;
    const viewH = this.stage.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    const base = baseAngle(pending.angle);
    const { image } = capture;
    this.transform = viewTransform(image.width, image.height, base, viewW, viewH);
    this.overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    this.drawImage(viewW, viewH, base);
    this.renderOverlay();
  }

  private drawImage(viewW: number, viewH: number, base: number): void {
    const capture = this.capture;
    if (!capture) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const width = Math.round(viewW * dpr);
    const height = Math.round(viewH * dpr);
    const unchanged =
      this.drawnBase === base && this.canvas.width === width && this.canvas.height === height;
    if (unchanged) return;
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const t = this.transform;
    ctx.setTransform(t.a * dpr, t.b * dpr, t.c * dpr, t.d * dpr, t.e * dpr, t.f * dpr);
    ctx.drawImage(capture.image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawnBase = base;
  }

  private renderOverlay(): void {
    const pending = this.pending;
    if (!pending) return;
    const t = this.transform;
    const scale = affineScale(t);
    const centre = applyAffine(t, { x: pending.cx, y: pending.cy });
    // On screen the frame is turned by (angle - base): the display already
    // undoes the base angle, only the fine skew remains.
    const skew = pending.angle - baseAngle(pending.angle);
    const w = pending.width * scale;
    const h = pending.height * scale;
    this.frameGroup.setAttribute(
      'transform',
      `translate(${centre.x} ${centre.y}) rotate(${degrees(skew)})`,
    );
    this.frameRect.setAttribute('x', String(-w / 2));
    this.frameRect.setAttribute('y', String(-h / 2));
    this.frameRect.setAttribute('width', String(w));
    this.frameRect.setAttribute('height', String(h));
    const showHandles = this.mode === 'crop';
    for (const [handle, circle] of this.handles) {
      const local = handleLocalPosition(pending, handle);
      circle.setAttribute('cx', String(local.x * scale));
      circle.setAttribute('cy', String(local.y * scale));
      circle.setAttribute('visibility', showHandles ? 'visible' : 'hidden');
    }
    // Dim everything outside the frame.
    const viewBox = this.overlay.viewBox.baseVal;
    const corners = frameCorners(pending).map((p) => applyAffine(t, p));
    const outer = `M0 0H${viewBox.width}V${viewBox.height}H0Z`;
    const inner = corners.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('') + 'Z';
    this.shade.setAttribute('d', outer + inner);
  }

  private renderArc(): void {
    const drag = this.drag;
    const pending = this.pending;
    if (!drag || drag.kind !== 'rotate' || !pending) {
      this.arc.setAttribute('visibility', 'hidden');
      return;
    }
    const from = drag.startTouch;
    const to = from + (pending.angle - drag.startAngle);
    const { centreView: c, radius: r } = drag;
    if (Math.abs(to - from) < 1e-4 || r < 1) {
      this.arc.setAttribute('visibility', 'hidden');
      return;
    }
    const p0 = { x: c.x + r * Math.cos(from), y: c.y + r * Math.sin(from) };
    const p1 = { x: c.x + r * Math.cos(to), y: c.y + r * Math.sin(to) };
    const sweep = to > from ? 1 : 0;
    this.arc.setAttribute('d', `M${p0.x} ${p0.y}A${r} ${r} 0 0 ${sweep} ${p1.x} ${p1.y}`);
    this.arc.setAttribute('visibility', 'visible');
  }

  // ---- pointer input ---------------------------------------------------

  private viewPoint(event: PointerEvent): Point {
    const rect = this.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown(event: PointerEvent): void {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending || this.drag || !event.isPrimary) return;
    const view = this.viewPoint(event);
    const image = applyAffine(invertAffine(this.transform), view);
    if (this.mode === 'rotate') {
      const centreView = applyAffine(this.transform, { x: pending.cx, y: pending.cy });
      this.drag = {
        kind: 'rotate',
        startAngle: pending.angle,
        base: baseAngle(pending.angle),
        startTouch: Math.atan2(view.y - centreView.y, view.x - centreView.x),
        centreView,
        radius: Math.hypot(view.x - centreView.x, view.y - centreView.y),
      };
    } else {
      const local = toFrameLocal(pending, image);
      const handle = hitHandle(pending, local, HANDLE_HIT_RADIUS / affineScale(this.transform));
      if (handle) {
        this.drag = { kind: 'resize', start: pending, handle, startLocal: local };
      } else if (insideFrame(pending, local)) {
        this.drag = { kind: 'move', start: pending, startImage: image };
      } else {
        return;
      }
    }
    this.stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    const capture = this.capture;
    if (!drag || !capture || !event.isPrimary) return;
    const view = this.viewPoint(event);
    const { width, height } = capture.image;
    if (drag.kind === 'rotate') {
      const touch = Math.atan2(view.y - drag.centreView.y, view.x - drag.centreView.x);
      let delta = touch - drag.startTouch;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      const angle = clampSkew(drag.startAngle + delta, drag.base);
      this.pending = { ...this.pending!, angle };
      this.renderArc();
    } else {
      const image = applyAffine(invertAffine(this.transform), view);
      if (drag.kind === 'move') {
        this.pending = moveFrame(
          drag.start,
          image.x - drag.startImage.x,
          image.y - drag.startImage.y,
          width,
          height,
        );
      } else {
        const local = toFrameLocal(drag.start, image);
        this.pending = resizeFrame(
          drag.start,
          drag.handle,
          local.x - drag.startLocal.x,
          local.y - drag.startLocal.y,
          width,
          height,
        );
      }
    }
    this.renderOverlay();
    event.preventDefault();
  }

  private onPointerEnd(event: PointerEvent): void {
    if (!this.drag || !event.isPrimary) return;
    this.drag = null;
    this.renderArc();
    if (this.stage.hasPointerCapture(event.pointerId)) {
      this.stage.releasePointerCapture(event.pointerId);
    }
  }
}
