/**
 * Crop/rotate view (v0.2): the full captured image with the frame at its
 * stored geometry. Crop drags and fine rotation only change a pending copy of
 * the frame; the caller bakes the rotation on confirm.
 *
 * Display: the image is turned by the frame's base angle (multiples of 90°),
 * so 90° taps are visible, and letterboxed into the stage. During fine
 * rotation the image stays still and only the frame turns (decision 2026-09-22).
 *
 * Loupes (v0.6): while a drag is in progress, magnified views of the affected
 * frame corners sit in the centre of the stage (`LoupeCluster` in
 * `loupe-cluster.ts`, geometry in `loupe.ts`).
 *
 * Shear (v0.7): in crop mode the corner handles move each frame corner on its
 * own while the edge handles keep cropping the underlying rectangle; the frame
 * is drawn as that quadrilateral in both modes and the caller warps the image
 * on confirm. The frame body cannot be dragged.
 *
 * Auto (v0.8): the wand button looks for the paper edges near the frame
 * (`detect.ts`) and replaces the pending frame with what it found; nothing
 * found shows the notice and leaves the frame alone.
 *
 * Zoom (v0.9): a two-finger pinch zooms and pans the stage, and a second
 * finger cancels the drag in progress. Zoomed in, one finger pans too, but
 * only in crop mode and only when it lands clear of every handle's touch
 * target: the handles keep priority, and in rotate mode one finger always
 * rotates. `transform` is the composed `zoom ∘ fitted` transform,
 * so hit tests, handles, shade and loupes need no zoom-specific code. During
 * a gesture the canvas moves with a CSS transform on its wrapper and the
 * overlay is recomputed per move; on release the canvas is redrawn crisply.
 */

import * as icons from './icons';
import type { Capture, Frame } from './model';
import {
  affineScale,
  applyAffine,
  baseAngle,
  boundsOf,
  clampSkew,
  CORNER_HANDLES,
  HANDLES,
  handleLocalPosition,
  hitHandle,
  invertAffine,
  mapQuad,
  moveCorner,
  quadCorners,
  quadLocalCorners,
  resizeFrame,
  rotate90Right,
  toFrameLocal,
  viewTransform,
  type Affine,
  type Handle,
  type Point,
  type Rect,
} from './geometry';
import { displayDpr, drawImageThrough, releaseCanvas, sizeDisplayCanvas } from './canvas';
import { detectFrameIn } from './detect';
import { loupeScale } from './loupe';
import { LoupeCluster } from './loupe-cluster';
import { iconButton, segmentButton, svgEl } from './ui';
import { ZoomGesture } from './zoom-gesture';
import { composeZoom, maxZoomScale, sameZoom, type ZoomState } from './zoom';

export type EditMode = 'crop' | 'rotate';

const MODES: readonly EditMode[] = ['crop', 'rotate'];

export interface EditorCallbacks {
  /** Back: discard the pending frame. */
  onCancel(): void;
  /** Confirm with the pending frame (angle or corner offsets may be non-zero: the caller bakes them). */
  onConfirm(frame: Frame): void;
  /** Auto-detect found nothing usable: show the brief warning notice. */
  onNotice(): void;
}

/** Touch target radius of a crop handle in CSS pixels (44 px target). */
const HANDLE_HIT_RADIUS = 22;
/** Drawn handle radius in CSS pixels. */
const HANDLE_RADIUS = 9;


type Drag =
  | { kind: 'resize'; start: Frame; handle: Handle; startLocal: Point }
  | { kind: 'shear'; start: Frame; corner: Handle; startLocal: Point }
  | { kind: 'rotate'; startAngle: number; base: number; startTouch: number; centreView: Point; radius: number };

const degrees = (radians: number): number => (radians * 180) / Math.PI;

export class CropRotateView {
  readonly element: HTMLElement;

  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: SVGSVGElement;
  private readonly shade: SVGPathElement;
  private readonly frameGroup: SVGGElement;
  private readonly framePolygon: SVGPolygonElement;
  private readonly handles: Map<Handle, SVGCircleElement>;
  private readonly arc: SVGPathElement;
  private readonly modeButtons: Record<EditMode, HTMLButtonElement>;
  private readonly loupes: LoupeCluster;
  private readonly gesture: ZoomGesture;
  private readonly resizeObserver: ResizeObserver | null;

  private capture: Capture | null = null;
  private pending: Frame | null = null;
  private mode: EditMode = 'crop';
  /** The fitted view: image turned by the base angle and letterboxed. */
  private fitted: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  /** The composed display transform `zoom ∘ fitted` (image pixel -> CSS pixel). */
  private transform: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  /** Base angle and zoom the display canvas was last drawn with. */
  private drawnBase: number | null = null;
  private drawnZoom: ZoomState | null = null;
  private drag: Drag | null = null;

  constructor(private readonly callbacks: EditorCallbacks) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'edit-canvas';
    const wrapper = document.createElement('div');
    wrapper.className = 'zoom-wrapper';
    wrapper.append(this.canvas);

    this.overlay = svgEl('svg', { class: 'edit-overlay' });
    this.overlay.setAttribute('aria-hidden', 'true');
    this.shade = svgEl('path', { class: 'edit-shade', 'fill-rule': 'evenodd' });
    this.frameGroup = svgEl('g');
    this.framePolygon = svgEl('polygon', { class: 'edit-frame' });
    this.frameGroup.append(this.framePolygon);
    this.handles = new Map();
    for (const handle of HANDLES) {
      const circle = svgEl('circle', { class: 'edit-handle', r: String(HANDLE_RADIUS) });
      this.handles.set(handle, circle);
      this.frameGroup.append(circle);
    }
    this.arc = svgEl('path', { class: 'edit-arc' });
    this.arc.setAttribute('visibility', 'hidden');
    this.overlay.append(this.shade, this.frameGroup, this.arc);

    this.loupes = new LoupeCluster();

    this.stage = document.createElement('div');
    this.stage.className = 'edit-stage';
    this.stage.append(wrapper, this.overlay, this.loupes.element);
    this.gesture = new ZoomGesture({
      stage: this.stage,
      wrapper,
      oneFingerPan: (at) => this.mode === 'crop' && this.handleAt(at) === null,
      bounds: () => this.zoomBounds(),
      onGestureStart: () => this.cancelDrag(),
      onChange: () => this.onZoomChange(),
      onSettle: () => this.layout(),
    });
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
      ['crop', icons.shear, 'Zuschneiden und entzerren'],
      ['rotate', icons.rotate, 'Drehen'],
    ];
    for (const [mode, icon, label] of modes) {
      const button = segmentButton(icon, label, () => this.setMode(mode));
      this.modeButtons[mode] = button;
      segmented.append(button);
    }

    const rotate90 = iconButton(icons.rotate90Right, 'Um 90° nach rechts drehen', 'compact');
    rotate90.addEventListener('click', () => this.rotate90());
    const auto = iconButton(icons.magicWand, 'Automatisch erkennen', 'compact');
    auto.addEventListener('click', () => this.autoDetect());
    const confirm = iconButton(icons.check, 'Bestätigen', 'primary compact');
    confirm.addEventListener('click', () => this.confirm());

    const bar = document.createElement('div');
    bar.className = 'button-bar button-bar-compact';
    bar.append(back, segmented, rotate90, auto, confirm);

    this.element = document.createElement('section');
    this.element.className = 'screen screen-edit';
    this.element.append(this.stage, bar);
    this.element.hidden = true;

    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layout()) : null;
    this.resizeObserver?.observe(this.stage);
  }

  /** Shows the capture with a fresh pending copy of its frame, in crop mode. */
  open(capture: Capture): void {
    this.capture = capture;
    this.pending = { ...capture.frame };
    if (capture.frame.corners) {
      this.pending.corners = mapQuad(capture.frame.corners, (p) => ({ ...p }));
    }
    this.mode = 'crop';
    this.drag = null;
    this.drawnBase = null;
    this.drawnZoom = null;
    this.gesture.reset();
    this.element.hidden = false;
    this.renderMode();
    this.layout();
  }

  /** The zoom state, for tests. */
  get zoom(): ZoomState {
    return this.gesture.state;
  }

  /** Hides the view and drops the display copy. Never touches the capture. */
  close(): void {
    this.element.hidden = true;
    this.capture = null;
    this.pending = null;
    this.drag = null;
    this.drawnBase = null;
    this.drawnZoom = null;
    this.gesture.reset();
    releaseCanvas(this.canvas);
    this.loupes.release();
  }

  /** Releases what outlives `close`: the resize observer and the loupe canvases. */
  dispose(): void {
    this.close();
    this.resizeObserver?.disconnect();
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
    // The base rotation changes: back to the fitted view.
    this.gesture.reset();
    this.layout();
  }

  /**
   * Presets the pending frame to the paper edges found near it. Synchronous
   * (well under 200 ms at 800 px), so no busy overlay. The detection ignores
   * pending corner offsets and replaces them.
   */
  private autoDetect(): void {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending || this.drag) return;
    let detected: Frame | null;
    try {
      detected = detectFrameIn(capture.image, pending, capture.image.width);
    } catch (error) {
      console.error('Automatische Erkennung fehlgeschlagen', error);
      detected = null;
    }
    if (!detected) {
      this.callbacks.onNotice();
      return;
    }
    this.pending = detected;
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
    for (const mode of MODES) {
      this.modeButtons[mode].setAttribute('aria-checked', String(mode === this.mode));
    }
    this.stage.dataset.mode = this.mode;
  }

  // ---- display ---------------------------------------------------------

  /**
   * Recomputes the fitted and composed transforms for the current stage
   * size, base angle and zoom (re-clamped), then redraws.
   */
  layout(): void {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending || this.element.hidden) return;
    const viewW = this.stage.clientWidth;
    const viewH = this.stage.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    const base = baseAngle(pending.angle);
    const { image } = capture;
    this.fitted = viewTransform(image.width, image.height, base, viewW, viewH);
    this.gesture.clamp();
    this.transform = composeZoom(this.gesture.state, this.fitted);
    this.overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    this.drawImage(viewW, viewH, base);
    this.renderOverlay();
  }

  /** Draws the visible part of the image through the composed transform; skipped when nothing changed. */
  private drawImage(viewW: number, viewH: number, base: number): void {
    const capture = this.capture;
    if (!capture) return;
    const dpr = displayDpr();
    const zoom = this.gesture.state;
    const resized = sizeDisplayCanvas(this.canvas, viewW, viewH, dpr);
    const unchanged =
      !resized && this.drawnBase === base && this.drawnZoom !== null && sameZoom(this.drawnZoom, zoom);
    if (unchanged) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    drawImageThrough(ctx, capture.image, this.transform, viewW, viewH, dpr);
    this.drawnBase = base;
    this.drawnZoom = { ...zoom };
    this.gesture.drawn();
  }

  // ---- zoom (v0.9) -----------------------------------------------------

  /**
   * What the zoom must keep on the stage: the image and the frame's bounding
   * box (the frame may stick out of the image after rotation), in fitted
   * CSS pixels; and the largest useful scale.
   */
  private zoomBounds(): { content: Rect; maxScale: number } | null {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending) return null;
    const { width, height } = capture.image;
    const points = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
      ...quadCorners(pending),
    ].map((p) => applyAffine(this.fitted, p));
    return { content: boundsOf(points), maxScale: maxZoomScale(affineScale(this.fitted), displayDpr()) };
  }

  /** Live update during a pinch: only the overlay is recomputed; the canvas moves by CSS. */
  private onZoomChange(): void {
    this.transform = composeZoom(this.gesture.state, this.fitted);
    this.renderOverlay();
  }

  /** A second finger landed (or the zoom took over): the one-finger drag ends where it is. */
  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.renderArc();
    this.loupes.hide();
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
    this.frameGroup.setAttribute(
      'transform',
      `translate(${centre.x} ${centre.y}) rotate(${degrees(skew)})`,
    );
    // The frame is the quadrilateral of the (possibly displaced) corners, in
    // frame-local coordinates scaled to CSS pixels.
    this.framePolygon.setAttribute(
      'points',
      quadLocalCorners(pending)
        .map((p) => `${p.x * scale},${p.y * scale}`)
        .join(' '),
    );
    const visibleHandles: readonly Handle[] = this.mode === 'crop' ? HANDLES : [];
    for (const [handle, circle] of this.handles) {
      const local = handleLocalPosition(pending, handle);
      circle.setAttribute('cx', String(local.x * scale));
      circle.setAttribute('cy', String(local.y * scale));
      circle.setAttribute('visibility', visibleHandles.includes(handle) ? 'visible' : 'hidden');
    }
    // Dim everything outside the frame.
    const viewBox = this.overlay.viewBox.baseVal;
    const corners = quadCorners(pending).map((p) => applyAffine(t, p));
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

  /** The handle whose 44 px touch target contains the stage point, in the composed view. */
  private handleAt(view: Point): Handle | null {
    const pending = this.pending;
    if (!pending) return null;
    const image = applyAffine(invertAffine(this.transform), view);
    return hitHandle(pending, toFrameLocal(pending, image), HANDLE_HIT_RADIUS / affineScale(this.transform));
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.gesture.pointerDown(event)) return;
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
      // Corners shear (each corner on its own), edges crop the rectangle.
      const local = toFrameLocal(pending, image);
      const handle = this.handleAt(view);
      if (!handle) return;
      if (CORNER_HANDLES.includes(handle)) {
        this.drag = { kind: 'shear', start: pending, corner: handle, startLocal: local };
      } else {
        this.drag = { kind: 'resize', start: pending, handle, startLocal: local };
      }
    }
    this.beginLoupes(this.drag, view);
    this.stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.gesture.pointerMove(event)) return;
    const drag = this.drag;
    const capture = this.capture;
    const pending = this.pending;
    if (!drag || !capture || !pending || !event.isPrimary) return;
    const view = this.viewPoint(event);
    const { width, height } = capture.image;
    if (drag.kind === 'rotate') {
      const touch = Math.atan2(view.y - drag.centreView.y, view.x - drag.centreView.x);
      let delta = touch - drag.startTouch;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      const angle = clampSkew(drag.startAngle + delta, drag.base);
      this.pending = { ...pending, angle };
      this.renderArc();
    } else {
      const image = applyAffine(invertAffine(this.transform), view);
      if (drag.kind === 'shear') {
        const local = toFrameLocal(drag.start, image);
        this.pending = moveCorner(
          drag.start,
          drag.corner,
          local.x - drag.startLocal.x,
          local.y - drag.startLocal.y,
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
    this.renderLoupes();
    event.preventDefault();
  }

  private onPointerEnd(event: PointerEvent): void {
    if (this.gesture.pointerEnd(event)) return;
    if (!this.drag || !event.isPrimary) return;
    this.drag = null;
    this.renderArc();
    this.loupes.hide();
    if (this.stage.hasPointerCapture(event.pointerId)) {
      this.stage.releasePointerCapture(event.pointerId);
    }
  }

  // ---- loupes (v0.6) ---------------------------------------------------

  /** Hands the drag to the cluster: which corners to magnify, where, and at what scales. */
  private beginLoupes(drag: Drag, startView: Point): void {
    const kind = drag.kind === 'resize' ? drag.handle : drag.kind === 'shear' ? drag.corner : drag.kind;
    this.loupes.begin(
      kind,
      this.stage.clientWidth,
      this.stage.clientHeight,
      startView,
      affineScale(this.transform),
      this.loupeScale(),
    );
  }

  private renderLoupes(): void {
    const capture = this.capture;
    const pending = this.pending;
    if (!capture || !pending) return;
    this.loupes.render(capture.image, pending, this.loupeScale());
  }

  /** CSS pixels per image pixel inside a loupe: three times the fitted view scale, capped. */
  private loupeScale(): number {
    return loupeScale(affineScale(this.fitted), displayDpr());
  }

  /** Test hook: the CSS-pixel bounds of the visible cluster, or null. */
  get visibleLoupeBounds(): Rect | null {
    return this.loupes.visibleBounds;
  }
}
