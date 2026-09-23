/**
 * Paper edge detection near a frame: the working layouts (frame-local
 * orientation, longer frame side about 800 px), the luminance of a working
 * image, and the per-edge search. Pure maths on `ImageData`; the views and
 * the glue in detect.ts render the working copies (see `sampleImage` in
 * canvas.ts).
 *
 * Each frame edge is searched in a band from 20 % inside to 10 % outside: the
 * bright-to-dark transition (paper to table) nearest to the frame line, inside
 * the frame first and only then outside, along every fourth sample line gives
 * one point, a repeated-median line fit makes the edge robust to text and
 * shadows crossing the band, and the four lines intersect to corners in
 * working pixels. Pixels outside the image (transparent in the working copy)
 * never count. With three edges found, `completeDinEdge` (v1.1) infers the
 * fourth from the DIN A aspect ratio when it lands in that side's band.
 */

import type { Frame, Point } from './model';
import { rotationAbout, scaleAffine, SQRT2, translateAffine, type Affine, type Quad, type Rect } from './geometry';
import { luminance } from './color';

/** Longer frame side of the working image for edge detection, in pixels. */
export const DETECT_LONG_SIDE = 800;
/** Search band outside the frame edge, as a fraction of the frame size on that axis. */
export const BAND_OUTSIDE = 0.1;
/** Search band inside the frame edge, as a fraction of the frame size on that axis. */
export const BAND_INSIDE = 0.2;
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
export function workingLayout(frame: Frame, longSide: number, outward: number): WorkingLayout {
  const scale = longSide / Math.max(frame.width, frame.height);
  const fw = frame.width * scale;
  const fh = frame.height * scale;
  const width = Math.max(1, Math.ceil(fw * (1 + 2 * outward)));
  const height = Math.max(1, Math.ceil(fh * (1 + 2 * outward)));
  // Turn the frame upright about its centre, scale, and put the centre at the working centre.
  const centre = { x: frame.cx, y: frame.cy };
  const transform = translateAffine(
    scaleAffine(rotationAbout(-frame.angle, centre), scale),
    width / 2 - frame.cx * scale,
    height / 2 - frame.cy * scale,
  );
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

/** Luminance 0..1 per pixel plus a validity mask (opaque pixels only). */
export interface Luminance {
  width: number;
  height: number;
  lum: Float32Array;
  valid: Uint8Array;
}

/**
 * The luminance of a working image. With `reuse` of the same size, its arrays
 * are filled in place instead of allocated (the live detection runs this on
 * about a million pixels several times a second); a `reuse` of another size
 * is ignored.
 */
export function luminanceOf(image: ImageData, reuse?: Luminance): Luminance {
  const { width, height, data } = image;
  const n = width * height;
  const reusable = reuse !== undefined && reuse.width === width && reuse.height === height && reuse.lum.length === n;
  const lum = reusable ? reuse.lum : new Float32Array(n);
  const valid = reusable ? reuse.valid : new Uint8Array(n);
  if (reusable) {
    // Only opaque pixels are set below; the rest must read as invalid again.
    lum.fill(0);
    valid.fill(0);
  }
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    if (data[p + 3]! === 255) {
      valid[i] = 1;
      lum[i] = luminance(data[p]!, data[p + 1]!, data[p + 2]!) / 255;
    }
  }
  return reusable ? reuse : { width, height, lum, valid };
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
 * inside of the frame first and the 10 % outside only when the inside holds
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
  /** the side whose line was inferred from the DIN ratio (`completeDinEdge`), else null */
  completed: Side | null;
}

/** Intersection of a horizontal-ish line (y = a + b x) with a vertical-ish one (x = a + b y). */
function intersect(h: EdgeLine, v: EdgeLine): Point {
  const x = (v.a + v.b * h.a) / (1 - h.b * v.b);
  return { x, y: h.a + h.b * x };
}

/** The corners nw, ne, se, sw of four edge lines. */
function cornersOf(lines: Record<Side, EdgeLine>): Quad {
  return [
    intersect(lines.n, lines.w),
    intersect(lines.n, lines.e),
    intersect(lines.s, lines.e),
    intersect(lines.s, lines.w),
  ];
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
  return { lines, found, corners: cornersOf(lines), completed: null };
}

// ---- DIN completion (v1.1) ---------------------------------------------------

const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', w: 'e', e: 'w' };

/** The position across of a line at position `t` along it. */
const lineAt = (line: EdgeLine, t: number): number => line.a + line.b * t;

/**
 * Completes a detection with exactly three edges found by the fourth: a line
 * parallel to the opposite edge at the DIN A distance (the extent between the
 * two adjacent edges times or divided by sqrt 2, whichever lands nearer to the
 * frame line of the missing side), accepted only when that line lies in the
 * missing side's search band, i.e. where the user aimed the frame. This is
 * what a page in a spiral block needs: the bound edge is broken by holes and
 * wire and never fits as a line, whichever side it is on. Null when there are
 * not exactly three edges or the DIN edge is out of the band; the extent is
 * measured at the opposite edge and at the frame line and averaged, an
 * affine approximation of a perspective view that is within a few percent.
 */
export function completeDinEdge(edges: EdgeDetection, frame: Rect): EdgeDetection | null {
  if (edges.found !== 3) return null;
  const missing = SIDES.find((side) => !edges.lines[side].found)!;
  const horizontal = missing === 'n' || missing === 's';
  const opposite = edges.lines[OPPOSITE[missing]];
  const [first, second] = horizontal ? [edges.lines.w, edges.lines.e] : [edges.lines.n, edges.lines.s];
  // Across: the axis the missing edge is searched along; along: the edge's own direction.
  const size = horizontal ? frame.height : frame.width;
  const line =
    missing === 'n' ? frame.y : missing === 's' ? frame.y + frame.height : missing === 'w' ? frame.x : frame.x + frame.width;
  const inwardSign = missing === 'n' || missing === 'w' ? 1 : -1;
  const centreAlong = horizontal ? frame.x + frame.width / 2 : frame.y + frame.height / 2;
  const oppositeAt = lineAt(opposite, centreAlong);
  const extentAt = (u: number): number => Math.abs(lineAt(second, u) - lineAt(first, u));
  const extent = (extentAt(oppositeAt) + extentAt(line)) / 2;
  // A perpendicular distance d between parallel lines is d * sqrt(1 + b^2) across.
  const slope = Math.sqrt(1 + opposite.b * opposite.b);
  const candidates = [extent * SQRT2, extent / SQRT2].map((d) => oppositeAt - inwardSign * d * slope);
  const at = candidates.reduce((best, c) => (Math.abs(c - line) < Math.abs(best - line) ? c : best));
  const outer = line - inwardSign * BAND_OUTSIDE * size;
  const inner = line + inwardSign * BAND_INSIDE * size;
  if (at < Math.min(outer, inner) || at > Math.max(outer, inner)) return null;
  const completed: EdgeLine = { found: false, a: at - opposite.b * centreAlong, b: opposite.b };
  const lines = { ...edges.lines, [missing]: completed } as Record<Side, EdgeLine>;
  return { lines, found: edges.found, corners: cornersOf(lines), completed: missing };
}
