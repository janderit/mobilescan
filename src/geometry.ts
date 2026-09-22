/**
 * Pure geometry for the capture frame (see intent/v0.1-mvp.md "Data model").
 * No DOM access: everything here is plain number maths so it can be unit tested.
 */

import type { Frame, Point } from './model';

export type { Point };

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
  const scaled: Frame = {
    cx: frame.cx * factor,
    cy: frame.cy * factor,
    width: frame.width * factor,
    height: frame.height * factor,
    angle: frame.angle,
  };
  if (frame.corners) {
    scaled.corners = frame.corners.map((p) => ({ x: p.x * factor, y: p.y * factor })) as Quad;
  }
  return scaled;
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

/** Four points in corner order nw, ne, se, sw. */
export type Quad = [Point, Point, Point, Point];

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

/** The rectangle's corners in frame-local coordinates: nw, ne, se, sw. */
export function rectLocalCorners(frame: Frame): Quad {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/** The four corners of the frame rectangle in image coordinates: nw, ne, se, sw. */
export function frameCorners(frame: Frame): Point[] {
  return rectLocalCorners(frame).map((p) => fromFrameLocal(frame, p));
}

// ---- v0.7: displaced corners (shear) ----------------------------------------
//
// `Frame.corners` holds one frame-local offset per corner. The quadrilateral
// they describe is what the crop/rotate view draws and what the shear bake
// maps onto an upright rectangle. Offsets are frame-local, so rotation and
// crop edge moves carry them along unchanged.

const ZERO_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/** Offsets below this (in image pixels) count as zero: the frame is a rectangle. */
export const CORNER_EPSILON = 0.5;

/** The corner offsets of a frame, zero when absent. */
export function cornerOffsets(frame: Frame): Quad {
  return frame.corners ?? ZERO_QUAD;
}

/** True when at least one corner is displaced by more than `CORNER_EPSILON`. */
export function hasCornerOffsets(frame: Frame): boolean {
  return cornerOffsets(frame).some((p) => Math.abs(p.x) >= CORNER_EPSILON || Math.abs(p.y) >= CORNER_EPSILON);
}

/** The frame with its corner offsets dropped (a rectangle again). */
export function withoutCorners(frame: Frame): Frame {
  return { cx: frame.cx, cy: frame.cy, width: frame.width, height: frame.height, angle: frame.angle };
}

/** The displaced corners in frame-local coordinates: rectangle corner plus offset. */
export function quadLocalCorners(frame: Frame): Quad {
  const offsets = cornerOffsets(frame);
  return rectLocalCorners(frame).map((p, i) => ({ x: p.x + offsets[i]!.x, y: p.y + offsets[i]!.y })) as Quad;
}

/** The displaced corners in image coordinates: nw, ne, se, sw. Equals `frameCorners` without offsets. */
export function quadCorners(frame: Frame): Quad {
  return quadLocalCorners(frame).map((p) => fromFrameLocal(frame, p)) as Quad;
}

const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

/**
 * True when the quadrilateral is convex, keeps its nw-ne-se-sw winding and
 * every edge is at least `MIN_FRAME_FRACTION` of the image width long.
 */
export function quadValid(frame: Frame, imageWidth: number): boolean {
  if (!frame.corners) return true;
  const q = quadLocalCorners(frame);
  const minSide = MIN_FRAME_FRACTION * imageWidth;
  for (let i = 0; i < 4; i += 1) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < minSide - EPSILON) return false;
    if (cross(a, b, c) <= 0) return false;
  }
  return true;
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
  const turned: Frame = {
    cx: frame.cx,
    cy: frame.cy,
    width: frame.height,
    height: frame.width,
    angle: normalizeAngle(frame.angle - QUARTER),
  };
  if (frame.corners) {
    // The frame axes turn by -90° relative to the image, so a frame-local
    // point p of the old frame is R(+90°) p in the new one: (x, y) -> (-y, x).
    // Old nw lands on new ne, ne on se, se on sw, sw on nw.
    const [nw, ne, se, sw] = frame.corners;
    const turn = (p: Point): Point => ({ x: -p.y, y: p.x });
    turned.corners = [turn(sw), turn(nw), turn(ne), turn(se)];
  }
  return turned;
}

/**
 * How far the frame sticks out of the image, in pixels (0 when fully inside).
 * A rotated frame may legitimately be partly outside: those areas become white
 * fill on confirm. Crop drags are only allowed to keep or reduce this.
 */
export function frameOverflow(frame: Frame, imageWidth: number, imageHeight: number): number {
  let overflow = 0;
  for (const p of quadCorners(frame)) {
    overflow = Math.max(overflow, -p.x, -p.y, p.x - imageWidth, p.y - imageHeight);
  }
  return overflow;
}

/** Steps of the coarse scan in `clampMove` before the bisection. */
const CLAMP_SCAN_STEPS = 32;

/**
 * The frame furthest along `frameAt` (t in [0, 1]) that is still valid: it
 * does not stick out of the image more than `frameAt(0)` does and, with
 * displaced corners, its quadrilateral stays convex with long enough edges.
 * `frameAt` must move the corners linearly in `t`. The overflow limit alone is
 * convex in `t`; the shear constraints are not, so the search first scans for
 * the first invalid step and then bisects before it.
 */
function clampMove(
  frameAt: (t: number) => Frame,
  imageWidth: number,
  imageHeight: number,
): Frame {
  const limit = frameOverflow(frameAt(0), imageWidth, imageHeight) + EPSILON;
  const valid = (f: Frame): boolean =>
    frameOverflow(f, imageWidth, imageHeight) <= limit && quadValid(f, imageWidth);
  const full = frameAt(1);
  let lo = 0;
  let hi = 1;
  if (full.corners) {
    for (let i = 1; i <= CLAMP_SCAN_STEPS; i += 1) {
      const t = i / CLAMP_SCAN_STEPS;
      if (!valid(frameAt(t))) {
        hi = t;
        break;
      }
      lo = t;
    }
    if (lo === 1) return full;
  } else if (valid(full)) {
    return full;
  }
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (valid(frameAt(mid))) lo = mid;
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

/** The corner handles only, in `frameCorners` order. */
export const CORNER_HANDLES: readonly Handle[] = ['nw', 'ne', 'se', 'sw'];

/**
 * Position of a handle in frame-local coordinates: corner handles sit on the
 * (displaced) corners, edge handles on the midpoints of the quadrilateral's
 * edges. Without corner offsets these are the rectangle's corners and edges.
 */
export function handleLocalPosition(frame: Frame, handle: Handle): Point {
  const [nw, ne, se, sw] = quadLocalCorners(frame);
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  switch (handle) {
    case 'nw':
      return nw;
    case 'ne':
      return ne;
    case 'se':
      return se;
    case 'sw':
      return sw;
    case 'n':
      return mid(nw, ne);
    case 'e':
      return mid(ne, se);
    case 's':
      return mid(se, sw);
    default:
      return mid(sw, nw);
  }
}

/**
 * Shear mode (v0.7): moves one corner's offset by a frame-local delta. The
 * result is clamped so the quadrilateral stays convex, its edges keep the
 * minimum length and the corner does not leave the image beyond where it
 * already is. Like a crop corner drag, each axis is clamped on its own, so
 * the corner slides along an image edge instead of stopping at it.
 */
export function moveCorner(
  frame: Frame,
  corner: Handle,
  localDx: number,
  localDy: number,
  imageWidth: number,
  imageHeight: number,
): Frame {
  const index = CORNER_HANDLES.indexOf(corner);
  if (index < 0) return frame;
  const full = moveCornerAlong(frame, index, localDx, localDy, imageWidth, imageHeight);
  const wanted = cornerOffsets(frame)[index]!;
  const got = full.corners![index]!;
  if (Math.abs(got.x - wanted.x - localDx) < EPSILON && Math.abs(got.y - wanted.y - localDy) < EPSILON) {
    return full;
  }
  const alongX = moveCornerAlong(frame, index, localDx, 0, imageWidth, imageHeight);
  return moveCornerAlong(alongX, index, 0, localDy, imageWidth, imageHeight);
}

/** Moves corner `index` along a straight frame-local path as far as the constraints allow. */
function moveCornerAlong(
  frame: Frame,
  index: number,
  localDx: number,
  localDy: number,
  imageWidth: number,
  imageHeight: number,
): Frame {
  const offsets = cornerOffsets(frame);
  const frameAt = (t: number): Frame => {
    const corners = offsets.map((p, i) =>
      i === index ? { x: p.x + localDx * t, y: p.y + localDy * t } : { ...p },
    ) as Quad;
    return { ...frame, corners };
  };
  return clampMove(frameAt, imageWidth, imageHeight);
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
      ...frame,
      cx: centre.x,
      cy: centre.y,
      width: right - left,
      height: bottom - top,
    };
  };
  return clampMove(frameAt, imageWidth, imageHeight);
}

/**
 * Finds the handle under a frame-local point, if any, within `radius`
 * (frame-local = image pixels). Corners win over edges.
 */
export function hitHandle(
  frame: Frame,
  local: Point,
  radius: number,
  handles: readonly Handle[] = HANDLES,
): Handle | null {
  for (const handle of handles) {
    const h = handleLocalPosition(frame, handle);
    if (Math.hypot(local.x - h.x, local.y - h.y) <= radius) return handle;
  }
  return null;
}

/** True when a frame-local point lies inside the frame (the quadrilateral, if corners are displaced). */
export function insideFrame(frame: Frame, local: Point): boolean {
  if (!frame.corners) {
    return Math.abs(local.x) <= frame.width / 2 && Math.abs(local.y) <= frame.height / 2;
  }
  const q = quadLocalCorners(frame);
  for (let i = 0; i < 4; i += 1) {
    if (cross(q[i]!, q[(i + 1) % 4]!, local) < 0) return false;
  }
  return true;
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
  // The layout only handles the rectangle; displaced corners take `warpLayout`.
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

// ---- v0.7: homographies and the shear bake layout ----------------------------

/**
 * A projective transform as a row-major 3x3 matrix: p -> (h0 x + h1 y + h2,
 * h3 x + h4 y + h5) / (h6 x + h7 y + h8).
 */
export type Homography = [number, number, number, number, number, number, number, number, number];

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Solves `a x = b` for a square system by Gaussian elimination with partial pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      throw new Error('singular system');
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const head = m[col]!;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = m[row]!;
      const factor = target[col]! / head[col]!;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) target[k] = target[k]! - factor * head[k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * The homography mapping four source points onto four destination points
 * (direct linear transform: eight equations, h8 fixed at 1).
 */
export function homographyFromPoints(src: Quad, dst: Quad): Homography {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(a, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** The inverse homography (adjugate; the scale is irrelevant for a projective map). */
export function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-18) {
    throw new Error('singular homography');
  }
  return [
    (e * j - f * i) / det,
    (c * i - b * j) / det,
    (b * f - c * e) / det,
    (f * g - d * j) / det,
    (a * j - c * g) / det,
    (c * d - a * f) / det,
    (d * i - e * g) / det,
    (b * g - a * i) / det,
    (a * e - b * d) / det,
  ];
}

/** `m * h` as a homography (apply `h` first, then `m`). */
export function multiplyHomography(m: Homography, h: Homography): Homography {
  const r: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      r.push(
        m[row * 3]! * h[col]! + m[row * 3 + 1]! * h[3 + col]! + m[row * 3 + 2]! * h[6 + col]!,
      );
    }
  }
  return r as Homography;
}

/** Output margin around the target rectangle, as a fraction of its size per side. */
export const WARP_MARGIN = 0.25;

/** Result of the shear-baking layout (pure maths; the resampling happens in `warp.ts`). */
export interface WarpLayout {
  /** Size of the new canvas. */
  width: number;
  height: number;
  /** Maps old image pixels to new canvas pixels. */
  homography: Homography;
  /** The frame in the new canvas: the upright target rectangle, angle 0, no offsets. */
  frame: Frame;
}

/**
 * Layout for baking displaced corners (and any rotation) into the image: the
 * homography that maps the frame's quadrilateral onto an upright rectangle
 * whose sides are the mean lengths of the opposite quadrilateral edges, so the
 * pixel density stays close to the source's. The canvas covers the warped
 * image, clipped to the target rectangle enlarged by 25 % of its size on each
 * side (strong perspective sends the far image corners towards infinity), and
 * always the target rectangle itself. Above the pixel cap the whole result is
 * scaled down uniformly.
 */
export function warpLayout(
  imageWidth: number,
  imageHeight: number,
  frame: Frame,
  maxPixels = MAX_CAPTURE_PIXELS,
): WarpLayout {
  const quad = quadCorners(frame);
  const [nw, ne, se, sw] = quad;
  const length = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  const width = (length(nw, ne) + length(sw, se)) / 2;
  const height = (length(nw, sw) + length(ne, se)) / 2;
  const target: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const h = homographyFromPoints(quad, target);

  // Bounding box of the warped image, or unbounded where a corner crosses the
  // horizon (its projective w drops to zero or below).
  let box: Rect | null = null;
  const imageCorners = [
    { x: 0, y: 0 },
    { x: imageWidth, y: 0 },
    { x: imageWidth, y: imageHeight },
    { x: 0, y: imageHeight },
  ];
  const mapped: Point[] = [];
  let bounded = true;
  for (const p of imageCorners) {
    const w = h[6] * p.x + h[7] * p.y + h[8];
    if (w <= 1e-9) {
      bounded = false;
      break;
    }
    mapped.push(applyHomography(h, p));
  }
  if (bounded) box = boundsOf(mapped);
  const clip: Rect = {
    x: -WARP_MARGIN * width,
    y: -WARP_MARGIN * height,
    width: (1 + 2 * WARP_MARGIN) * width,
    height: (1 + 2 * WARP_MARGIN) * height,
  };
  let minX = clip.x;
  let minY = clip.y;
  let maxX = clip.x + clip.width;
  let maxY = clip.y + clip.height;
  if (box) {
    minX = Math.max(minX, box.x);
    minY = Math.max(minY, box.y);
    maxX = Math.min(maxX, box.x + box.width);
    maxY = Math.min(maxY, box.y + box.height);
  }
  // The target rectangle is always inside the canvas, even where the
  // quadrilateral stuck out of the image (that area is white fill).
  minX = Math.floor(Math.min(minX, 0) + EPSILON);
  minY = Math.floor(Math.min(minY, 0) + EPSILON);
  maxX = Math.ceil(Math.max(maxX, width) - EPSILON);
  maxY = Math.ceil(Math.max(maxY, height) - EPSILON);

  let canvasWidth = Math.max(1, maxX - minX);
  let canvasHeight = Math.max(1, maxY - minY);
  let scale = 1;
  if (canvasWidth * canvasHeight > maxPixels) {
    scale = Math.sqrt(maxPixels / (canvasWidth * canvasHeight));
    const size = captureSize(canvasWidth, canvasHeight, maxPixels);
    canvasWidth = size.width;
    canvasHeight = size.height;
  }
  const shift: Homography = [scale, 0, -minX * scale, 0, scale, -minY * scale, 0, 0, 1];
  return {
    width: canvasWidth,
    height: canvasHeight,
    homography: multiplyHomography(shift, h),
    frame: {
      cx: (width / 2 - minX) * scale,
      cy: (height / 2 - minY) * scale,
      width: width * scale,
      height: height * scale,
      angle: 0,
    },
  };
}
