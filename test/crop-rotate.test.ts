import { describe, expect, it } from 'vitest';
import {
  MAX_SKEW,
  MIN_FRAME_FRACTION,
  applyAffine,
  bakeLayout,
  baseAngle,
  clampSkew,
  frameBounds,
  frameCorners,
  frameOverflow,
  fromFrameLocal,
  handleLocalPosition,
  hitHandle,
  invertAffine,
  normalizeAngle,
  resizeFrame,
  rotate90Right,
  toFrameLocal,
  viewTransform,
  affineScale,
} from '../src/geometry';
import type { Frame } from '../src/model';

const deg = (d: number): number => (d * Math.PI) / 180;
const W = 3000;
const H = 4000;

function frame(overrides: Partial<Frame> = {}): Frame {
  return { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...overrides };
}

function expectPoint(p: { x: number; y: number }, x: number, y: number): void {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
}

describe('frame-local coordinates', () => {
  it('round-trips through a rotated frame', () => {
    const f = frame({ angle: deg(33) });
    const p = { x: 2100, y: 900 };
    const back = fromFrameLocal(f, toFrameLocal(f, p));
    expectPoint(back, p.x, p.y);
  });

  it('positive angle is clockwise on screen (y down)', () => {
    // The frame's local +x axis, rotated +90°, points down (+y) in image coordinates.
    const f = frame({ cx: 0, cy: 0, angle: deg(90) });
    expectPoint(fromFrameLocal(f, { x: 1, y: 0 }), 0, 1);
  });

  it('lists corners nw, ne, se, sw along the frame axes', () => {
    const f = frame({ cx: 0, cy: 0, width: 200, height: 100, angle: deg(90) });
    const [nw, ne, se, sw] = frameCorners(f);
    expectPoint(nw!, 50, -100);
    expectPoint(ne!, 50, 100);
    expectPoint(se!, -50, 100);
    expectPoint(sw!, -50, -100);
  });

  it('bounds of a 90° frame are the swapped size', () => {
    const b = frameBounds(frame({ cx: 0, cy: 0, width: 200, height: 100, angle: deg(90) }));
    expect(b.width).toBeCloseTo(100, 6);
    expect(b.height).toBeCloseTo(200, 6);
  });
});

describe('angles', () => {
  it('normalises into (-PI, PI] and snaps tiny values to 0', () => {
    expect(normalizeAngle(4 * -Math.PI / 2)).toBe(0);
    expect(normalizeAngle(deg(270))).toBeCloseTo(deg(-90), 12);
    expect(normalizeAngle(deg(-270))).toBeCloseTo(deg(90), 12);
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('baseAngle is the nearest right angle', () => {
    expect(baseAngle(deg(10))).toBe(0);
    expect(baseAngle(deg(-80))).toBeCloseTo(deg(-90), 12);
    expect(baseAngle(deg(100))).toBeCloseTo(deg(90), 12);
  });

  it('clampSkew limits to ±15° and snaps within ±0.5°', () => {
    expect(clampSkew(deg(20), 0)).toBeCloseTo(MAX_SKEW, 12);
    expect(clampSkew(deg(-20), 0)).toBeCloseTo(-MAX_SKEW, 12);
    expect(clampSkew(deg(5), 0)).toBeCloseTo(deg(5), 12);
    expect(clampSkew(deg(0.4), 0)).toBe(0);
    expect(clampSkew(deg(-90.3), deg(-90))).toBe(deg(-90));
    expect(clampSkew(deg(-85), deg(-90))).toBeCloseTo(deg(-85), 12);
  });
});

describe('rotate90Right', () => {
  it('subtracts 90°, swaps width and height, keeps the centre and the skew', () => {
    const f = rotate90Right(frame({ angle: deg(4) }));
    expect(f.cx).toBe(1500);
    expect(f.cy).toBe(2000);
    expect(f.width).toBe(2800);
    expect(f.height).toBe(2000);
    expect(f.angle).toBeCloseTo(deg(-86), 12);
  });

  it('four taps return to the original frame with angle exactly 0', () => {
    let f = frame();
    for (let i = 0; i < 4; i += 1) f = rotate90Right(f);
    expect(f).toEqual(frame());
  });

  it('keeps the on-screen region: the bounds are unchanged', () => {
    const before = frameBounds(frame());
    const after = frameBounds(rotate90Right(frame()));
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });
});

describe('resizeFrame', () => {
  it('moves only the dragged edge along the frame axis (unrotated)', () => {
    const f = resizeFrame(frame(), 'e', 100, 999, W, H);
    expect(f.width).toBe(2100);
    expect(f.height).toBe(2800);
    expect(f.cx).toBe(1550);
    expect(f.cy).toBe(2000);
  });

  it('moves the opposite edge for w/n and keeps the other side still', () => {
    const f = resizeFrame(frame(), 'nw', 100, 200, W, H);
    // left edge moved right by 100: width 1900, right edge still at 2500
    expect(f.width).toBe(1900);
    expect(f.cx + f.width / 2).toBe(2500);
    // top edge moved down by 200: height 2600, bottom still at 3400
    expect(f.height).toBe(2600);
    expect(f.cy + f.height / 2).toBe(3400);
  });

  it('after a 90° tap the "e" handle is on screen right and a drag to the right widens the frame', () => {
    const turned = rotate90Right(frame({ width: 2000, height: 2800 }));
    // The view turns the image by -base, so the frame appears upright on screen.
    const view = viewTransform(W, H, baseAngle(turned.angle), 390, 700);
    const centre = applyAffine(view, { x: turned.cx, y: turned.cy });
    const e = applyAffine(view, fromFrameLocal(turned, handleLocalPosition(turned, 'e')));
    expect(e.x).toBeGreaterThan(centre.x + 100);
    expect(e.y).toBeCloseTo(centre.y, 6);
    // A 20 px drag to the right on screen (the frame is close to the image edge), expressed in image pixels, then frame-local.
    const inv = invertAffine(view);
    const from = applyAffine(inv, e);
    const to = applyAffine(inv, { x: e.x + 20, y: e.y });
    const l0 = toFrameLocal(turned, from);
    const l1 = toFrameLocal(turned, to);
    const localDx = l1.x - l0.x;
    expect(localDx).toBeGreaterThan(0);
    expect(l1.y - l0.y).toBeCloseTo(0, 6);
    const resized = resizeFrame(turned, 'e', localDx, 0, W, H);
    expect(resized.width).toBeCloseTo(2800 + localDx, 6);
    expect(resized.height).toBeCloseTo(2000, 6);
    // and the on-screen right edge really moved right
    const e2 = applyAffine(view, fromFrameLocal(resized, handleLocalPosition(resized, 'e')));
    expect(e2.x).toBeCloseTo(e.x + 20, 6);
  });

  it('resizes a skewed frame along its own axes', () => {
    const f = frame({ width: 1000, height: 1000, angle: deg(30) });
    const r = resizeFrame(f, 's', 0, 200, W, H);
    expect(r.width).toBeCloseTo(1000, 6);
    expect(r.height).toBeCloseTo(1200, 6);
    expect(r.angle).toBe(deg(30));
    // The north edge midpoint stays where it was.
    expectPoint(fromFrameLocal(r, { x: 0, y: -600 }), ...(() => {
      const p = fromFrameLocal(f, { x: 0, y: -500 });
      return [p.x, p.y] as const;
    })());
  });

  it('enforces the minimum size', () => {
    const f = resizeFrame(frame(), 'w', 5000, 0, W, H);
    expect(f.width).toBeCloseTo(MIN_FRAME_FRACTION * W, 6);
    expect(f.cx + f.width / 2).toBe(2500);
  });

  it('clamps at the image bounds', () => {
    const f = resizeFrame(frame(), 'se', 5000, 5000, W, H);
    expect(f.cx + f.width / 2).toBeCloseTo(W, 3);
    expect(f.cy + f.height / 2).toBeCloseTo(H, 3);
  });
});

describe('hitHandle', () => {
  it('finds corners before edges and nothing far away', () => {
    const f = frame({ cx: 0, cy: 0, width: 200, height: 100 });
    expect(hitHandle(f, { x: 98, y: -48 }, 10)).toBe('ne');
    expect(hitHandle(f, { x: 0, y: 52 }, 10)).toBe('s');
    expect(hitHandle(f, { x: -96, y: 0 }, 10)).toBe('w');
    expect(hitHandle(f, { x: 0, y: 0 }, 10)).toBeNull();
  });
});

describe('bakeLayout', () => {
  it('is a no-op layout for angle 0 with the frame inside', () => {
    const l = bakeLayout(W, H, frame());
    expect(l.width).toBe(W);
    expect(l.height).toBe(H);
    expect(l.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(Object.is(l.transform.c, -0)).toBe(false);
    expect(l.frame).toEqual(frame());
  });

  it('swaps the image size exactly for a 90° step and copies pixels exactly', () => {
    const f = rotate90Right(frame({ cx: 1500, cy: 2000, width: 2000, height: 2800 }));
    const l = bakeLayout(W, H, f);
    expect(l.width).toBe(H);
    expect(l.height).toBe(W);
    // Exact integer matrix: clockwise 90° maps (x, y) -> (H - y, x).
    expect(l.transform.a).toBe(0);
    expect(l.transform.b).toBe(1);
    expect(l.transform.c).toBe(-1);
    expect(l.transform.d).toBe(0);
    expect(Number.isInteger(l.transform.e)).toBe(true);
    expect(Number.isInteger(l.transform.f)).toBe(true);
    expectPoint(applyAffine(l.transform, { x: 0, y: 0 }), H, 0);
    expectPoint(applyAffine(l.transform, { x: W, y: H }), 0, W);
    // The frame lands upright, swapped, at the mapped centre.
    expect(l.frame.angle).toBe(0);
    expect(l.frame.width).toBe(2800);
    expect(l.frame.height).toBe(2000);
    expectPoint(applyAffine(l.transform, { x: f.cx, y: f.cy }), l.frame.cx, l.frame.cy);
  });

  it('grows the canvas for a skew and keeps the frame region inside it', () => {
    const f = frame({ angle: deg(5) });
    const l = bakeLayout(W, H, f);
    expect(l.width).toBeGreaterThan(W);
    expect(l.height).toBeGreaterThan(H);
    expect(l.frame.angle).toBe(0);
    expect(frameOverflow(l.frame, l.width, l.height)).toBe(0);
    // Every original frame corner maps onto the upright frame's corner.
    const mapped = frameCorners(f).map((p) => applyAffine(l.transform, p));
    const target = frameCorners(l.frame);
    mapped.forEach((p, i) => expectPoint(p, target[i]!.x, target[i]!.y));
  });

  it('keeps a frame that sticks out of the image inside the new canvas', () => {
    const f = frame({ width: 2900, height: 3900, angle: deg(12) });
    expect(frameOverflow(f, W, H)).toBeGreaterThan(0);
    const l = bakeLayout(W, H, f);
    expect(frameOverflow(l.frame, l.width, l.height)).toBe(0);
  });
});

describe('bakeLayout pixel cap', () => {
  it('scales the result down uniformly when the rotated bounding box exceeds the cap', () => {
    const f = frame({ angle: deg(15) });
    const unbounded = bakeLayout(W, H, f, Number.POSITIVE_INFINITY);
    expect(unbounded.width * unbounded.height).toBeGreaterThan(16_000_000);
    const l = bakeLayout(W, H, f);
    expect(l.width * l.height).toBeLessThanOrEqual(16_000_000);
    const s = affineScale(l.transform);
    expect(s).toBeLessThan(1);
    expect(l.frame.width).toBeCloseTo(f.width * s, 6);
    expect(frameOverflow(l.frame, l.width, l.height)).toBeLessThan(1);
    // Original frame corners still map onto the baked frame's corners.
    const mapped = frameCorners(f).map((p) => applyAffine(l.transform, p));
    const target = frameCorners(l.frame);
    mapped.forEach((p, i) => expectPoint(p, target[i]!.x, target[i]!.y));
  });
});

describe('viewTransform', () => {
  it('letterboxes the image into the view without rotation', () => {
    const t = viewTransform(W, H, 0, 390, 700);
    const scale = affineScale(t);
    expect(scale).toBeCloseTo(390 / W, 12);
    expectPoint(applyAffine(t, { x: W / 2, y: H / 2 }), 195, 350);
    expectPoint(applyAffine(t, { x: 0, y: 0 }), 0, 350 - (H * scale) / 2);
  });

  it('turns the image clockwise on screen after one 90° tap (base -90°)', () => {
    const base = rotate90Right(frame()).angle;
    const t = viewTransform(W, H, base, 390, 700);
    // The displayed image is landscape: fits the 390 width.
    const scale = affineScale(t);
    expect(scale).toBeCloseTo(390 / H, 12);
    // Image top-left corner ends up top-right on screen (clockwise turn).
    const tl = applyAffine(t, { x: 0, y: 0 });
    const tr = applyAffine(t, { x: W, y: 0 });
    expect(tl.x).toBeCloseTo(390, 6);
    expect(tr.x).toBeCloseTo(390, 6);
    expect(tl.y).toBeLessThan(tr.y);
  });

  it('inverts', () => {
    const t = viewTransform(W, H, deg(-90), 390, 700);
    const p = { x: 123, y: 456 };
    const back = applyAffine(invertAffine(t), applyAffine(t, p));
    expectPoint(back, p.x, p.y);
  });
});
