/**
 * Frame detection: the edges found in a working image become corners in image
 * coordinates and then a frame (rotation from the long edges clamped to the
 * skew range, sizes from the mean opposite sides, the centroid, residuals as
 * corner offsets), with the wand's lenient rule and the live detection's
 * strict rule on top. Pure maths; the working copy comes from the caller.
 */

import type { Frame, Point } from './model';
import {
  applyAffine,
  baseAngle,
  clampSkew,
  distance,
  invertAffine,
  mapQuad,
  MAX_SKEW,
  MIN_FRAME_FRACTION,
  normalizeAngle,
  quadValid,
  rectLocalCorners,
  toFrameLocal,
  withCorners,
  type Quad,
} from './geometry';
import { detectEdges, luminanceOf, type Luminance, type WorkingLayout } from './detect-edges';

/** Corner offsets below this (image pixels) are dropped: a straight-on scan yields a rectangle. */
export const MIN_CORNER_OFFSET = 1.5;

/**
 * Buffers a caller may keep between detection runs so that a run allocates
 * no luminance arrays (the live detection reuses them); `luminance` is
 * filled by each run and read by the next.
 */
export interface DetectBuffers {
  luminance?: Luminance;
}

const direction = (a: Point, b: Point): number => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * The frame that best represents four detected corners (image pixels):
 * rotation from the two long edges (clamped to the skew range around the
 * current base), width and height from the mean opposite sides, the centre
 * at the centroid, and the residual per corner as its offset (v0.7).
 */
export function frameFromCorners(corners: Quad, current: Frame): Frame {
  return frameFromCornersDetailed(corners, current).frame;
}

/** `frameFromCorners` plus whether the rotation had to be clamped to the skew range. */
export function frameFromCornersDetailed(corners: Quad, current: Frame): { frame: Frame; clamped: boolean } {
  const [nw, ne, se, sw] = corners;
  const width = (distance(nw, ne) + distance(sw, se)) / 2;
  const height = (distance(nw, sw) + distance(ne, se)) / 2;
  // Each edge's direction relative to what the current rotation predicts.
  const relative = (a: Point, b: Point, expected: number): number =>
    normalizeAngle(direction(a, b) - expected);
  const longEdges =
    current.height >= current.width
      ? [relative(nw, sw, current.angle + Math.PI / 2), relative(ne, se, current.angle + Math.PI / 2)]
      : [relative(nw, ne, current.angle), relative(sw, se, current.angle)];
  const skew = (longEdges[0]! + longEdges[1]!) / 2;
  const base = baseAngle(current.angle);
  const wanted = current.angle + skew;
  const angle = clampSkew(wanted, base);
  const clamped = Math.abs(normalizeAngle(wanted - base)) > MAX_SKEW + 1e-9;
  const rect: Frame = {
    cx: (nw.x + ne.x + se.x + sw.x) / 4,
    cy: (nw.y + ne.y + se.y + sw.y) / 4,
    width,
    height,
    angle,
  };
  const local = rectLocalCorners(rect);
  const offsets = mapQuad(corners, (p, i) => {
    const q = toFrameLocal(rect, p);
    const offset = { x: q.x - local[i]!.x, y: q.y - local[i]!.y };
    return Math.hypot(offset.x, offset.y) < MIN_CORNER_OFFSET ? { x: 0, y: 0 } : offset;
  });
  return { frame: withCorners(rect, offsets), clamped };
}

/** Outcome of a frame detection with the details the strict rule needs. */
export interface FrameDetection {
  /** The frame, or null when no edge was found or the result is not usable. */
  frame: Frame | null;
  /** Number of edges found (0..4); unfound edges kept the current frame edge. */
  found: number;
  /** True when the detected rotation exceeded the skew range and was clamped. */
  clamped: boolean;
}

/**
 * The whole frame detection: working image -> edges -> corners in image
 * coordinates -> frame, with the number of edges found and whether the
 * rotation was clamped. `frame` is null when no edge was found or the result
 * is not a usable frame (too small, or not convex).
 */
export function detectFrameDetailed(
  working: ImageData,
  layout: WorkingLayout,
  current: Frame,
  imageWidth: number,
  scratch?: DetectBuffers,
): FrameDetection {
  const luminance = luminanceOf(working, scratch?.luminance);
  if (scratch) scratch.luminance = luminance;
  const edges = detectEdges(luminance, layout.frame);
  if (edges.found === 0) return { frame: null, found: 0, clamped: false };
  const back = invertAffine(layout.transform);
  const corners = mapQuad(edges.corners, (p) => applyAffine(back, p));
  const { frame, clamped } = frameFromCornersDetailed(corners, current);
  const minSide = MIN_FRAME_FRACTION * imageWidth;
  if (!(frame.width >= minSide) || !(frame.height >= minSide)) return { frame: null, found: edges.found, clamped };
  if (!quadValid(frame, imageWidth)) return { frame: null, found: edges.found, clamped };
  return { frame, found: edges.found, clamped };
}

/** The wand's detection (v0.8): partial results are applied. */
export function detectFrame(
  working: ImageData,
  layout: WorkingLayout,
  current: Frame,
  imageWidth: number,
  scratch?: DetectBuffers,
): Frame | null {
  return detectFrameDetailed(working, layout, current, imageWidth, scratch).frame;
}

/**
 * The live detection's rule (v0.10): all four edges found and the rotation
 * inside the skew range, otherwise there is no document.
 */
export function detectFrameStrict(
  working: ImageData,
  layout: WorkingLayout,
  current: Frame,
  imageWidth: number,
  scratch?: DetectBuffers,
): Frame | null {
  const result = detectFrameDetailed(working, layout, current, imageWidth, scratch);
  if (result.found < 4 || result.clamped) return null;
  return result.frame;
}
