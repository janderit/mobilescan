/**
 * Auto-detect (v0.8): paper edges near the frame, and the tone values that
 * turn a photographed page into black on white. Pure maths on `ImageData`;
 * the views render the working copies (see `sampleImage` in canvas.ts) and
 * apply the results as pending edits.
 *
 * Frame detection works in frame-local orientation: the caller draws the
 * image turned by the inverse of the frame rotation and scaled so the frame's
 * longer side is about 800 px (`frameWorkingLayout`), which makes the frame an
 * axis-aligned rectangle in the working image. Each frame edge is searched in
 * a band from 15 % inside to 5 % outside: the bright-to-dark transition
 * (paper to table) nearest to the frame line, inside the frame first and
 * only then outside, along every fourth sample line gives one point, a
 * repeated-median line fit makes the edge
 * robust to text and shadows crossing the band, and the four lines intersect
 * to corners, which are mapped back to image coordinates.
 * Pixels outside the image (transparent in the working copy) never count.
 *
 * Tone detection takes a luminance histogram of the inner 90 % of the frame
 * region, reads the paper background (the mode above 0.4) and the print (the
 * 1st percentile), and solves the v0.3 filter chain so that the background
 * maps to white and the print to black.
 *
 * Live detection (v0.10) runs the same edge search on the camera video with
 * a strict rule (`detectFrameStrict`: all four edges, no clamped rotation)
 * and a `DetectionTracker` that demands agreeing runs before a document
 * counts as found and tolerates single misses before it is lost.
 */

import type { Frame, Point } from './model';
import {
  baseAngle,
  clampSkew,
  invertAffine,
  MAX_SKEW,
  MIN_FRAME_FRACTION,
  normalizeAngle,
  quadValid,
  rectLocalCorners,
  toFrameLocal,
  type Affine,
  type Quad,
  type Rect,
} from './geometry';
import { clampTone, type Tone } from './tone';

/** Longer frame side of the working image for edge detection, in pixels. */
export const DETECT_LONG_SIDE = 800;
/** Search band outside the frame edge, as a fraction of the frame size on that axis. */
export const BAND_OUTSIDE = 0.05;
/** Search band inside the frame edge, as a fraction of the frame size on that axis. */
export const BAND_INSIDE = 0.15;
/** Distance between sample lines along an edge, in working pixels. */
export const SAMPLE_SPACING = 4;
/** A sample counts as an inlier of the fitted line within this distance (working pixels). */
export const INLIER_DISTANCE = 2;
/** An edge is accepted with at least this fraction of inliers ... */
export const MIN_INLIER_FRACTION = 0.6;
/** ... and at least this mean gradient at the inliers (luminance 0..1 per pixel). */
export const MIN_EDGE_GRADIENT = 12 / 255;
/** Fewer samples than this and the edge cannot be fitted. */
const MIN_SAMPLES = 8;
/** A gradient peak counts on a sample line from this fraction of the line's largest gradient. */
export const PEAK_FRACTION = 0.35;
/** Corner offsets below this (image pixels) are dropped: a straight-on scan yields a rectangle. */
export const MIN_CORNER_OFFSET = 1.5;

/** Longer side of the working image for tone detection, in pixels. */
export const TONE_LONG_SIDE = 500;
/** Fraction of the frame region measured for the tone (the outer 10 % often holds table or shadow). */
export const TONE_INNER = 0.9;
/** The paper background is the histogram mode above this luminance. */
const BACKGROUND_MIN = 0.4;
/** The mode is refined as the mean of the bins within this distance. */
const BACKGROUND_HALF_WIDTH = 8;
/** The print is the luminance at this fraction of the cumulative histogram. */
const TEXT_PERCENTILE = 0.01;
/** Below this background-to-print distance the page counts as blank ... */
const MIN_INK_CONTRAST = 0.2;
/** ... and the print is assumed this far below the background. */
const ASSUMED_INK_DISTANCE = 0.5;

/** sRGB luminance coefficients, the same as the grayscale filter uses. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

// ---- working copies ---------------------------------------------------------

/** Where and how large the working image is rendered. */
export interface WorkingLayout {
  /** working image size in pixels */
  width: number;
  height: number;
  /** image pixel -> working pixel */
  transform: Affine;
  /** the frame rectangle in working pixels (axis-aligned) */
  frame: Rect;
}

/**
 * The working image of a frame: the frame rectangle (offsets ignored) plus
 * `outward` of its size on every side, in frame-local orientation, scaled so
 * the longer frame side is `longSide` pixels.
 */
function workingLayout(frame: Frame, longSide: number, outward: number): WorkingLayout {
  const scale = longSide / Math.max(frame.width, frame.height);
  const fw = frame.width * scale;
  const fh = frame.height * scale;
  const width = Math.max(1, Math.ceil(fw * (1 + 2 * outward)));
  const height = Math.max(1, Math.ceil(fh * (1 + 2 * outward)));
  // working = scale * rotate(-angle) * (p - centre) + workingCentre
  const c = Math.cos(-frame.angle) * scale;
  const s = Math.sin(-frame.angle) * scale;
  const a = c;
  const b = s;
  const cc = -s;
  const d = c;
  const transform: Affine = {
    a,
    b,
    c: cc,
    d,
    e: width / 2 - (a * frame.cx + cc * frame.cy),
    f: height / 2 - (b * frame.cx + d * frame.cy),
  };
  return {
    width,
    height,
    transform,
    frame: { x: width / 2 - fw / 2, y: height / 2 - fh / 2, width: fw, height: fh },
  };
}

/** Working layout for edge detection: frame plus the outward band, longer side 800 px. */
export function frameWorkingLayout(frame: Frame, longSide = DETECT_LONG_SIDE): WorkingLayout {
  return workingLayout(frame, longSide, BAND_OUTSIDE);
}

/** Working layout for tone detection: the inner 90 % of the frame, longer side 500 px. */
export function toneWorkingLayout(frame: Frame, longSide = TONE_LONG_SIDE): WorkingLayout {
  const inner: Frame = { ...frame, width: frame.width * TONE_INNER, height: frame.height * TONE_INNER };
  return workingLayout(inner, longSide, 0);
}

/** Luminance 0..1 per pixel plus a validity mask (opaque pixels only). */
export interface Luminance {
  width: number;
  height: number;
  lum: Float32Array;
  valid: Uint8Array;
}

export function luminanceOf(image: ImageData): Luminance {
  const { width, height, data } = image;
  const n = width * height;
  const lum = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    if (data[p + 3]! === 255) {
      valid[i] = 1;
      lum[i] = (LUMA.r * data[p]! + LUMA.g * data[p + 1]! + LUMA.b * data[p + 2]!) / 255;
    }
  }
  return { width, height, lum, valid };
}

// ---- edges ---------------------------------------------------------------

export type Side = 'n' | 'e' | 's' | 'w';
export const SIDES: readonly Side[] = ['n', 'e', 's', 'w'];

/**
 * A fitted edge line in working pixels: for n/s `y = a + b x`, for w/e
 * `x = a + b y`. `found` is false when the frame edge itself was kept.
 */
export interface EdgeLine {
  found: boolean;
  a: number;
  b: number;
}

/** One sample of an edge: position along the edge, position across, gradient magnitude. */
interface EdgeSample {
  t: number;
  u: number;
  g: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Repeated-median regression u = a + b t (Siegel), robust up to 50 % outliers. */
export function repeatedMedianLine(samples: readonly { t: number; u: number }[]): { a: number; b: number } {
  const n = samples.length;
  const slopes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const si = samples[i]!;
    const pairwise: number[] = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const sj = samples[j]!;
      const dt = sj.t - si.t;
      if (dt === 0) continue;
      pairwise.push((sj.u - si.u) / dt);
    }
    if (pairwise.length > 0) slopes.push(median(pairwise));
  }
  const b = slopes.length > 0 ? median(slopes) : 0;
  const a = median(samples.map((s) => s.u - b * s.t));
  return { a, b };
}

/**
 * Samples one edge: on every `SAMPLE_SPACING`-th line along the edge, the
 * position across the band of the significant bright-to-dark transition
 * seen from the inside that lies nearest to the frame line, searching the
 * inside of the frame first and the 5 % outside only when the inside holds
 * none (3-pixel box blur along the edge, central difference across,
 * parabolic sub-pixel peak). Only the paper-to-table direction counts: a
 * dark-to-bright step further out is the table's edge against the
 * surroundings, not the paper's. Significant means at least `PEAK_FRACTION`
 * of the line's largest such gradient and at least `MIN_EDGE_GRADIENT`.
 * Nearest to the frame from the inside is the last edge before the frame,
 * so the paper edge wins over a line of text further in (often the stronger
 * edge), and inside-first keeps steps beyond the frame (desk edge,
 * vignetting, shadows) from displacing an edge that was found inside; weak
 * texture (wood grain, soft shadows) stays below the fraction.
 */
function sampleEdge(lum: Luminance, frame: Rect, side: Side): EdgeSample[] {
  const horizontal = side === 'n' || side === 's';
  const { width, height } = lum;
  // Band across the edge, from outside to inside (u is y for n/s, x for w/e).
  const size = horizontal ? frame.height : frame.width;
  const edge =
    side === 'n' ? frame.y : side === 's' ? frame.y + frame.height : side === 'w' ? frame.x : frame.x + frame.width;
  const inwardSign = side === 'n' || side === 'w' ? 1 : -1;
  const u0 = edge - inwardSign * BAND_OUTSIDE * size;
  const u1 = edge + inwardSign * BAND_INSIDE * size;
  const uMin = Math.max(1, Math.floor(Math.min(u0, u1)));
  const uMax = Math.min((horizontal ? height : width) - 2, Math.ceil(Math.max(u0, u1)));
  // Sample lines along the edge (t is x for n/s, y for w/e).
  const tStart = horizontal ? frame.x : frame.y;
  const tEnd = tStart + (horizontal ? frame.width : frame.height);
  const tMin = Math.max(1, Math.ceil(tStart));
  const tMax = Math.min((horizontal ? width : height) - 2, Math.floor(tEnd));

  const at = (t: number, u: number): number => (horizontal ? u * width + t : t * width + u);
  const blurred = (t: number, u: number): number | null => {
    const i0 = at(t - 1, u);
    const i1 = at(t, u);
    const i2 = at(t + 1, u);
    if (!lum.valid[i0] || !lum.valid[i1] || !lum.valid[i2]) return null;
    return (lum.lum[i0]! + lum.lum[i1]! + lum.lum[i2]!) / 3;
  };

  const samples: EdgeSample[] = [];
  if (uMax < uMin) return samples;
  const count = uMax - uMin + 1;
  const gradient = new Float32Array(count);
  for (let t = tMin; t <= tMax; t += SAMPLE_SPACING) {
    let largest = 0;
    for (let u = uMin; u <= uMax; u += 1) {
      const before = blurred(t, u - 1);
      const after = blurred(t, u + 1);
      // Positive when the luminance drops going outward (inside brighter).
      const g = before === null || after === null ? 0 : Math.max(0, (inwardSign * (after - before)) / 2);
      gradient[u - uMin] = g;
      if (g > largest) largest = g;
    }
    if (largest < MIN_EDGE_GRADIENT) continue;
    const threshold = Math.max(MIN_EDGE_GRADIENT, PEAK_FRACTION * largest);
    // Local maximum at or above the threshold nearest to the frame line:
    // first walking inward from the line, then outward.
    const line = Math.min(count - 1, Math.max(0, Math.round(edge) - uMin));
    let peak = -1;
    for (const step of [inwardSign, -inwardSign]) {
      for (let i = line; i >= 0 && i < count; i += step) {
        const g = gradient[i]!;
        if (g < threshold) continue;
        const prev = i > 0 ? gradient[i - 1]! : -1;
        const next = i < count - 1 ? gradient[i + 1]! : -1;
        if (g >= prev && g >= next) {
          peak = i;
          break;
        }
      }
      if (peak >= 0) break;
    }
    if (peak < 0) continue;
    const g0 = gradient[peak]!;
    // Parabolic refinement of the peak position.
    let u = uMin + peak;
    if (peak > 0 && peak < count - 1) {
      const gm = gradient[peak - 1]!;
      const gp = gradient[peak + 1]!;
      const denominator = gm - 2 * g0 + gp;
      if (denominator < 0) u += Math.max(-0.5, Math.min(0.5, (0.5 * (gm - gp)) / denominator));
    }
    samples.push({ t, u, g: g0 });
  }
  return samples;
}

/** Fits the samples of one edge; the frame edge itself when the fit is not convincing. */
function fitEdge(samples: EdgeSample[], fallback: number): EdgeLine {
  const keep: EdgeLine = { found: false, a: fallback, b: 0 };
  if (samples.length < MIN_SAMPLES) return keep;
  const { a, b } = repeatedMedianLine(samples);
  const inliers = samples.filter((s) => Math.abs(s.u - (a + b * s.t)) <= INLIER_DISTANCE);
  if (inliers.length < MIN_INLIER_FRACTION * samples.length) return keep;
  const meanGradient = inliers.reduce((sum, s) => sum + s.g, 0) / inliers.length;
  if (meanGradient < MIN_EDGE_GRADIENT) return keep;
  return { found: true, a, b };
}

export interface EdgeDetection {
  lines: Record<Side, EdgeLine>;
  /** number of edges found (0..4) */
  found: number;
  /** the corners nw, ne, se, sw in working pixels */
  corners: Quad;
}

/** Intersection of a horizontal-ish line (y = a + b x) with a vertical-ish one (x = a + b y). */
function intersect(h: EdgeLine, v: EdgeLine): Point {
  const x = (v.a + v.b * h.a) / (1 - h.b * v.b);
  return { x, y: h.a + h.b * x };
}

/** Detects the four edges of a frame in the working luminance image. */
export function detectEdges(lum: Luminance, frame: Rect): EdgeDetection {
  const fallback: Record<Side, number> = {
    n: frame.y,
    s: frame.y + frame.height,
    w: frame.x,
    e: frame.x + frame.width,
  };
  const lines = {} as Record<Side, EdgeLine>;
  let found = 0;
  for (const side of SIDES) {
    lines[side] = fitEdge(sampleEdge(lum, frame, side), fallback[side]);
    if (lines[side].found) found += 1;
  }
  const corners: Quad = [
    intersect(lines.n, lines.w),
    intersect(lines.n, lines.e),
    intersect(lines.s, lines.e),
    intersect(lines.s, lines.w),
  ];
  return { lines, found, corners };
}

// ---- frame from corners ---------------------------------------------------

const length = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
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
  const width = (length(nw, ne) + length(sw, se)) / 2;
  const height = (length(nw, sw) + length(ne, se)) / 2;
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
  const offsets = corners.map((p, i) => {
    const q = toFrameLocal(rect, p);
    const offset = { x: q.x - local[i]!.x, y: q.y - local[i]!.y };
    return Math.hypot(offset.x, offset.y) < MIN_CORNER_OFFSET ? { x: 0, y: 0 } : offset;
  }) as Quad;
  if (offsets.some((p) => p.x !== 0 || p.y !== 0)) rect.corners = offsets;
  return { frame: rect, clamped };
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
): FrameDetection {
  const edges = detectEdges(luminanceOf(working), layout.frame);
  if (edges.found === 0) return { frame: null, found: 0, clamped: false };
  const back = invertAffine(layout.transform);
  const corners = edges.corners.map((p) => ({
    x: back.a * p.x + back.c * p.y + back.e,
    y: back.b * p.x + back.d * p.y + back.f,
  })) as Quad;
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
): Frame | null {
  return detectFrameDetailed(working, layout, current, imageWidth).frame;
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
): Frame | null {
  const result = detectFrameDetailed(working, layout, current, imageWidth);
  if (result.found < 4 || result.clamped) return null;
  return result.frame;
}

// ---- live detection tracker (v0.10) --------------------------------------

/** Agreeing runs in a row before a document counts as found. */
export const HITS_TO_FIND = 3;
/** Misses in a row before a found document is lost. */
export const MISSES_TO_LOSE = 2;
/**
 * A run agrees with the tracked outline when no corner is further from it
 * than this fraction of the frame width. 3 % is about 80 px on a 2700 px
 * frame: a hand held still passes, a hand moving over the page does not
 * (raised from 1 % after the first device test, where hand tremor between
 * runs kept the outline from ever locking).
 */
export const AGREE_FRACTION = 0.03;
/** Weight of the newest run in the smoothed corners. */
export const SMOOTHING = 0.5;

export interface TrackerState {
  /** True while a document counts as found. */
  found: boolean;
  /** The smoothed corners (nw, ne, se, sw) while found, else null. */
  corners: Quad | null;
}

/**
 * Hysteresis and smoothing over successive detection runs: a hit that agrees
 * with the previous run counts towards `HITS_TO_FIND`; a run without a hit,
 * or a hit that disagrees, counts towards `MISSES_TO_LOSE`. The corners
 * reported while found are smoothed exponentially and reset on loss.
 */
export class DetectionTracker {
  private previous: Quad | null = null;
  private hits = 0;
  private misses = 0;
  private found = false;
  private smoothed: Quad | null = null;

  /** `tolerance` in the corners' pixel unit; `AGREE_FRACTION` of the frame width. */
  constructor(private readonly tolerance: number) {}

  /** Feeds one run: the detected frame's corners, or null for no document. */
  push(quad: Quad | null): TrackerState {
    // Compared with the smoothed outline while found (steadier than a single
    // run), else with the last hit; a miss keeps the last hit, so a hit after
    // a single miss can still agree with it.
    const reference = this.smoothed ?? this.previous;
    const agrees = quad !== null && reference !== null && quadsAgree(quad, reference, this.tolerance);
    if (quad !== null) this.previous = quad;
    this.hits = quad === null ? 0 : agrees ? this.hits + 1 : 1;
    if (agrees) {
      this.misses = 0;
      if (this.hits >= HITS_TO_FIND) this.found = true;
    } else {
      this.misses += 1;
      if (this.misses >= MISSES_TO_LOSE) {
        this.found = false;
        this.smoothed = null;
      }
    }
    if (this.found && quad !== null && agrees) {
      this.smoothed = this.smoothed ? lerpQuad(this.smoothed, quad, SMOOTHING) : quad;
    }
    return this.state();
  }

  state(): TrackerState {
    return { found: this.found, corners: this.found ? this.smoothed : null };
  }

  reset(): void {
    this.previous = null;
    this.hits = 0;
    this.misses = 0;
    this.found = false;
    this.smoothed = null;
  }
}

function quadsAgree(a: Quad, b: Quad, tolerance: number): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y) > tolerance) return false;
  }
  return true;
}

function lerpQuad(from: Quad, to: Quad, t: number): Quad {
  return from.map((p, i) => ({
    x: p.x + (to[i]!.x - p.x) * t,
    y: p.y + (to[i]!.y - p.y) * t,
  })) as Quad;
}

// ---- tone -----------------------------------------------------------------

/** 256-bin luminance histogram of the opaque pixels. */
export function luminanceHistogram(image: ImageData): Uint32Array {
  const histogram = new Uint32Array(256);
  const { data } = image;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3]! !== 255) continue;
    const y = Math.round(LUMA.r * data[p]! + LUMA.g * data[p + 1]! + LUMA.b * data[p + 2]!);
    const bin = Math.min(255, Math.max(0, y));
    histogram[bin] = histogram[bin]! + 1;
  }
  return histogram;
}

/** Background and print luminance (0..1) read from a histogram; null when it is empty. */
export function paperLevels(histogram: Uint32Array): { background: number; text: number } | null {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i]!;
  if (total === 0) return null;
  // Background: the mode above 0.4 (the whole range when nothing is that bright).
  let from = Math.ceil(BACKGROUND_MIN * 255);
  let mode = -1;
  let modeCount = 0;
  for (let i = from; i < 256; i += 1) {
    if (histogram[i]! > modeCount) {
      modeCount = histogram[i]!;
      mode = i;
    }
  }
  if (mode < 0) {
    from = 0;
    for (let i = 0; i < 256; i += 1) {
      if (histogram[i]! > modeCount) {
        modeCount = histogram[i]!;
        mode = i;
      }
    }
  }
  let weighted = 0;
  let count = 0;
  for (let i = Math.max(from, mode - BACKGROUND_HALF_WIDTH); i <= Math.min(255, mode + BACKGROUND_HALF_WIDTH); i += 1) {
    weighted += i * histogram[i]!;
    count += histogram[i]!;
  }
  const background = (count > 0 ? weighted / count : mode) / 255;
  // Print: the 1st percentile of the cumulative histogram.
  let cumulative = 0;
  let percentile = 0;
  for (let i = 0; i < 256; i += 1) {
    cumulative += histogram[i]!;
    if (cumulative >= TEXT_PERCENTILE * total) {
      percentile = i;
      break;
    }
  }
  let text = percentile / 255;
  if (background - text < MIN_INK_CONTRAST) text = Math.max(0, background - ASSUMED_INK_DISTANCE);
  return { background, text };
}

/**
 * Brightness and contrast that map `background` to white and `text` to black
 * through the v0.3 chain `out = c * (b * in) + 0.5 * (1 - c)`, clamped to
 * the slider ranges; grayscale on, temperature neutral.
 */
export function toneForLevels(background: number, text: number): Tone {
  const sum = background + text;
  const difference = background - text;
  const brightness = sum > 0 ? 1 / sum : 1;
  const contrast = difference > 0 ? sum / difference : 1;
  return {
    brightness: clampTone('brightness', brightness),
    contrast: clampTone('contrast', contrast),
    temperature: 0,
    grayscale: true,
  };
}

/** The whole tone detection on the working copy of the frame region; null when nothing was measurable. */
export function detectTone(working: ImageData): Tone | null {
  const levels = paperLevels(luminanceHistogram(working));
  return levels ? toneForLevels(levels.background, levels.text) : null;
}
