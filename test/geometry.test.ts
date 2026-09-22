import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURE_PIXELS,
  SQRT2,
  captureSize,
  applyAffine,
  boundsOf,
  coverTransform,
  frameCorners,
  frameSourceRect,
  scaleFrame,
  uprightFrame,
  visibleImageRect,
  initialFrame,
  type Affine,
  type Rect,
} from '../src/geometry';
import type { Frame, UprightFrame } from '../src/model';

/** The (upright) frame mapped through a cover transform, as a view rectangle. */
function frameViewRect(frame: Frame, t: Affine): Rect {
  return boundsOf(frameCorners(frame).map((p) => applyAffine(t, p)));
}

describe('initialFrame', () => {
  it('clamps the height when 0.9 * width * sqrt2 exceeds 0.9 * height', () => {
    // 3000 x 4000: 0.9 * 3000 = 2700 wide would need 3818.4 of height,
    // but only 3600 (0.9 * 4000) is available, so both shrink proportionally.
    const frame = initialFrame(3000, 4000);
    expect(frame.height).toBeCloseTo(3600, 6);
    expect(frame.width).toBeCloseTo(3600 / SQRT2, 6);
    expect(frame.height / frame.width).toBeCloseTo(SQRT2, 12);
  });

  it('uses the full 90 % of the width on a tall image', () => {
    const frame = initialFrame(1000, 2000);
    expect(frame.width).toBeCloseTo(900, 6);
    expect(frame.height).toBeCloseTo(900 * SQRT2, 6);
    expect(frame.height).toBeLessThanOrEqual(0.9 * 2000);
  });

  it('is exactly 1:sqrt2 for an image that is itself 1:sqrt2', () => {
    const frame = initialFrame(1000, 1000 * SQRT2);
    expect(frame.width).toBeCloseTo(900, 6);
    expect(frame.height).toBeCloseTo(900 * SQRT2, 6);
  });

  it('is centred and unrotated', () => {
    const frame = initialFrame(3000, 4000);
    expect(frame.cx).toBe(1500);
    expect(frame.cy).toBe(2000);
    expect(frame.angle).toBe(0);
  });

  it('never leaves the image bounds', () => {
    for (const [w, h] of [
      [3000, 4000],
      [1000, 2000],
      [4000, 3000],
      [1080, 1920],
    ] as const) {
      const frame = initialFrame(w, h);
      expect(frame.cx - frame.width / 2).toBeGreaterThanOrEqual(0);
      expect(frame.cy - frame.height / 2).toBeGreaterThanOrEqual(0);
      expect(frame.cx + frame.width / 2).toBeLessThanOrEqual(w);
      expect(frame.cy + frame.height / 2).toBeLessThanOrEqual(h);
    }
  });
});

describe('captureSize', () => {
  it('returns the track size unchanged when it fits', () => {
    expect(captureSize(3000, 4000)).toEqual({ width: 3000, height: 4000 });
    expect(3000 * 4000).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS);
  });

  it('returns the track size unchanged exactly at the cap', () => {
    expect(captureSize(4000, 4000, 16_000_000)).toEqual({ width: 4000, height: 4000 });
  });

  it('scales down uniformly when the track exceeds the cap', () => {
    const track = { width: 6000, height: 8000 };
    const size = captureSize(track.width, track.height);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS);
    expect(Number.isInteger(size.width)).toBe(true);
    expect(Number.isInteger(size.height)).toBe(true);
    // Aspect preserved to within the rounding to whole pixels.
    expect(size.width / size.height).toBeCloseTo(track.width / track.height, 3);
    // And it is not scaled down more than necessary.
    expect((size.width + 2) * (size.height + 2)).toBeGreaterThan(MAX_CAPTURE_PIXELS);
  });

  it('honours a custom cap', () => {
    const size = captureSize(2000, 1000, 1_000_000);
    expect(size.width * size.height).toBeLessThanOrEqual(1_000_000);
    expect(size.width).toBe(1414);
    expect(size.height).toBe(707);
  });
});

describe('coverTransform', () => {
  it('fills the view and centres the overflow on the wide axis', () => {
    // A 3000 x 4000 capture shown full-bleed in a 390 x 844 CSS viewport.
    const t = coverTransform(3000, 4000, 390, 844);
    expect(t.a).toBeCloseTo(844 / 4000, 12);
    expect(t.d).toBe(t.a);
    expect(t.b).toBe(0);
    expect(t.c).toBe(0);
    expect(t.f).toBeCloseTo(0, 12);
    expect(t.e).toBeLessThan(0);
    // Both view axes are fully covered.
    expect(3000 * t.a + 2 * t.e).toBeCloseTo(390, 9);
    expect(4000 * t.d + 2 * t.f).toBeCloseTo(844, 9);
  });

  it('maps the source centre to the view centre', () => {
    const t = coverTransform(3000, 4000, 390, 844);
    const centre = applyAffine(t, { x: 1500, y: 2000 });
    expect(centre.x).toBeCloseTo(195, 9);
    expect(centre.y).toBeCloseTo(422, 9);
  });
});

describe('frame through the cover transform', () => {
  it('places the frame centred in the view and scaled by the cover transform', () => {
    const frame = initialFrame(3000, 4000);
    const t = coverTransform(3000, 4000, 390, 844);
    const rect = frameViewRect(frame, t);

    expect(rect.x + rect.width / 2).toBeCloseTo(195, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(422, 9);
    expect(rect.width).toBeCloseTo(frame.width * t.a, 9);
    expect(rect.height).toBeCloseTo(frame.height * t.a, 9);
    expect(rect.height / rect.width).toBeCloseTo(SQRT2, 12);
    // The frame is visible inside the viewport on the covered axis.
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(844 + 1e-9);
  });
});

describe('frameSourceRect', () => {
  it('is the frame expressed as a top-left source rect', () => {
    const rect = frameSourceRect({ cx: 1500, cy: 2000, width: 900, height: 1200, angle: 0 });
    expect(rect).toEqual({ x: 1050, y: 1400, width: 900, height: 1200 });
  });
});

describe('visibleImageRect', () => {
  it('shows the full source when the aspect ratios match', () => {
    expect(visibleImageRect(300, 400, 600, 800)).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });

  it('crops the sides of a 3:4 source shown on a tall phone screen', () => {
    const v = visibleImageRect(3000, 4000, 390, 844);
    // cover scales by 844/4000; visible width = 390 / that scale
    expect(v.height).toBeCloseTo(4000, 6);
    expect(v.width).toBeCloseTo((390 * 4000) / 844, 6);
    expect(v.y).toBe(0);
    expect(v.x).toBeCloseTo((3000 - v.width) / 2, 6);
  });

  it('crops top and bottom of a portrait source shown in a landscape view', () => {
    const v = visibleImageRect(3000, 4000, 1450, 840);
    expect(v.width).toBeCloseTo(3000, 6);
    expect(v.x).toBe(0);
    expect(v.height).toBeCloseTo((840 * 3000) / 1450, 6);
    expect(v.y).toBeCloseTo((4000 - v.height) / 2, 6);
  });
});

describe('initialFrame with a visible region', () => {
  it('fits the frame into the visible region and centres it there', () => {
    const visible = visibleImageRect(3000, 4000, 390, 844);
    const frame = initialFrame(3000, 4000, visible);
    expect(frame.width).toBeCloseTo(0.9 * visible.width, 6);
    expect(frame.height).toBeCloseTo(frame.width * SQRT2, 6);
    expect(frame.cx).toBeCloseTo(1500, 6);
    expect(frame.cy).toBeCloseTo(2000, 6);
    // and therefore lies fully inside the screen once mapped back
    const rect = frameViewRect(frame, coverTransform(3000, 4000, 390, 844));
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(390 + 1e-6);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(844 + 1e-6);
  });
});

describe('scaleFrame', () => {
  it('scales centre and size, keeps the angle', () => {
    const frame = scaleFrame({ cx: 100, cy: 200, width: 50, height: 70, angle: 0.1 }, 0.5);
    expect(frame).toEqual({ cx: 50, cy: 100, width: 25, height: 35, angle: 0.1 });
  });
});

describe('uprightFrame', () => {
  const rect = { cx: 100, cy: 200, width: 50, height: 70 };

  it('returns the rectangle of a frame with angle 0 and no offsets', () => {
    const pending: Frame = { ...rect, angle: 0, corners: [{ x: 0.2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] };
    expect(uprightFrame(pending)).toEqual({ ...rect, angle: 0 });
  });

  it('throws for a rotated or sheared frame', () => {
    expect(() => uprightFrame({ ...rect, angle: 0.01 })).toThrow();
    const sheared: Frame = { ...rect, angle: 0, corners: [{ x: 3, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] };
    expect(() => uprightFrame(sheared)).toThrow();
  });

  it('scaleFrame keeps an upright frame upright', () => {
    const upright: UprightFrame = { ...rect, angle: 0 };
    const scaled: UprightFrame = scaleFrame(upright, 2);
    expect(scaled).toEqual({ cx: 200, cy: 400, width: 100, height: 140, angle: 0 });
  });
});
