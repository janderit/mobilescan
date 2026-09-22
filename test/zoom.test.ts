import { describe, expect, it } from 'vitest';
import { applyAffine, frameCorners, viewTransform } from '../src/geometry';
import {
  DOUBLE_TAP_ZOOM,
  IDENTITY_ZOOM,
  MAX_ZOOM,
  applyZoom,
  clampZoom,
  composeZoom,
  doubleTapZoom,
  fitRectTransform,
  maxZoomScale,
  panZoom,
  pinchZoom,
  relativeZoom,
  type ZoomState,
} from '../src/zoom';

const VIEW_W = 360;
const VIEW_H = 480;
/** The fitted content of a 3:4 image in a 3:4 stage: the whole stage. */
const CONTENT = { x: 0, y: 0, width: VIEW_W, height: VIEW_H };

describe('pinch', () => {
  it('doubles the scale when the finger distance doubles and keeps the midpoint fixed', () => {
    const from = [
      { x: 100, y: 200 },
      { x: 200, y: 200 },
    ] as const;
    const to = [
      { x: 50, y: 200 },
      { x: 250, y: 200 },
    ] as const;
    const z = pinchZoom({ ...IDENTITY_ZOOM }, from, to);
    expect(z.scale).toBeCloseTo(2, 12);
    // The stage point under the old midpoint (150, 200) is the fitted point (150, 200);
    // it must now sit under the new midpoint (150, 200).
    const under = applyZoom(z, { x: 150, y: 200 });
    expect(Math.abs(under.x - 150)).toBeLessThan(1e-9);
    expect(Math.abs(under.y - 200)).toBeLessThan(1e-9);
  });

  it('lets the midpoint drag the content along', () => {
    const start: ZoomState = { scale: 2, tx: -100, ty: -50 };
    const from = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ] as const;
    const to = [
      { x: 130, y: 140 },
      { x: 230, y: 140 },
    ] as const;
    const z = pinchZoom(start, from, to);
    expect(z.scale).toBeCloseTo(2, 12);
    // Fitted point under the old midpoint...
    const fitted = { x: (150 - start.tx) / start.scale, y: (100 - start.ty) / start.scale };
    // ...is under the new midpoint now.
    const under = applyZoom(z, fitted);
    expect(under.x).toBeCloseTo(180, 9);
    expect(under.y).toBeCloseTo(140, 9);
  });

  it('holds the midpoint when the scale hits the cap', () => {
    const from = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
    ] as const;
    const to = [
      { x: 0, y: 100 },
      { x: 210, y: 100 },
    ] as const;
    const z = pinchZoom({ ...IDENTITY_ZOOM }, from, to, 4);
    expect(z.scale).toBe(4);
    const under = applyZoom(z, { x: 105, y: 100 });
    expect(under.x).toBeCloseTo(105, 9);
    expect(under.y).toBeCloseTo(100, 9);
  });
});

describe('clamp', () => {
  it('pinching out below the fitted view gives scale 1 with zero translation', () => {
    const from = [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ] as const;
    const to = [
      { x: 150, y: 210 },
      { x: 250, y: 210 },
    ] as const;
    const pinched = pinchZoom({ scale: 1.5, tx: -90, ty: -120 }, from, to);
    expect(clampZoom(pinched, CONTENT, VIEW_W, VIEW_H)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('panning past the content edge clamps so the content still covers the stage', () => {
    const zoomed: ZoomState = { scale: 2, tx: -180, ty: -240 };
    // Pan far to the right and down: the content's left/top edge may not pass the stage edge.
    const panned = panZoom(zoomed, 500, 700);
    expect(clampZoom(panned, CONTENT, VIEW_W, VIEW_H)).toEqual({ scale: 2, tx: 0, ty: 0 });
    // Far to the left and up: the right/bottom edge stays at the stage edge.
    const other = clampZoom(panZoom(zoomed, -900, -900), CONTENT, VIEW_W, VIEW_H);
    expect(other.tx).toBeCloseTo(VIEW_W - 2 * VIEW_W, 9);
    expect(other.ty).toBeCloseTo(VIEW_H - 2 * VIEW_H, 9);
    // Inside the range nothing changes.
    expect(clampZoom(zoomed, CONTENT, VIEW_W, VIEW_H)).toEqual(zoomed);
  });

  it('centres content that is smaller than the stage on that axis', () => {
    // A wide letterboxed content: 360 x 200 centred in the stage.
    const content = { x: 0, y: 140, width: 360, height: 200 };
    const z = clampZoom({ scale: 1.5, tx: -100, ty: 999 }, content, VIEW_W, VIEW_H);
    expect(z.scale).toBe(1.5);
    expect(z.tx).toBe(-100);
    // 200 * 1.5 = 300 < 480: centred vertically.
    expect(z.ty).toBeCloseTo(VIEW_H / 2 - (140 + 100) * 1.5, 9);
  });

  it('limits the scale to the maximum', () => {
    const z = clampZoom({ scale: 20, tx: -1000, ty: -3000 }, CONTENT, VIEW_W, VIEW_H, 5);
    expect(z.scale).toBe(5);
    expect(z.tx).toBe(-1000); // within [-1440, 0]
    expect(z.ty).toBeCloseTo(VIEW_H - 5 * VIEW_H, 9);
  });
});

describe('maximum scale', () => {
  it('is 8, or less when an image pixel would exceed two device pixels', () => {
    // 3000 px image at 0.12 CSS px per image px, dpr 2: cap at 2 / (2 * 0.12) = 8.33 -> 8.
    expect(maxZoomScale(0.12, 2)).toBe(MAX_ZOOM);
    // dpr 3: 2 / (3 * 0.12) = 5.55.
    expect(maxZoomScale(0.12, 3)).toBeCloseTo(5.5555, 3);
    // A tiny image already shown at 2 device px per image px: no zoom.
    expect(maxZoomScale(1, 2)).toBe(1);
    expect(maxZoomScale(4, 2)).toBe(1);
  });
});

describe('composition', () => {
  it('mapping a frame corner through the composed transform equals fitted then zoom', () => {
    const fitted = viewTransform(3000, 4000, -Math.PI / 2, VIEW_W, VIEW_H);
    const z: ZoomState = { scale: 2.5, tx: -123.4, ty: -321 };
    const composed = composeZoom(z, fitted);
    const frame = { cx: 1400, cy: 2100, width: 2000, height: 2800, angle: (-Math.PI / 2) + 0.1 };
    for (const corner of frameCorners(frame)) {
      const direct = applyAffine(composed, corner);
      const stepwise = applyZoom(z, applyAffine(fitted, corner));
      expect(direct.x).toBeCloseTo(stepwise.x, 9);
      expect(direct.y).toBeCloseTo(stepwise.y, 9);
    }
  });

  it('relativeZoom expresses the live state against the drawn one', () => {
    const drawn: ZoomState = { scale: 2, tx: -100, ty: -50 };
    const live: ZoomState = { scale: 3, tx: -400, ty: -200 };
    const rel = relativeZoom(live, drawn);
    // rel ∘ drawn == live for any fitted point.
    const p = { x: 77, y: 33 };
    const viaDrawn = applyZoom(rel, applyZoom(drawn, p));
    const direct = applyZoom(live, p);
    expect(viaDrawn.x).toBeCloseTo(direct.x, 9);
    expect(viaDrawn.y).toBeCloseTo(direct.y, 9);
  });

  it('letterboxes a frame rectangle into the stage', () => {
    const t = fitRectTransform({ x: 500, y: 600, width: 2000, height: 2800 }, VIEW_W, VIEW_H);
    // 480 / 2800 = 0.1714 limits; the 2000 px width becomes 342.9 px, centred.
    expect(t.a).toBeCloseTo(480 / 2800, 12);
    const nw = applyAffine(t, { x: 500, y: 600 });
    const se = applyAffine(t, { x: 2500, y: 3400 });
    expect(nw.y).toBeCloseTo(0, 9);
    expect(se.y).toBeCloseTo(VIEW_H, 9);
    expect(nw.x).toBeCloseTo((VIEW_W - 2000 * t.a) / 2, 9);
    expect(se.x).toBeCloseTo(VIEW_W - nw.x, 9);
  });
});

describe('double tap', () => {
  it('goes to 3x with the tapped point kept under the finger, and back to fitted', () => {
    const at = { x: 100, y: 300 };
    const z = doubleTapZoom({ ...IDENTITY_ZOOM }, at);
    expect(z.scale).toBe(DOUBLE_TAP_ZOOM);
    const under = applyZoom(z, at);
    expect(under.x).toBeCloseTo(at.x, 9);
    expect(under.y).toBeCloseTo(at.y, 9);
    expect(doubleTapZoom(z, { x: 5, y: 5 })).toEqual(IDENTITY_ZOOM);
  });

  it('stops at the maximum when that is below 3x', () => {
    expect(doubleTapZoom({ ...IDENTITY_ZOOM }, { x: 0, y: 0 }, 2).scale).toBe(2);
  });
});
