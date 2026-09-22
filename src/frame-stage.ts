/**
 * The zoomable stage of the captured view and the brightness/contrast view:
 * the frame region of a capture letterboxed into the stage, drawn
 * from the full-resolution image through the composed transform, with a
 * pinch/pan/double-tap zoom in front of it. One finger pans while zoomed in;
 * in the fitted view one-finger pointers are handed to the owner (the page
 * swipe of the captured view).
 *
 * The canvas has the stage's size in device pixels and shows only the
 * visible part of the image, so memory does not grow with the zoom level.
 */

import type { Capture } from './model';
import { affineScale, applyAffine, boundsOf, frameSourceRect, type Rect } from './geometry';
import { displayDpr, drawImageThrough, releaseCanvas, sizeDisplayCanvas } from './canvas';
import { ZoomGesture } from './zoom-gesture';
import { composeZoom, fitRectTransform, maxZoomScale, type ZoomState } from './zoom';

export interface FrameStageCallbacks {
  /** A one-finger pointer in the fitted view (not taken by the zoom). */
  onPointerDown?(event: PointerEvent): void;
  onPointerEnd?(event: PointerEvent): void;
  /** The zoom took over the pointers: the owner drops its own interaction. */
  onGestureStart?(): void;
}

export class FrameStage {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly gesture: ZoomGesture;

  private capture: Capture | null = null;
  private drawn: { width: number; height: number; capture: Capture; zoom: ZoomState } | null = null;
  private observer: ResizeObserver | null = null;

  constructor(
    canvasClass: string,
    private readonly callbacks: FrameStageCallbacks = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = canvasClass;
    const wrapper = document.createElement('div');
    wrapper.className = 'zoom-wrapper';
    wrapper.append(this.canvas);
    this.element = document.createElement('div');
    this.element.className = 'captured-stage';
    this.element.append(wrapper);

    this.gesture = new ZoomGesture({
      stage: this.element,
      wrapper,
      oneFingerPan: () => true,
      bounds: () => this.bounds(),
      onGestureStart: () => this.callbacks.onGestureStart?.(),
      onChange: () => {},
      onSettle: () => this.layout(),
    });

    this.element.addEventListener('pointerdown', (event) => {
      if (this.gesture.pointerDown(event)) return;
      this.callbacks.onPointerDown?.(event);
    });
    this.element.addEventListener('pointermove', (event) => {
      this.gesture.pointerMove(event);
    });
    const end = (event: PointerEvent): void => {
      if (this.gesture.pointerEnd(event)) return;
      this.callbacks.onPointerEnd?.(event);
    };
    this.element.addEventListener('pointerup', end);
    this.element.addEventListener('pointercancel', end);

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.element);
    }
  }

  /** Shows a capture in the fitted view (the zoom resets) and draws it if the stage has a size. */
  show(capture: Capture): void {
    this.capture = capture;
    this.drawn = null;
    this.gesture.reset();
    this.layout();
  }

  /** Drops the display copy and the zoom. */
  clear(): void {
    this.capture = null;
    this.drawn = null;
    this.gesture.reset();
    releaseCanvas(this.canvas);
  }

  /** Releases the stage for good: stops observing its size. */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Back to the fitted view without changing the capture. */
  resetZoom(): void {
    if (!this.gesture.zoomed && !this.gesture.active) return;
    this.gesture.reset();
    this.layout();
  }

  /** The zoom state, for tests. */
  get zoom(): ZoomState {
    return this.gesture.state;
  }

  private fitted(): ReturnType<typeof fitRectTransform> | null {
    const capture = this.capture;
    const viewW = this.element.clientWidth;
    const viewH = this.element.clientHeight;
    if (!capture || viewW === 0 || viewH === 0) return null;
    return fitRectTransform(frameSourceRect(capture.frame), viewW, viewH);
  }

  private bounds(): { content: Rect; maxScale: number } | null {
    const capture = this.capture;
    const fitted = this.fitted();
    if (!capture || !fitted) return null;
    const src = frameSourceRect(capture.frame);
    const content = boundsOf(
      [
        { x: src.x, y: src.y },
        { x: src.x + src.width, y: src.y + src.height },
      ].map((p) => applyAffine(fitted, p)),
    );
    return { content, maxScale: maxZoomScale(affineScale(fitted), displayDpr()) };
  }

  /** Draws the visible part of the frame region at the current zoom; cheap when nothing changed. */
  layout(): void {
    const capture = this.capture;
    const fitted = this.fitted();
    if (!capture || !fitted) return;
    this.gesture.clamp();
    const viewW = this.element.clientWidth;
    const viewH = this.element.clientHeight;
    const zoom = this.gesture.state;
    const dpr = displayDpr();
    const resized = sizeDisplayCanvas(this.canvas, viewW, viewH, dpr);
    const d = this.drawn;
    const unchanged =
      !resized &&
      d !== null &&
      d.capture === capture &&
      d.width === viewW &&
      d.height === viewH &&
      d.zoom.scale === zoom.scale &&
      d.zoom.tx === zoom.tx &&
      d.zoom.ty === zoom.ty;
    if (unchanged) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    drawImageThrough(ctx, capture.image, composeZoom(zoom, fitted), viewW, viewH, dpr, frameSourceRect(capture.frame));
    this.drawn = { width: viewW, height: viewH, capture, zoom: { ...zoom } };
    this.gesture.drawn();
  }
}
