/**
 * Pure geometry for the capture frame (see intent/v0.1-mvp.md "Data model").
 * No DOM access: everything here is plain number maths so it can be unit tested.
 */

import type { Frame } from './model';

/** Aspect ratio of the DIN A formats: height = width * SQRT2 in portrait. */
export const SQRT2 = Math.SQRT2;

/** Axis-aligned rectangle, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fraction of the captured image the initial frame occupies. */
const FRAME_FILL = 0.9;

/**
 * Initial DIN A frame for a freshly captured image:
 * 90 % of the image width, 1:sqrt2 portrait, reduced proportionally so that it
 * also stays within 90 % of the image height. Centred, unrotated.
 *
 * With `visible` (the part of the image the screen actually shows, see
 * `visibleImageRect`), the frame is fitted into that region instead, so the
 * dashes are always fully on screen. The margin outside the frame is then
 * whatever the capture holds beyond the screen, which is at least 10 %.
 */
export function initialFrame(imageWidth: number, imageHeight: number, visible?: Rect): Frame {
  const region: Rect = visible ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
  let width = FRAME_FILL * region.width;
  let height = width * SQRT2;
  const maxHeight = FRAME_FILL * region.height;
  if (height > maxHeight) {
    height = maxHeight;
    width = height / SQRT2;
  }
  return {
    cx: region.x + region.width / 2,
    cy: region.y + region.height / 2,
    width,
    height,
    angle: 0,
  };
}

/** Scales a frame from one image size to another (e.g. track size -> capture canvas size). */
export function scaleFrame(frame: Frame, factor: number): Frame {
  return {
    cx: frame.cx * factor,
    cy: frame.cy * factor,
    width: frame.width * factor,
    height: frame.height * factor,
    angle: frame.angle,
  };
}

/** iOS Safari caps canvases at roughly 16.7 M pixels; stay below that. */
export const MAX_CAPTURE_PIXELS = 16_000_000;

/**
 * Size of the capture canvas for a video track: the track's own size when it
 * fits under the canvas pixel cap, otherwise uniformly scaled down.
 */
export function captureSize(
  trackWidth: number,
  trackHeight: number,
  maxPixels = MAX_CAPTURE_PIXELS,
): { width: number; height: number } {
  const pixels = trackWidth * trackHeight;
  if (pixels <= maxPixels) {
    return { width: trackWidth, height: trackHeight };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  let width = Math.floor(trackWidth * scale);
  let height = Math.floor(trackHeight * scale);
  // Flooring can only shrink, but guard against rounding leaving us over the cap.
  while (width * height > maxPixels && (width > 1 || height > 1)) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * The transform that `object-fit: cover; object-position: center` applies.
 * A source point p maps to the view as `p * scale + offset`.
 */
export interface CoverTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Cover transform of a source of the given size displayed in the given view. */
export function coverTransform(
  srcWidth: number,
  srcHeight: number,
  viewWidth: number,
  viewHeight: number,
): CoverTransform {
  const scale = Math.max(viewWidth / srcWidth, viewHeight / srcHeight);
  return {
    scale,
    offsetX: (viewWidth - srcWidth * scale) / 2,
    offsetY: (viewHeight - srcHeight * scale) / 2,
  };
}

/**
 * The part of the source that is visible in the view under a cover transform,
 * in source coordinates (clipped to the source bounds).
 */
export function visibleImageRect(
  srcWidth: number,
  srcHeight: number,
  viewWidth: number,
  viewHeight: number,
): Rect {
  const t = coverTransform(srcWidth, srcHeight, viewWidth, viewHeight);
  const x = Math.max(0, -t.offsetX / t.scale);
  const y = Math.max(0, -t.offsetY / t.scale);
  return {
    x,
    y,
    width: Math.min(srcWidth, viewWidth / t.scale),
    height: Math.min(srcHeight, viewHeight / t.scale),
  };
}

/**
 * The frame as an axis-aligned rectangle in view coordinates.
 * `angle` is 0 in v0.1 and therefore ignored here.
 */
export function frameToViewRect(frame: Frame, t: CoverTransform): Rect {
  const width = frame.width * t.scale;
  const height = frame.height * t.scale;
  return {
    x: frame.cx * t.scale + t.offsetX - width / 2,
    y: frame.cy * t.scale + t.offsetY - height / 2,
    width,
    height,
  };
}

/**
 * The frame as a source rectangle for `drawImage`, in image pixels.
 * `angle` is 0 in v0.1 and therefore ignored here.
 */
export function frameSourceRect(frame: Frame): Rect {
  return {
    x: frame.cx - frame.width / 2,
    y: frame.cy - frame.height / 2,
    width: frame.width,
    height: frame.height,
  };
}

// ---- v0.2: rotated frames, crop handles, rotation baking ---------------------
//
// Angle convention: `Frame.angle` is the rotation of the frame relative to the
// image, in radians, positive = clockwise on screen (image coordinates are
// y-down). Baking rotates the image by `-angle` so the frame ends up upright.
// The "rotate 90° right" button therefore *subtracts* 90°: the image turns
// clockwise when baked.

export interface Point {
  x: number;
  y: number;
}

/** Maximum fine skew either side of the nearest right angle. */
export const MAX_SKEW = (15 * Math.PI) / 180;
/** Fine rotation snaps to the nearest right angle within this. */
export const SNAP_SKEW = (0.5 * Math.PI) / 180;
/** Minimum frame side as a fraction of the image width. */
export const MIN_FRAME_FRACTION = 0.1;

const QUARTER = Math.PI / 2;
const EPSILON = 1e-9;

/** Rotates a vector by `angle` (y-down coordinates: positive is clockwise on screen). */
export function rotateVector(x: number, y: number, angle: number): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Image point -> frame-local point (origin at the frame centre, axes along the frame). */
export function toFrameLocal(frame: Frame, p: Point): Point {
  return rotateVector(p.x - frame.cx, p.y - frame.cy, -frame.angle);
}

/** Frame-local point -> image point. */
export function fromFrameLocal(frame: Frame, p: Point): Point {
  const r = rotateVector(p.x, p.y, frame.angle);
  return { x: frame.cx + r.x, y: frame.cy + r.y };
}

/** The four corners of the frame in image coordinates: nw, ne, se, sw. */
export function frameCorners(frame: Frame): Point[] {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  return [
    fromFrameLocal(frame, { x: -hw, y: -hh }),
    fromFrameLocal(frame, { x: hw, y: -hh }),
    fromFrameLocal(frame, { x: hw, y: hh }),
    fromFrameLocal(frame, { x: -hw, y: hh }),
  ];
}

/** Axis-aligned bounding box of a set of points. */
export function boundsOf(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned bounding box of a (possibly rotated) frame in image coordinates. */
export function frameBounds(frame: Frame): Rect {
  return boundsOf(frameCorners(frame));
}

/** Normalises an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (Math.abs(a) < EPSILON) a = 0;
  return a;
}

/** The right angle nearest to `angle` (a multiple of 90°). */
export function baseAngle(angle: number): number {
  return Math.round(angle / QUARTER) * QUARTER;
}

/** True when `angle` is (numerically) an exact multiple of 90°. */
export function isRightAngle(angle: number): boolean {
  return Math.abs(angle - baseAngle(angle)) < EPSILON;
}

/**
 * Clamps a fine rotation to ±15° around `base` and snaps to `base` within ±0.5°.
 */
export function clampSkew(angle: number, base: number): number {
  const skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, angle - base));
  if (Math.abs(skew) <= SNAP_SKEW) return base;
  return base + skew;
}

/**
 * "Rotate 90° right": the frame keeps covering the same paper region, but its
 * own axes turn, so width and height swap. Fine skew is preserved.
 */
export function rotate90Right(frame: Frame): Frame {
  return {
    cx: frame.cx,
    cy: frame.cy,
    width: frame.height,
    height: frame.width,
    angle: normalizeAngle(frame.angle - QUARTER),
  };
}

/**
 * How far the frame sticks out of the image, in pixels (0 when fully inside).
 * A rotated frame may legitimately be partly outside: those areas become white
 * fill on confirm. Crop drags are only allowed to keep or reduce this.
 */
export function frameOverflow(frame: Frame, imageWidth: number, imageHeight: number): number {
  let overflow = 0;
  for (const p of frameCorners(frame)) {
    overflow = Math.max(overflow, -p.x, -p.y, p.x - imageWidth, p.y - imageHeight);
  }
  return overflow;
}

/**
 * Largest `t` in [0, 1] for which `frameAt(t)` does not stick out of the image
 * more than `frameAt(0)` does. `frameAt` must be affine in `t` (corners move
 * linearly), which makes the overflow convex in `t` and the search monotone.
 */
function clampMove(
  frameAt: (t: number) => Frame,
  imageWidth: number,
  imageHeight: number,
): Frame {
  const limit = frameOverflow(frameAt(0), imageWidth, imageHeight) + EPSILON;
  const full = frameAt(1);
  if (frameOverflow(full, imageWidth, imageHeight) <= limit) return full;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (frameOverflow(frameAt(mid), imageWidth, imageHeight) <= limit) lo = mid;
    else hi = mid;
  }
  return frameAt(lo);
}

/**
 * Translates the frame by an image-space delta, clamped so it does not leave
 * the image (or, if it already sticks out because of rotation, does not stick out further).
 */
export function moveFrame(
  frame: Frame,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): Frame {
  return clampMove(
    (t) => ({ ...frame, cx: frame.cx + dx * t, cy: frame.cy + dy * t }),
    imageWidth,
    imageHeight,
  );
}

/** Crop handles: edge midpoints and corners. */
export type Handle = 'n' | 'e' | 's' | 'w' | 'ne' | 'se' | 'sw' | 'nw';

export const HANDLES: readonly Handle[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

/** Position of a handle in frame-local coordinates. */
export function handleLocalPosition(frame: Frame, handle: Handle): Point {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const x = handle.includes('e') ? hw : handle.includes('w') ? -hw : 0;
  const y = handle.includes('s') ? hh : handle.includes('n') ? -hh : 0;
  return { x, y };
}

/**
 * Moves the edge(s) of `handle` by a frame-local delta. Edges move along the
 * frame's own axes, so this works identically on a rotated frame. The result
 * respects the minimum size and may not stick out of the image more than before.
 */
export function resizeFrame(
  frame: Frame,
  handle: Handle,
  localDx: number,
  localDy: number,
  imageWidth: number,
  imageHeight: number,
): Frame {
  // A corner is two edges; clamp each axis on its own so the corner slides
  // along an image edge instead of stopping at the first edge it touches.
  let result = frame;
  if (handle.includes('e')) result = resizeEdge(result, 'e', localDx, imageWidth, imageHeight);
  if (handle.includes('w')) result = resizeEdge(result, 'w', localDx, imageWidth, imageHeight);
  if (handle.includes('n')) result = resizeEdge(result, 'n', localDy, imageWidth, imageHeight);
  if (handle.includes('s')) result = resizeEdge(result, 's', localDy, imageWidth, imageHeight);
  return result;
}

/** Moves one edge by a frame-local distance along its axis, honouring min size and image bounds. */
function resizeEdge(
  frame: Frame,
  edge: 'n' | 'e' | 's' | 'w',
  delta: number,
  imageWidth: number,
  imageHeight: number,
): Frame {
  const minSide = MIN_FRAME_FRACTION * imageWidth;
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  let d = delta;
  if (edge === 'e') d = Math.max(delta, minSide - frame.width);
  if (edge === 'w') d = Math.min(delta, frame.width - minSide);
  if (edge === 's') d = Math.max(delta, minSide - frame.height);
  if (edge === 'n') d = Math.min(delta, frame.height - minSide);

  const frameAt = (t: number): Frame => {
    let left = -hw;
    let right = hw;
    let top = -hh;
    let bottom = hh;
    if (edge === 'e') right += d * t;
    if (edge === 'w') left += d * t;
    if (edge === 's') bottom += d * t;
    if (edge === 'n') top += d * t;
    const centre = fromFrameLocal(frame, { x: (left + right) / 2, y: (top + bottom) / 2 });
    return {
      cx: centre.x,
      cy: centre.y,
      width: right - left,
      height: bottom - top,
      angle: frame.angle,
    };
  };
  return clampMove(frameAt, imageWidth, imageHeight);
}

/**
 * Finds the handle under a frame-local point, if any, within `radius`
 * (frame-local = image pixels). Corners win over edges.
 */
export function hitHandle(frame: Frame, local: Point, radius: number): Handle | null {
  for (const handle of HANDLES) {
    const h = handleLocalPosition(frame, handle);
    if (Math.hypot(local.x - h.x, local.y - h.y) <= radius) return handle;
  }
  return null;
}

/** True when a frame-local point lies inside the frame. */
export function insideFrame(frame: Frame, local: Point): boolean {
  return Math.abs(local.x) <= frame.width / 2 && Math.abs(local.y) <= frame.height / 2;
}

/** 2D affine transform: p -> (a*x + c*y + e, b*x + d*y + f). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function applyAffine(t: Affine, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

export function invertAffine(t: Affine): Affine {
  const det = t.a * t.d - t.b * t.c;
  const a = t.d / det;
  const b = -t.b / det;
  const c = -t.c / det;
  const d = t.a / det;
  return { a, b, c, d, e: -(a * t.e + c * t.f), f: -(b * t.e + d * t.f) };
}

/** cos/sin snapped to exact 0/±1 for multiples of 90°, so those rotations copy pixels exactly. */
function exactCosSin(angle: number): { c: number; s: number } {
  if (isRightAngle(angle)) {
    const k = ((Math.round(angle / QUARTER) % 4) + 4) % 4;
    return { c: [1, 0, -1, 0][k]!, s: [0, 1, 0, -1][k]! };
  }
  return { c: Math.cos(angle), s: Math.sin(angle) };
}

/** Rotation by `angle` about `pivot`, then translation by (tx, ty). */
export function rotationAbout(angle: number, pivot: Point, tx = 0, ty = 0): Affine {
  const { c, s } = exactCosSin(angle);
  return {
    a: c,
    b: s,
    c: 0 - s,
    d: c,
    e: pivot.x - c * pivot.x + s * pivot.y + tx,
    f: pivot.y - s * pivot.x - c * pivot.y + ty,
  };
}

/** Result of the rotation-baking layout (pure maths; the drawing happens elsewhere). */
export interface BakeLayout {
  /** Size of the new canvas. */
  width: number;
  height: number;
  /** Maps old image pixels to new canvas pixels (rotate by -angle about the frame centre, then shift). */
  transform: Affine;
  /** The frame in the new canvas: same size, angle 0. */
  frame: Frame;
}

/**
 * Layout for baking the frame rotation into the image: rotate the image by
 * `-angle` about the frame centre, size the canvas to hold both the rotated
 * image and the (now upright) frame, and express the frame in the new canvas.
 * Exposed areas are white fill. For exact multiples of 90° with the frame
 * inside the image, the canvas is exactly the swapped image size and the
 * transform is an exact pixel copy.
 */
export function bakeLayout(
  imageWidth: number,
  imageHeight: number,
  frame: Frame,
  maxPixels = MAX_CAPTURE_PIXELS,
): BakeLayout {
  const pivot = { x: frame.cx, y: frame.cy };
  const rotate = rotationAbout(-frame.angle, pivot);
  const imageCorners = [
    { x: 0, y: 0 },
    { x: imageWidth, y: 0 },
    { x: imageWidth, y: imageHeight },
    { x: 0, y: imageHeight },
  ].map((p) => applyAffine(rotate, p));
  const upright: Frame = { ...frame, angle: 0 };
  const box = boundsOf([...imageCorners, ...frameCorners(upright)]);
  // Snap to whole pixels: expand outward so nothing is clipped.
  const minX = Math.floor(box.x + EPSILON);
  const minY = Math.floor(box.y + EPSILON);
  const maxX = Math.ceil(box.x + box.width - EPSILON);
  const maxY = Math.ceil(box.y + box.height - EPSILON);
  let width = Math.max(1, maxX - minX);
  let height = Math.max(1, maxY - minY);
  let transform = rotationAbout(-frame.angle, pivot, -minX, -minY);
  let baked: Frame = { cx: frame.cx - minX, cy: frame.cy - minY, width: frame.width, height: frame.height, angle: 0 };
  if (width * height > maxPixels) {
    // A skewed image's bounding box can exceed the canvas pixel cap (iOS):
    // scale the whole result down uniformly.
    const scale = Math.sqrt(maxPixels / (width * height));
    const size = captureSize(width, height, maxPixels);
    width = size.width;
    height = size.height;
    transform = {
      a: transform.a * scale,
      b: transform.b * scale,
      c: transform.c * scale,
      d: transform.d * scale,
      e: transform.e * scale,
      f: transform.f * scale,
    };
    baked = scaleFrame(baked, scale);
  }
  return { width, height, transform, frame: baked };
}

/**
 * The display transform of the crop/rotate view: the image turned by `-base`
 * (a multiple of 90°, so 90° taps are visible) and letterboxed into the view.
 * Image point -> CSS pixel.
 */
export function viewTransform(
  imageWidth: number,
  imageHeight: number,
  base: number,
  viewWidth: number,
  viewHeight: number,
): Affine {
  const rotate = rotationAbout(-base, { x: imageWidth / 2, y: imageHeight / 2 });
  const corners = [
    { x: 0, y: 0 },
    { x: imageWidth, y: 0 },
    { x: imageWidth, y: imageHeight },
    { x: 0, y: imageHeight },
  ].map((p) => applyAffine(rotate, p));
  const box = boundsOf(corners);
  const scale = Math.min(viewWidth / box.width, viewHeight / box.height);
  const offsetX = (viewWidth - box.width * scale) / 2 - box.x * scale;
  const offsetY = (viewHeight - box.height * scale) / 2 - box.y * scale;
  return {
    a: rotate.a * scale,
    b: rotate.b * scale,
    c: rotate.c * scale,
    d: rotate.d * scale,
    e: rotate.e * scale + offsetX,
    f: rotate.f * scale + offsetY,
  };
}

/** Uniform scale factor of a rotation+scale affine transform. */
export function affineScale(t: Affine): number {
  return Math.hypot(t.a, t.b);
}
