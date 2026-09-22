/**
 * The capture frame model and its editing (see intent/v0.1-mvp.md "Data model"):
 * the initial frame, frame-local coordinates, displaced corners (shear), and
 * the clamped crop, shear and rotation moves of the crop/rotate view.
 * No DOM access: everything here is plain number maths so it can be unit tested.
 */

import type { Frame, Point, UprightFrame } from './model';
import { mapQuad, type Quad } from './affine';
import { normalizeAngle } from './angles';

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
export function initialFrame(imageWidth: number, imageHeight: number, visible?: Rect): UprightFrame {
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

/**
 * Scales a frame from one image size to another (e.g. track size -> capture
 * canvas size). Keeps the frame's kind: an upright frame stays upright.
 */
export function scaleFrame<F extends Frame>(frame: F, factor: number): F {
  const scaled: F = {
    ...frame,
    cx: frame.cx * factor,
    cy: frame.cy * factor,
    width: frame.width * factor,
    height: frame.height * factor,
  };
  delete scaled.corners;
  if (frame.corners) {
    const corners = mapQuad(frame.corners, (p) => ({ x: p.x * factor, y: p.y * factor }));
    if (offsetsMatter(corners)) scaled.corners = corners;
  }
  return scaled;
}

/**
 * The frame as an `UprightFrame` once the caller has established that it is
 * one: angle 0 and no corner offsets. Throws otherwise, because a rotated or
 * sheared frame must go through a bake, never onto a page.
 */
export function uprightFrame(frame: Frame): UprightFrame {
  if (frame.angle !== 0 || hasCornerOffsets(frame)) {
    throw new Error('frame is not upright');
  }
  return { cx: frame.cx, cy: frame.cy, width: frame.width, height: frame.height, angle: 0 };
}

/**
 * The frame as a source rectangle for `drawImage`, in image pixels. Only an
 * upright frame (a stored page frame) is a plain rectangle of the image; the
 * editor's pending frame is rotated or sheared and has no such rectangle.
 */
export function frameSourceRect(frame: UprightFrame): Rect {
  return {
    x: frame.cx - frame.width / 2,
    y: frame.cy - frame.height / 2,
    width: frame.width,
    height: frame.height,
  };
}

// ---- v0.2: rotated frames, crop handles ---------------------------------------
//
// Angle convention: `Frame.angle` is the rotation of the frame relative to the
// image, in radians, positive = clockwise on screen (image coordinates are
// y-down). Baking rotates the image by `-angle` so the frame ends up upright.
// The "rotate 90° right" button therefore *subtracts* 90°: the image turns
// clockwise when baked. The angle helpers (`baseAngle`, `clampSkew`, ...) live in `angles.ts`.

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

/** True when at least one offset reaches `CORNER_EPSILON`. */
function offsetsMatter(offsets: Quad): boolean {
  return offsets.some((p) => Math.abs(p.x) >= CORNER_EPSILON || Math.abs(p.y) >= CORNER_EPSILON);
}

/** True when at least one corner is displaced by at least `CORNER_EPSILON`; equals `frame.corners !== undefined`. */
export function hasCornerOffsets(frame: Frame): boolean {
  return offsetsMatter(cornerOffsets(frame));
}

/** The frame with its corner offsets dropped (a rectangle again). */
export function withoutCorners(frame: Frame): Frame {
  return { cx: frame.cx, cy: frame.cy, width: frame.width, height: frame.height, angle: frame.angle };
}

/**
 * The frame with the given corner offsets, stored only when at least one
 * reaches `CORNER_EPSILON`; otherwise `corners` stays absent. Every frame
 * built with offsets goes through here so that "`corners` is present" and
 * `hasCornerOffsets` agree.
 */
export function withCorners(frame: Frame, offsets: Quad): Frame {
  const result = withoutCorners(frame);
  if (offsetsMatter(offsets)) result.corners = offsets;
  return result;
}

/** The displaced corners in frame-local coordinates: rectangle corner plus offset. */
export function quadLocalCorners(frame: Frame): Quad {
  const offsets = cornerOffsets(frame);
  return mapQuad(rectLocalCorners(frame), (p, i) => ({ x: p.x + offsets[i]!.x, y: p.y + offsets[i]!.y }));
}

/** The displaced corners in image coordinates: nw, ne, se, sw. Equals `frameCorners` without offsets. */
export function quadCorners(frame: Frame): Quad {
  return mapQuad(quadLocalCorners(frame), (p) => fromFrameLocal(frame, p));
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
  if (!frame.corners) return turned;
  // The frame axes turn by -90° relative to the image, so a frame-local
  // point p of the old frame is R(+90°) p in the new one: (x, y) -> (-y, x).
  // Old nw lands on new ne, ne on se, se on sw, sw on nw.
  const [nw, ne, se, sw] = frame.corners;
  const turn = (p: Point): Point => ({ x: -p.y, y: p.x });
  return withCorners(turned, [turn(sw), turn(nw), turn(ne), turn(se)]);
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
  const got = cornerOffsets(full)[index]!;
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
    const corners = mapQuad(offsets, (p, i) =>
      i === index ? { x: p.x + localDx * t, y: p.y + localDy * t } : { ...p },
    );
    return { ...frame, corners };
  };
  const moved = clampMove(frameAt, imageWidth, imageHeight);
  return withCorners(moved, cornerOffsets(moved));
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
