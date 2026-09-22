/**
 * Pinch zoom maths (see intent/v0.9-zoom.md): a similarity transform
 * in CSS pixels of the stage, applied on top of a view's fitted transform.
 * Pure functions, no DOM; the gesture tracking lives in `zoom-gesture.ts`.
 *
 * `scale` 1 with zero translation is the fitted view. Composed display
 * transform: `zoom ∘ fitted`, image pixel -> CSS pixel of the stage.
 */

import { MAX_DEVICE_PIXELS_PER_IMAGE_PIXEL } from './canvas';
import { EPSILON, type Affine, type Point, type Rect } from './geometry';

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

/** The fitted view. */
export const IDENTITY_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** Upper bound of `scale` regardless of the image resolution. */
export const MAX_ZOOM = 8;
/** Zoom a double tap goes to from the fitted view (or the maximum, if lower). */
export const DOUBLE_TAP_ZOOM = 3;
/** Two taps this close in time and space toggle the zoom. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_RADIUS = 24;
/** A pointer that travels less than this counts as a tap without movement. */
export const TAP_SLOP = 10;

export function isFittedZoom(z: ZoomState): boolean {
  return z.scale <= 1 + EPSILON;
}

/**
 * The largest useful `scale` for a view whose fitted transform shows one
 * image pixel at `fittedScale` CSS pixels: 8, or less when one image pixel
 * would cover more than two device pixels (the loupe cap; beyond it the view
 * shows blur, not detail). Never below 1.
 */
export function maxZoomScale(fittedScale: number, devicePixelRatio: number): number {
  const cap = MAX_DEVICE_PIXELS_PER_IMAGE_PIXEL / (devicePixelRatio * fittedScale);
  return Math.max(1, Math.min(MAX_ZOOM, cap));
}

export function applyZoom(z: ZoomState, p: Point): Point {
  return { x: z.scale * p.x + z.tx, y: z.scale * p.y + z.ty };
}

/** `zoom ∘ fitted`: image pixel -> CSS pixel of the zoomed stage. */
export function composeZoom(z: ZoomState, fitted: Affine): Affine {
  return {
    a: fitted.a * z.scale,
    b: fitted.b * z.scale,
    c: fitted.c * z.scale,
    d: fitted.d * z.scale,
    e: fitted.e * z.scale + z.tx,
    f: fitted.f * z.scale + z.ty,
  };
}

/**
 * The zoom `state` expressed relative to the zoom `drawn` into the stage
 * canvas: `state ∘ drawn⁻¹`, the CSS transform that shows the drawn canvas
 * at the live state during a gesture.
 */
export function relativeZoom(state: ZoomState, drawn: ZoomState): ZoomState {
  const scale = state.scale / drawn.scale;
  return { scale, tx: state.tx - scale * drawn.tx, ty: state.ty - scale * drawn.ty };
}

/**
 * The pinch update: the similarity that maps the two fingers' previous
 * positions `from` to their current positions `to` (scale by the ratio of
 * the distances, the midpoint follows the fingers; rotation of the pair is
 * ignored). The scale is limited to [1, maxScale] with the midpoint still
 * fixed, so a pinch at the cap does not drift. The translation is not
 * clamped here; see `clampZoom`.
 */
export function pinchZoom(
  z: ZoomState,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
  maxScale = MAX_ZOOM,
): ZoomState {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const wanted = d0 < EPSILON ? z.scale : (z.scale * d1) / d0;
  const scale = Math.min(Math.max(wanted, 1), Math.max(1, maxScale));
  const ratio = scale / z.scale;
  const mid0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const mid1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  return {
    scale,
    tx: ratio * (z.tx - mid0.x) + mid1.x,
    ty: ratio * (z.ty - mid0.y) + mid1.y,
  };
}

/** A one-finger pan by (dx, dy) CSS pixels; not clamped. */
export function panZoom(z: ZoomState, dx: number, dy: number): ZoomState {
  return { scale: z.scale, tx: z.tx + dx, ty: z.ty + dy };
}

function clampAxis(t: number, start: number, length: number, scale: number, stage: number): number {
  const size = length * scale;
  if (size <= stage + EPSILON) {
    // Smaller than the stage: centred.
    return stage / 2 - (start + length / 2) * scale;
  }
  const min = stage - (start + length) * scale;
  const max = -start * scale;
  return Math.min(Math.max(t, min), max) || 0; // no negative zero
}

/**
 * The pan limits: `scale` in [1, maxScale]; at 1 the fitted view (no rubber
 * band); above 1 the content (a rectangle in fitted CSS pixels) must cover
 * the stage on each axis, or is centred on that axis when it is smaller.
 */
export function clampZoom(
  z: ZoomState,
  content: Rect,
  stageWidth: number,
  stageHeight: number,
  maxScale = MAX_ZOOM,
): ZoomState {
  const scale = Math.min(Math.max(z.scale, 1), Math.max(1, maxScale));
  if (scale <= 1 + EPSILON) return { ...IDENTITY_ZOOM };
  return {
    scale,
    tx: clampAxis(z.tx, content.x, content.width, scale, stageWidth),
    ty: clampAxis(z.ty, content.y, content.height, scale, stageHeight),
  };
}

/**
 * The double tap: from the fitted view to 3x (or the maximum) with the
 * tapped point kept under the finger, otherwise back to the fitted view.
 * Not clamped.
 */
export function doubleTapZoom(z: ZoomState, at: Point, maxScale = MAX_ZOOM): ZoomState {
  if (!isFittedZoom(z)) return { ...IDENTITY_ZOOM };
  const scale = Math.max(1, Math.min(DOUBLE_TAP_ZOOM, maxScale));
  return { scale, tx: at.x * (1 - scale), ty: at.y * (1 - scale) };
}

/** The fitted transform of a rectangle of image pixels letterboxed into a stage. */
export function fitRectTransform(rect: Rect, stageWidth: number, stageHeight: number): Affine {
  const scale = Math.min(stageWidth / rect.width, stageHeight / rect.height);
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: (stageWidth - rect.width * scale) / 2 - rect.x * scale,
    f: (stageHeight - rect.height * scale) / 2 - rect.y * scale,
  };
}

/** True when two zoom states are the same within rounding. */
export function sameZoom(a: ZoomState, b: ZoomState): boolean {
  return Math.abs(a.scale - b.scale) < EPSILON && Math.abs(a.tx - b.tx) < EPSILON && Math.abs(a.ty - b.ty) < EPSILON;
}
