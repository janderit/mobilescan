import { describe, expect, it } from 'vitest';
import {
  CORNER_HANDLES,
  MIN_FRAME_FRACTION,
  applyHomography,
  frameOverflow,
  fromFrameLocal,
  handleLocalPosition,
  hasCornerOffsets,
  hitHandle,
  homographyFromPoints,
  insideFrame,
  invertHomography,
  moveCorner,
  moveFrame,
  multiplyHomography,
  quadCorners,
  quadValid,
  rectLocalCorners,
  resizeFrame,
  rotate90Right,
  warpLayout,
  withoutCorners,
  type Homography,
  type Point,
  type Quad,
} from '../src/geometry';
import { warpRows } from '../src/warp';
import type { Frame } from '../src/model';

const deg = (d: number): number => (d * Math.PI) / 180;
const W = 3000;
const H = 4000;

function frame(overrides: Partial<Frame> = {}): Frame {
  return { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...overrides };
}

function offsets(nw: Point, ne: Point, se: Point, sw: Point): Quad {
  return [nw, ne, se, sw];
}

const zero = { x: 0, y: 0 };

function expectPoint(p: Point, x: number, y: number, digits = 6): void {
  expect(p.x).toBeCloseTo(x, digits);
  expect(p.y).toBeCloseTo(y, digits);
}

/** A frame whose displaced corners sit exactly on `quad` (image coordinates), rectangle from its bounds. */
function frameOnQuad(quad: Quad, angle = 0): Frame {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const rect: Frame = {
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    angle,
  };
  const local = rectLocalCorners(rect);
  const corners = quad.map((p, i) => {
    const r = fromFrameLocal(rect, local[i]!);
    // offset in frame-local coordinates
    const d = { x: p.x - r.x, y: p.y - r.y };
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    return { x: d.x * c - d.y * s, y: d.x * s + d.y * c };
  }) as Quad;
  return { ...rect, corners };
}

describe('corner offsets', () => {
  it('are frame-local displacements of the rectangle corners', () => {
    const f = frame({ corners: offsets({ x: -50, y: 30 }, zero, zero, { x: 10, y: -20 }) });
    const [nw, ne, se, sw] = quadCorners(f);
    expectPoint(nw, 500 - 50, 600 + 30);
    expectPoint(ne, 2500, 600);
    expectPoint(se, 2500, 3400);
    expectPoint(sw, 500 + 10, 3400 - 20);
  });

  it('turn with the frame', () => {
    const f = frame({ cx: 0, cy: 0, width: 200, height: 100, angle: deg(90), corners: offsets({ x: 10, y: 0 }, zero, zero, zero) });
    // Local +x is image +y at 90°: the nw corner moves down on the image.
    const [nw] = quadCorners(f);
    const [rectNw] = quadCorners(withoutCorners(f));
    expectPoint(nw, rectNw.x, rectNw.y + 10);
  });

  it('count as zero below half a pixel', () => {
    expect(hasCornerOffsets(frame())).toBe(false);
    expect(hasCornerOffsets(frame({ corners: offsets({ x: 0.4, y: -0.3 }, zero, zero, zero) }))).toBe(false);
    expect(hasCornerOffsets(frame({ corners: offsets(zero, zero, { x: 0, y: 1 }, zero) }))).toBe(true);
  });

  it('put the corner handles on the displaced corners and the edge handles on the quadrilateral midpoints', () => {
    const f = frame({ corners: offsets(zero, { x: 0, y: 100 }, zero, zero) });
    expectPoint(handleLocalPosition(f, 'ne'), 1000, -1400 + 100);
    expectPoint(handleLocalPosition(f, 'n'), 0, -1400 + 50);
    expectPoint(handleLocalPosition(f, 'e'), 1000, 50);
    expectPoint(handleLocalPosition(f, 'w'), -1000, 0);
    expect(hitHandle(f, { x: 1000, y: -1300 }, 5)).toBe('ne');
    expect(hitHandle(f, { x: 1000, y: -1400 }, 5)).toBeNull();
    expect(hitHandle(f, { x: 0, y: -1350 }, 5, CORNER_HANDLES)).toBeNull();
  });

  it('decide inside/outside by the quadrilateral', () => {
    const f = frame({ corners: offsets(zero, { x: 0, y: 600 }, zero, zero) });
    expect(insideFrame(f, { x: 900, y: -1300 })).toBe(false);
    expect(insideFrame(f, { x: 900, y: -700 })).toBe(true);
    expect(insideFrame(withoutCorners(f), { x: 900, y: -1300 })).toBe(true);
  });
});

describe('moveCorner (shear mode)', () => {
  it('moves only the dragged corner; the other three stay put', () => {
    const before = quadCorners(frame());
    const f = moveCorner(frame(), 'se', -120, 80, W, H);
    const after = quadCorners(f);
    expectPoint(after[2], before[2].x - 120, before[2].y + 80);
    for (const i of [0, 1, 3]) expectPoint(after[i]!, before[i]!.x, before[i]!.y);
    expect(f.corners![0]).toEqual(zero);
    expect(f.corners![2]).toEqual({ x: -120, y: 80 });
    // The rectangle is untouched.
    expect(withoutCorners(f)).toEqual(frame());
  });

  it('keeps the quadrilateral convex, clamping instead of rejecting', () => {
    // Pull nw far towards the centre: it must stop before the shape folds.
    const f = moveCorner(frame(), 'nw', 1500, 2100, W, H);
    expect(quadValid(f, W)).toBe(true);
    const d = f.corners![0]!;
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBeGreaterThan(0);
    expect(d.y).toBeLessThan(2100);
    // A further pull in the same direction changes nothing.
    const g = moveCorner(f, 'nw', 1500, 2100, W, H);
    expect(g.corners![0]!.x).toBeCloseTo(d.x, 6);
    expect(g.corners![0]!.y).toBeCloseTo(d.y, 6);
  });

  it('keeps every edge at least 10 % of the image width long', () => {
    const f = moveCorner(frame({ cx: 1500, cy: 2000, width: 2000, height: 400 }), 'ne', 0, 380, W, H);
    const [nw, ne, se] = quadCorners(f);
    const right = Math.hypot(se.x - ne.x, se.y - ne.y);
    expect(right).toBeGreaterThanOrEqual(MIN_FRAME_FRACTION * W - 1e-6);
    expect(Math.hypot(ne.x - nw.x, ne.y - nw.y)).toBeGreaterThan(MIN_FRAME_FRACTION * W);
  });

  it('may not push a corner out of the image', () => {
    const f = moveCorner(frame(), 'ne', 5000, -5000, W, H);
    const ne = quadCorners(f)[1];
    expect(ne.x).toBeCloseTo(W, 3);
    expect(ne.y).toBeCloseTo(0, 3);
    expect(frameOverflow(f, W, H)).toBeLessThan(1e-3);
  });

  it('lets a corner that is already outside (after rotation) come back in but not go further out', () => {
    const f = frame({ width: 2900, height: 3900, angle: deg(10) });
    const overflow = frameOverflow(f, W, H);
    expect(overflow).toBeGreaterThan(0);
    const worse = moveCorner(f, 'ne', 500, -500, W, H);
    expect(frameOverflow(worse, W, H)).toBeLessThanOrEqual(overflow + 1e-6);
    expect(worse.corners![1]).not.toEqual({ x: 500, y: -500 });
    const better = moveCorner(f, 'ne', -300, 300, W, H);
    expect(better.corners![1]).toEqual({ x: -300, y: 300 });
  });
});

describe('crop and rotate with displaced corners', () => {
  const sheared = (): Frame =>
    frame({ corners: offsets({ x: 40, y: 20 }, { x: -30, y: 10 }, { x: 0, y: -50 }, { x: 25, y: 0 }) });

  it('an edge drag moves both corners of that edge along the rectangle axis, offsets unchanged', () => {
    const f = sheared();
    const before = quadCorners(f);
    const r = resizeFrame(f, 'e', -100, 999, W, H);
    expect(r.corners).toEqual(f.corners);
    expect(r.width).toBe(1900);
    const after = quadCorners(r);
    expectPoint(after[1], before[1].x - 100, before[1].y);
    expectPoint(after[2], before[2].x - 100, before[2].y);
    expectPoint(after[0], before[0].x, before[0].y);
    expectPoint(after[3], before[3].x, before[3].y);
  });

  it('a corner drag in crop mode moves the rectangle corner and keeps the offset', () => {
    const f = sheared();
    const r = resizeFrame(f, 'nw', 100, 200, W, H);
    expect(r.corners).toEqual(f.corners);
    expect(r.width).toBe(1900);
    expect(r.height).toBe(2600);
  });

  it('a body drag keeps the offsets', () => {
    const r = moveFrame(sheared(), 50, -50, W, H);
    expect(r.corners).toEqual(sheared().corners);
    expect(r.cx).toBe(1550);
  });

  it('crop drags obey the quadrilateral: the displaced corner may not leave the image', () => {
    const f = frame({ corners: offsets(zero, { x: 400, y: 0 }, zero, zero) });
    const r = resizeFrame(f, 'e', 5000, 0, W, H);
    expect(quadCorners(r)[1].x).toBeCloseTo(W, 3);
    expect(r.cx + r.width / 2).toBeCloseTo(W - 400, 3);
  });

  it('one 90° tap turns the quadrilateral with the image; four taps restore it exactly', () => {
    const f = sheared();
    const before = quadCorners(f);
    const once = rotate90Right(f);
    const after = quadCorners(once);
    // Same points on the image, relabelled: old nw is new ne, and so on.
    expectPoint(after[1], before[0].x, before[0].y);
    expectPoint(after[2], before[1].x, before[1].y);
    expectPoint(after[3], before[2].x, before[2].y);
    expectPoint(after[0], before[3].x, before[3].y);
    let g = f;
    for (let i = 0; i < 4; i += 1) g = rotate90Right(g);
    expect(g).toEqual(f);
  });

  it('a skewed frame with offsets still turns its corners as a rigid shape', () => {
    const f = frame({ angle: deg(7), corners: offsets({ x: 60, y: -20 }, zero, { x: -10, y: 30 }, zero) });
    const before = quadCorners(f);
    const after = quadCorners(rotate90Right(f));
    for (let i = 0; i < 4; i += 1) expectPoint(after[(i + 1) % 4]!, before[i]!.x, before[i]!.y);
  });
});

describe('homography', () => {
  const src: Quad = [
    { x: 100, y: 80 },
    { x: 300, y: 100 },
    { x: 340, y: 330 },
    { x: 60, y: 300 },
  ];
  const dst: Quad = [
    { x: 0, y: 0 },
    { x: 250, y: 0 },
    { x: 250, y: 240 },
    { x: 0, y: 240 },
  ];

  it('maps each source corner to its target corner within 1e-6', () => {
    const h = homographyFromPoints(src, dst);
    src.forEach((p, i) => {
      const q = applyHomography(h, p);
      expect(Math.abs(q.x - dst[i]!.x)).toBeLessThan(1e-6);
      expect(Math.abs(q.y - dst[i]!.y)).toBeLessThan(1e-6);
    });
  });

  it('inverts: H^-1 H is the identity within 1e-9', () => {
    const h = homographyFromPoints(src, dst);
    const id = multiplyHomography(invertHomography(h), h);
    const s = id[8];
    const expected: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    id.forEach((v, i) => expect(Math.abs(v / s - expected[i]!)).toBeLessThan(1e-9));
    const p = { x: 123.4, y: 56.7 };
    const back = applyHomography(invertHomography(h), applyHomography(h, p));
    expect(Math.abs(back.x - p.x)).toBeLessThan(1e-9);
    expect(Math.abs(back.y - p.y)).toBeLessThan(1e-9);
  });

  it('is affine (h6 = h7 = 0) for a parallelogram', () => {
    const h = homographyFromPoints(
      [
        { x: 0, y: 0 },
        { x: 100, y: 10 },
        { x: 110, y: 60 },
        { x: 10, y: 50 },
      ],
      dst,
    );
    expect(Math.abs(h[6])).toBeLessThan(1e-12);
    expect(Math.abs(h[7])).toBeLessThan(1e-12);
  });
});

describe('warpLayout', () => {
  it('targets the mean edge lengths and keeps the target rectangle inside the canvas', () => {
    const quad: Quad = [
      { x: 700, y: 500 },
      { x: 2200, y: 700 },
      { x: 2500, y: 3500 },
      { x: 400, y: 3200 },
    ];
    const f = frameOnQuad(quad);
    const l = warpLayout(W, H, f);
    const len = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
    expect(l.frame.width).toBeCloseTo((len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2, 6);
    expect(l.frame.height).toBeCloseTo((len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2, 6);
    expect(l.frame.angle).toBe(0);
    expect(l.frame.corners).toBeUndefined();
    expect(frameOverflow(l.frame, l.width, l.height)).toBe(0);
    // The quadrilateral corners land on the target rectangle's corners.
    const target = quadCorners(l.frame);
    quad.forEach((p, i) => expectPoint(applyHomography(l.homography, p), target[i]!.x, target[i]!.y));
    // Whole pixels.
    expect(Number.isInteger(l.width)).toBe(true);
    expect(Number.isInteger(l.height)).toBe(true);
  });

  it('bakes rotation together with the shear', () => {
    const f = frame({ angle: deg(5), corners: offsets({ x: 30, y: 0 }, zero, zero, zero) });
    const l = warpLayout(W, H, f);
    const target = quadCorners(l.frame);
    quadCorners(f).forEach((p, i) => expectPoint(applyHomography(l.homography, p), target[i]!.x, target[i]!.y, 4));
  });

  it('clips the canvas to the target rectangle plus 25 % per side under strong perspective', () => {
    // The top edge is much shorter than the bottom: the far image corners fly off.
    const quad: Quad = [
      { x: 1300, y: 1500 },
      { x: 1700, y: 1500 },
      { x: 2900, y: 3900 },
      { x: 100, y: 3900 },
    ];
    const l = warpLayout(W, H, frameOnQuad(quad), Number.POSITIVE_INFINITY);
    expect(l.width).toBeLessThanOrEqual(Math.ceil(1.5 * l.frame.width) + 1);
    expect(l.height).toBeLessThanOrEqual(Math.ceil(1.5 * l.frame.height) + 1);
    expect(frameOverflow(l.frame, l.width, l.height)).toBe(0);
  });

  it('keeps the image margins for a mild shear, like rotation baking', () => {
    const f = frame({ corners: offsets({ x: 20, y: 0 }, { x: -20, y: 0 }, zero, zero) });
    const l = warpLayout(W, H, f);
    expect(l.width).toBeGreaterThan(f.width * 1.2);
    expect(l.height).toBeGreaterThan(f.height * 1.2);
  });

  it('scales the result down uniformly at the pixel cap', () => {
    const f = frame({ corners: offsets({ x: 20, y: 0 }, { x: -20, y: 0 }, zero, zero) });
    const unbounded = warpLayout(W, H, f, Number.POSITIVE_INFINITY);
    const l = warpLayout(W, H, f, 4_000_000);
    expect(l.width * l.height).toBeLessThanOrEqual(4_000_000);
    const s = l.width / unbounded.width;
    expect(l.frame.width).toBeCloseTo(unbounded.frame.width * s, 0);
    expect(l.frame.height).toBeCloseTo(unbounded.frame.height * s, 0);
    const target = quadCorners(l.frame);
    quadCorners(f).forEach((p, i) => expectPoint(applyHomography(l.homography, p), target[i]!.x, target[i]!.y, 3));
  });
});

describe('warpRows', () => {
  const SW = 400;
  const SH = 400;
  const RED = [220, 30, 30];
  const GREY = [120, 120, 120];
  const quad: Quad = [
    { x: 100, y: 80 },
    { x: 300, y: 100 },
    { x: 340, y: 330 },
    { x: 60, y: 300 },
  ];

  function insideQuad(p: Point): boolean {
    for (let i = 0; i < 4; i += 1) {
      const a = quad[i]!;
      const b = quad[(i + 1) % 4]!;
      if ((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x) < 0) return false;
    }
    return true;
  }

  /** Grey image with a red trapezoid: the paper photographed from an angle. */
  function source(): { data: Uint8ClampedArray; width: number; height: number } {
    const data = new Uint8ClampedArray(SW * SH * 4);
    for (let y = 0; y < SH; y += 1) {
      for (let x = 0; x < SW; x += 1) {
        const colour = insideQuad({ x: x + 0.5, y: y + 0.5 }) ? RED : GREY;
        const i = (y * SW + x) * 4;
        data[i] = colour[0]!;
        data[i + 1] = colour[1]!;
        data[i + 2] = colour[2]!;
        data[i + 3] = 255;
      }
    }
    return { data, width: SW, height: SH };
  }

  function warpAll(): { out: Uint8ClampedArray; layout: ReturnType<typeof warpLayout> } {
    const layout = warpLayout(SW, SH, frameOnQuad(quad));
    const out = new Uint8ClampedArray(layout.width * layout.height * 4);
    const inverse = invertHomography(layout.homography);
    const strip = 64;
    for (let y = 0; y < layout.height; y += strip) {
      const rows = Math.min(strip, layout.height - y);
      const buffer = new Uint8ClampedArray(rows * layout.width * 4);
      warpRows(source(), inverse, buffer, layout.width, y, rows);
      out.set(buffer, y * layout.width * 4);
    }
    return { out, layout };
  }

  function pixel(out: Uint8ClampedArray, width: number, x: number, y: number): number[] {
    const i = (y * width + x) * 4;
    return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!];
  }

  const isRed = (p: number[]): boolean => p[0]! > 180 && p[1]! < 80;
  const isWhite = (p: number[]): boolean => p[0]! === 255 && p[1]! === 255 && p[2]! === 255;
  const isGrey = (p: number[]): boolean => Math.abs(p[0]! - 120) < 10 && Math.abs(p[1]! - 120) < 10;

  it('turns the trapezoid into an axis-aligned rectangle of the target size', () => {
    const { out, layout } = warpAll();
    const left = layout.frame.cx - layout.frame.width / 2;
    const right = layout.frame.cx + layout.frame.width / 2;
    const top = layout.frame.cy - layout.frame.height / 2;
    const bottom = layout.frame.cy + layout.frame.height / 2;
    // Scan the middle row and the middle column for the red run.
    const midY = Math.round(layout.frame.cy);
    const midX = Math.round(layout.frame.cx);
    const redXs: number[] = [];
    for (let x = 0; x < layout.width; x += 1) if (isRed(pixel(out, layout.width, x, midY))) redXs.push(x);
    const redYs: number[] = [];
    for (let y = 0; y < layout.height; y += 1) if (isRed(pixel(out, layout.width, midX, y))) redYs.push(y);
    expect(Math.abs(redXs[0]! - left)).toBeLessThanOrEqual(1);
    expect(Math.abs(redXs[redXs.length - 1]! + 1 - right)).toBeLessThanOrEqual(1);
    expect(Math.abs(redYs[0]! - top)).toBeLessThanOrEqual(1);
    expect(Math.abs(redYs[redYs.length - 1]! + 1 - bottom)).toBeLessThanOrEqual(1);
    // The run is contiguous: an axis-aligned rectangle, not a trapezoid.
    expect(redXs.length).toBe(redXs[redXs.length - 1]! - redXs[0]! + 1);
    expect(redYs.length).toBe(redYs[redYs.length - 1]! - redYs[0]! + 1);
    // Near the corners of the target rectangle the edges are straight and axis aligned.
    for (const y of [Math.round(top) + 2, Math.round(bottom) - 3]) {
      expect(isRed(pixel(out, layout.width, Math.round(left) + 2, y))).toBe(true);
      expect(isRed(pixel(out, layout.width, Math.round(right) - 3, y))).toBe(true);
      expect(isRed(pixel(out, layout.width, Math.round(left) - 3, y))).toBe(false);
      expect(isRed(pixel(out, layout.width, Math.round(right) + 2, y))).toBe(false);
    }
  });

  it('fills the inside with the paper colour, the margins with the source and the rest white', () => {
    const { out, layout } = warpAll();
    const { cx, cy, width, height } = layout.frame;
    expect(isRed(pixel(out, layout.width, Math.round(cx), Math.round(cy)))).toBe(true);
    expect(isRed(pixel(out, layout.width, Math.round(cx - width / 2) + 3, Math.round(cy - height / 2) + 3))).toBe(true);
    // Just outside the paper the grey background is still there (margins kept).
    expect(isGrey(pixel(out, layout.width, Math.round(cx - width / 2) - 4, Math.round(cy)))).toBe(true);
    // Somewhere outside the warped source only white remains: the output
    // corners are outside the source's image for this perspective.
    const corners = [
      [0, 0],
      [layout.width - 1, 0],
      [layout.width - 1, layout.height - 1],
      [0, layout.height - 1],
    ];
    const whiteCorners = corners.filter(([x, y]) => isWhite(pixel(out, layout.width, x!, y!)));
    expect(whiteCorners.length).toBeGreaterThan(0);
    // Every pixel is opaque.
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  it('samples bilinearly: an identity warp reproduces the source exactly', () => {
    const src = source();
    const identity: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const out = new Uint8ClampedArray(SW * SH * 4);
    warpRows(src, identity, out, SW, 0, SH);
    expect(out).toEqual(src.data);
  });
});
