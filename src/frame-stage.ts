/**
 * The stage of the captured view and the brightness/contrast view: the frame
 * region of a capture letterboxed into a `ZoomStage` (`zoom-stage.ts`), which
 * owns the canvas, the pinch/pan/double-tap zoom and the redraw. One finger
 * pans while zoomed in; in the fitted view one-finger pointers are handed to
 * the owner (the page swipe of the captured view).
 */

import type { Capture } from './model';
import { applyAffine, boundsOf, frameSourceRect, type Affine, type Rect } from './geometry';
import type { ZoomGesture } from './zoom-gesture';
import { fitRectTransform, type ZoomState } from './zoom';
import { ZoomStage } from './zoom-stage';

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

  private readonly stage: ZoomStage;
  private capture: Capture | null = null;

  constructor(canvasClass: string, callbacks: FrameStageCallbacks = {}) {
    this.stage = new ZoomStage({
      stageClass: 'captured-stage',
      canvasClass,
      fitted: (viewW, viewH) => this.fitted(viewW, viewH),
      content: (fitted) => this.content(fitted),
      clip: () => (this.capture ? frameSourceRect(this.capture.frame) : undefined),
      onGestureStart: () => callbacks.onGestureStart?.(),
      onPointerDown: (event) => callbacks.onPointerDown?.(event),
      onPointerEnd: (event) => callbacks.onPointerEnd?.(event),
    });
    this.element = this.stage.element;
    this.canvas = this.stage.canvas;
    this.gesture = this.stage.gesture;
  }

  /** Shows a capture in the fitted view (the zoom resets) and draws it if the stage has a size. */
  show(capture: Capture): void {
    this.capture = capture;
    this.stage.show(capture.image);
  }

  /** Drops the display copy and the zoom. */
  clear(): void {
    this.capture = null;
    this.stage.clear();
  }

  /** Releases the stage for good: stops observing its size. */
  dispose(): void {
    this.stage.dispose();
  }

  /** Back to the fitted view without changing the capture. */
  resetZoom(): void {
    this.stage.resetZoom();
  }

  /** Draws the visible part of the frame region at the current zoom; cheap when nothing changed. */
  layout(): void {
    this.stage.layout();
  }

  /** The zoom state, for tests. */
  get zoom(): ZoomState {
    return this.stage.zoom;
  }

  /** The frame region letterboxed into the stage. */
  private fitted(viewW: number, viewH: number): Affine | null {
    const capture = this.capture;
    if (!capture) return null;
    return fitRectTransform(frameSourceRect(capture.frame), viewW, viewH);
  }

  /** What the zoom must keep on the stage: the frame region in fitted CSS pixels. */
  private content(fitted: Affine): Rect {
    const capture = this.capture;
    if (!capture) return { x: 0, y: 0, width: 0, height: 0 };
    const src = frameSourceRect(capture.frame);
    return boundsOf(
      [
        { x: src.x, y: src.y },
        { x: src.x + src.width, y: src.y + src.height },
      ].map((p) => applyAffine(fitted, p)),
    );
  }
}
