/**
 * The zoomable stage shared by the captured view, the brightness/contrast
 * view (through `FrameStage`) and the crop/rotate view: a canvas inside a
 * `.zoom-wrapper`, the `ZoomGesture` in front of it, a `ResizeObserver` on
 * the stage element, and the crisp redraw of the visible part of the image
 * through the composed transform `zoom ∘ fitted`. The owner says how the
 * image is fitted into the stage (`fitted`), which content the zoom must
 * keep on the stage (`content`) and, optionally, which image rectangle is
 * shown at all (`clip`); pointer events the zoom does not consume are handed
 * back to the owner. DOM: owns its elements and the canvas drawing.
 *
 * The canvas has the stage's size in device pixels and shows only the
 * visible part of the image, so memory does not grow with the zoom level. A
 * redraw is skipped while the image, the fitted transform, the zoom and the
 * stage size are unchanged.
 */

import { affineScale, type Affine, type Point, type Rect } from './geometry';
import { displayDpr, drawImageThrough, releaseCanvas, sizeDisplayCanvas } from './canvas';
import { ZoomGesture } from './zoom-gesture';
import { composeZoom, maxZoomScale, sameZoom, type ZoomState } from './zoom';

const IDENTITY_AFFINE: Readonly<Affine> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

function sameAffine(p: Affine, q: Affine): boolean {
  return p.a === q.a && p.b === q.b && p.c === q.c && p.d === q.d && p.e === q.e && p.f === q.f;
}

export interface ZoomStageOptions {
  /** Class of the stage element (`captured-stage`, `edit-stage`). */
  stageClass: string;
  /** Class of the canvas inside the wrapper. */
  canvasClass: string;
  /** The fitted transform (image pixel -> CSS pixel) for a stage of the given size; null while nothing can be shown. */
  fitted(viewWidth: number, viewHeight: number): Affine | null;
  /** The content the zoom must keep on the stage, in fitted CSS pixels. */
  content(fitted: Affine): Rect;
  /** The image rectangle that is drawn at all (image pixels); the whole image by default. */
  clip?(): Rect | undefined;
  /** Whether one finger landing at `at` pans while zoomed in; always by default. */
  oneFingerPan?(at: Point): boolean;
  /** The zoom took over the pointers: the owner drops its own interaction. */
  onGestureStart?(): void;
  /** The zoom changed during a gesture; `transform` is already updated, the canvas moves by CSS. */
  onChange?(): void;
  /** A layout ran (the canvas may have been redrawn): the owner refreshes what it draws over the canvas. */
  onLayout?(): void;
  /** Pointer events the zoom did not consume. */
  onPointerDown?(event: PointerEvent): void;
  onPointerMove?(event: PointerEvent): void;
  onPointerEnd?(event: PointerEvent): void;
}

interface Drawn {
  image: HTMLCanvasElement;
  fitted: Affine;
  zoom: ZoomState;
}

export class ZoomStage {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly gesture: ZoomGesture;

  private image: HTMLCanvasElement | null = null;
  /** The fitted transform of the last layout; identity while nothing is shown. */
  private fittedTransform: Affine = IDENTITY_AFFINE;
  /** The composed display transform `zoom ∘ fitted`. */
  private composed: Affine = IDENTITY_AFFINE;
  private drawn: Drawn | null = null;
  private observer: ResizeObserver | null = null;

  constructor(private readonly options: ZoomStageOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = options.canvasClass;
    const wrapper = document.createElement('div');
    wrapper.className = 'zoom-wrapper';
    wrapper.append(this.canvas);
    this.element = document.createElement('div');
    this.element.className = options.stageClass;
    this.element.append(wrapper);

    this.gesture = new ZoomGesture({
      stage: this.element,
      wrapper,
      oneFingerPan: (at) => options.oneFingerPan?.(at) ?? true,
      bounds: () => this.bounds(),
      onGestureStart: () => options.onGestureStart?.(),
      onChange: () => this.onZoomChange(),
      onSettle: () => this.layout(),
    });

    this.element.addEventListener('pointerdown', (event) => {
      if (this.gesture.pointerDown(event)) return;
      options.onPointerDown?.(event);
    });
    this.element.addEventListener('pointermove', (event) => {
      if (this.gesture.pointerMove(event)) return;
      options.onPointerMove?.(event);
    });
    const end = (event: PointerEvent): void => {
      if (this.gesture.pointerEnd(event)) return;
      options.onPointerEnd?.(event);
    };
    this.element.addEventListener('pointerup', end);
    this.element.addEventListener('pointercancel', end);

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.element);
    }
  }

  /** The fitted transform of the last layout (image pixel -> CSS pixel of the fitted view). */
  get fitted(): Affine {
    return this.fittedTransform;
  }

  /** The composed display transform `zoom ∘ fitted` (image pixel -> CSS pixel). */
  get transform(): Affine {
    return this.composed;
  }

  /** The zoom state. */
  get zoom(): ZoomState {
    return this.gesture.state;
  }

  /** Shows an image in the fitted view (the zoom resets) and draws it if the stage has a size. */
  show(image: HTMLCanvasElement): void {
    this.image = image;
    this.drawn = null;
    this.gesture.reset();
    this.layout();
  }

  /** Drops the image, the display copy and the zoom. */
  clear(): void {
    this.image = null;
    this.drawn = null;
    this.fittedTransform = IDENTITY_AFFINE;
    this.composed = IDENTITY_AFFINE;
    this.gesture.reset();
    releaseCanvas(this.canvas);
  }

  /** Releases the stage for good: stops observing its size. */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Back to the fitted view without changing the image. */
  resetZoom(): void {
    if (!this.gesture.zoomed && !this.gesture.active) return;
    this.gesture.reset();
    this.layout();
  }

  private bounds(): { content: Rect; maxScale: number } | null {
    if (!this.image) return null;
    const fitted = this.fittedTransform;
    return {
      content: this.options.content(fitted),
      maxScale: maxZoomScale(affineScale(fitted), displayDpr()),
    };
  }

  /** Live update during a pinch: the transform follows, the canvas moves by CSS. */
  private onZoomChange(): void {
    this.composed = composeZoom(this.gesture.state, this.fittedTransform);
    this.options.onChange?.();
  }

  /**
   * Recomputes the fitted and composed transforms for the current stage size
   * and zoom (re-clamped), redraws the canvas when something changed, and
   * tells the owner.
   */
  layout(): void {
    const image = this.image;
    const viewW = this.element.clientWidth;
    const viewH = this.element.clientHeight;
    if (!image || viewW === 0 || viewH === 0) return;
    const fitted = this.options.fitted(viewW, viewH);
    if (!fitted) return;
    this.fittedTransform = fitted;
    this.gesture.clamp();
    const zoom = this.gesture.state;
    this.composed = composeZoom(zoom, fitted);
    this.draw(image, fitted, zoom, viewW, viewH);
    this.options.onLayout?.();
  }

  /** Draws the visible part of the image through the composed transform; skipped when nothing changed. */
  private draw(image: HTMLCanvasElement, fitted: Affine, zoom: ZoomState, viewW: number, viewH: number): void {
    const dpr = displayDpr();
    const resized = sizeDisplayCanvas(this.canvas, viewW, viewH, dpr);
    const d = this.drawn;
    const unchanged =
      !resized && d !== null && d.image === image && sameAffine(d.fitted, fitted) && sameZoom(d.zoom, zoom);
    if (unchanged) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    drawImageThrough(ctx, image, this.composed, viewW, viewH, dpr, this.options.clip?.());
    this.drawn = { image, fitted, zoom: { ...zoom } };
    this.gesture.drawn();
  }
}
