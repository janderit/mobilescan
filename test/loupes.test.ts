// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropRotateView } from '../src/editor';
import { affineScale, applyAffine, frameCorners, invertAffine, viewTransform } from '../src/geometry';
import {
  LOUPE_DIAMETER,
  LOUPE_GAP,
  LOUPE_INNER,
  LOUPE_SUPPRESS_MARGIN,
  clusterBounds,
  loupeCorners,
  loupeLayout,
  loupeScale,
  loupeSourceRect,
  loupeTransform,
  loupesSuppressed,
  placeLoupes,
} from '../src/loupe';
import type { Capture, Frame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';

const deg = (d: number): number => (d * Math.PI) / 180;
const W = 3000;
const H = 4000;
const VIEW_W = 360;
const VIEW_H = 480;

function frame(overrides: Partial<Frame> = {}): Frame {
  return { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...overrides };
}

describe('loupe corners', () => {
  it('follow what the drag affects', () => {
    expect(loupeCorners('nw')).toEqual(['nw']);
    expect(loupeCorners('se')).toEqual(['se']);
    expect(loupeCorners('n')).toEqual(['nw', 'ne']);
    expect(loupeCorners('s')).toEqual(['sw', 'se']);
    expect(loupeCorners('e')).toEqual(['ne', 'se']);
    expect(loupeCorners('w')).toEqual(['nw', 'sw']);
    expect(loupeCorners('move')).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(loupeCorners('rotate')).toEqual(['nw', 'ne', 'se', 'sw']);
  });
});

describe('loupe layout', () => {
  const step = (LOUPE_DIAMETER + LOUPE_GAP) / 2;

  it('centres a single loupe on the stage', () => {
    expect(loupeLayout(['ne'], VIEW_W, VIEW_H)).toEqual([{ corner: 'ne', x: 180, y: 240 }]);
  });

  it('puts the corners of a horizontal edge side by side, mirroring their positions', () => {
    const [nw, ne] = loupeLayout(['nw', 'ne'], VIEW_W, VIEW_H);
    expect(nw).toEqual({ corner: 'nw', x: 180 - step, y: 240 });
    expect(ne).toEqual({ corner: 'ne', x: 180 + step, y: 240 });
    const [sw, se] = loupeLayout(['sw', 'se'], VIEW_W, VIEW_H);
    expect(sw!.x).toBeLessThan(se!.x);
    expect(sw!.y).toBe(se!.y);
  });

  it('stacks the corners of a vertical edge', () => {
    const [ne, se] = loupeLayout(['ne', 'se'], VIEW_W, VIEW_H);
    expect(ne).toEqual({ corner: 'ne', x: 180, y: 240 - step });
    expect(se).toEqual({ corner: 'se', x: 180, y: 240 + step });
  });

  it('arranges four loupes in a 2x2 grid in corner order', () => {
    const grid = loupeLayout(['nw', 'ne', 'se', 'sw'], VIEW_W, VIEW_H);
    expect(grid).toEqual([
      { corner: 'nw', x: 180 - step, y: 240 - step },
      { corner: 'ne', x: 180 + step, y: 240 - step },
      { corner: 'se', x: 180 + step, y: 240 + step },
      { corner: 'sw', x: 180 - step, y: 240 + step },
    ]);
    const b = clusterBounds(grid);
    expect(b.width).toBe(2 * LOUPE_DIAMETER + LOUPE_GAP);
    expect(b.height).toBe(2 * LOUPE_DIAMETER + LOUPE_GAP);
    expect(b.x + b.width / 2).toBe(180);
  });

  it('suppresses the cluster when the drag starts inside its inflated bounds', () => {
    const layout = loupeLayout(['nw'], VIEW_W, VIEW_H);
    const edge = 180 - LOUPE_DIAMETER / 2 - LOUPE_SUPPRESS_MARGIN;
    expect(loupesSuppressed(layout, { x: 180, y: 240 })).toBe(true);
    expect(loupesSuppressed(layout, { x: edge + 1, y: 240 })).toBe(true);
    expect(loupesSuppressed(layout, { x: edge, y: 240 })).toBe(false);
    expect(loupesSuppressed(layout, { x: 20, y: 20 })).toBe(false);
  });
});

describe('loupe placement', () => {
  const size = 2 * LOUPE_DIAMETER + LOUPE_GAP;

  it('keeps the cluster centred when the finger is clear of it', () => {
    expect(placeLoupes(['nw'], VIEW_W, VIEW_H, { x: 20, y: 20 })).toEqual(loupeLayout(['nw'], VIEW_W, VIEW_H));
  });

  it('moves a body-drag grid above a finger in the lower half of the stage', () => {
    const all = ['nw', 'ne', 'se', 'sw'] as const;
    const start = { x: 200, y: 300 };
    const placed = placeLoupes(all, VIEW_W, VIEW_H, start)!;
    const b = clusterBounds(placed);
    expect(b.y + b.height).toBe(start.y - LOUPE_SUPPRESS_MARGIN);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width / 2).toBe(VIEW_W / 2);
    expect(placed.map((l) => l.corner)).toEqual([...all]);
    expect(loupesSuppressed(placed, start)).toBe(false);
  });

  it('moves the cluster below a finger in the upper half', () => {
    const start = { x: 180, y: 200 };
    const b = clusterBounds(placeLoupes(['nw', 'ne'], VIEW_W, VIEW_H, start)!);
    expect(b.y).toBe(start.y + LOUPE_SUPPRESS_MARGIN);
    expect(b.y + b.height).toBeLessThanOrEqual(VIEW_H);
  });

  it('falls back to a horizontal shift and then to no loupes', () => {
    const all = ['nw', 'ne', 'se', 'sw'] as const;
    // Stage too low to shift vertically, wide enough to shift sideways.
    const wide = placeLoupes(all, 600, size + 20, { x: 310, y: 100 })!;
    const b = clusterBounds(wide);
    expect(b.x + b.width).toBe(310 - LOUPE_SUPPRESS_MARGIN);
    expect(b.y).toBe(10);
    // Nothing fits: the drag gets no loupes.
    expect(placeLoupes(all, size + 20, size + 20, { x: 100, y: 100 })).toBeNull();
  });
});

describe('loupe magnification', () => {
  it('is three times the view scale', () => {
    expect(loupeScale(0.1, 2)).toBeCloseTo(0.3, 9);
  });

  it('never stretches an image pixel beyond two device pixels', () => {
    expect(loupeScale(0.5, 2)).toBeCloseTo(1, 9);
    expect(loupeScale(0.5, 1)).toBeCloseTo(1.5, 9);
    expect(loupeScale(1, 3)).toBeCloseTo(2 / 3, 9);
  });

  it('reads a source square whose size does not depend on the capture', () => {
    const src = loupeSourceRect({ x: 1500, y: 2000 }, 0.5, W, H)!;
    expect(src.width).toBe(LOUPE_INNER / 0.5 + 4);
    expect(src.height).toBe(src.width);
    const clipped = loupeSourceRect({ x: 10, y: 10 }, 0.5, W, H)!;
    expect(clipped.x).toBe(0);
    expect(clipped.y).toBe(0);
    expect(clipped.width).toBe(10 + LOUPE_INNER / 0.5 / 2 + 2);
    expect(loupeSourceRect({ x: -500, y: -500 }, 0.5, W, H)).toBeNull();
  });
});

describe('loupe transform', () => {
  it.each([0, deg(-90), deg(90), deg(180)])('meets the main view on the frame edge (base %f)', (base) => {
    const f = frame({ angle: base + deg(4) });
    const view = viewTransform(W, H, base, VIEW_W, VIEW_H);
    const scale = loupeScale(affineScale(view), 2);
    const [nw, ne] = frameCorners(f) as [{ x: number; y: number }, { x: number; y: number }];
    const t = loupeTransform(nw, base, scale);
    // The corner sits at the loupe centre.
    const centre = applyAffine(t, nw);
    expect(centre.x).toBeCloseTo(LOUPE_INNER / 2, 9);
    expect(centre.y).toBeCloseTo(LOUPE_INNER / 2, 9);
    // A point a little way along the top edge leaves the centre in the same
    // direction as on the main view, magnified by scale / viewScale.
    const along = { x: nw.x + (ne.x - nw.x) * 0.01, y: nw.y + (ne.y - nw.y) * 0.01 };
    const inLoupe = applyAffine(t, along);
    const onView = applyAffine(view, along);
    const cornerOnView = applyAffine(view, nw);
    const k = scale / affineScale(view);
    expect(inLoupe.x - centre.x).toBeCloseTo((onView.x - cornerOnView.x) * k, 9);
    expect(inLoupe.y - centre.y).toBeCloseTo((onView.y - cornerOnView.y) * k, 9);
    // And mapping a loupe pixel back to the image and on to the view lands on the same image pixel.
    const back = applyAffine(invertAffine(t), inLoupe);
    expect(back.x).toBeCloseTo(along.x, 6);
    expect(back.y).toBeCloseTo(along.y, 6);
  });
});

describe('CropRotateView loupes', () => {
  let stub: CanvasStub;
  let view: CropRotateView;
  let stage: HTMLElement;
  let capture: Capture;

  function pointer(type: string, x: number, y: number): void {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
  }

  function shownLoupes(): string[] {
    if (stage.querySelector<HTMLElement>('.loupe-cluster')!.hidden) return [];
    return [...stage.querySelectorAll<HTMLElement>('.loupe')].filter((l) => !l.hidden).map((l) => l.dataset.corner!);
  }

  /** Where a frame corner sits on the stage in CSS pixels. */
  function cornerOnView(index: number): { x: number; y: number } {
    const t = viewTransform(W, H, 0, VIEW_W, VIEW_H);
    return applyAffine(t, frameCorners(capture.frame)[index]!);
  }

  beforeEach(() => {
    stub = stubCanvas();
    view = new CropRotateView({ onCancel: () => {}, onConfirm: () => {} });
    document.body.append(view.element);
    stage = view.element.querySelector<HTMLElement>('.edit-stage')!;
    Object.defineProperty(stage, 'clientWidth', { value: VIEW_W, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: VIEW_H, configurable: true });
    stage.setPointerCapture = () => {};
    stage.releasePointerCapture = () => {};
    stage.hasPointerCapture = () => false;
    const image = document.createElement('canvas');
    image.width = W;
    image.height = H;
    capture = { image, frame: frame() };
    view.open(capture);
  });

  afterEach(() => {
    view.close();
    view.element.remove();
    stub.restore();
  });

  it('shows one loupe on the first move of a corner drag and hides it on release', () => {
    const nw = cornerOnView(0);
    pointer('pointerdown', nw.x, nw.y);
    expect(shownLoupes()).toEqual([]);
    pointer('pointermove', nw.x + 5, nw.y + 5);
    expect(shownLoupes()).toEqual(['nw']);
    const bounds = view.visibleLoupeBounds!;
    expect(bounds.x + bounds.width / 2).toBe(VIEW_W / 2);
    expect(bounds.y + bounds.height / 2).toBe(VIEW_H / 2);
    pointer('pointerup', nw.x + 5, nw.y + 5);
    expect(shownLoupes()).toEqual([]);
    expect(view.visibleLoupeBounds).toBeNull();
  });

  it('shows two loupes for an edge and four for a body drag', () => {
    const nw = cornerOnView(0);
    const ne = cornerOnView(1);
    pointer('pointerdown', (nw.x + ne.x) / 2, nw.y);
    pointer('pointermove', (nw.x + ne.x) / 2, nw.y + 3);
    expect(shownLoupes()).toEqual(['nw', 'ne']);
    pointer('pointercancel', (nw.x + ne.x) / 2, nw.y + 3);
    expect(shownLoupes()).toEqual([]);

    // Body drag starting in the stage centre: the grid moves out from under the finger.
    pointer('pointerdown', VIEW_W / 2, VIEW_H / 2 + 10);
    pointer('pointermove', VIEW_W / 2 + 3, VIEW_H / 2 + 13);
    expect(shownLoupes()).toEqual(['nw', 'ne', 'se', 'sw']);
    const bounds = view.visibleLoupeBounds!;
    expect(bounds.y + bounds.height).toBe(VIEW_H / 2 + 10 - LOUPE_SUPPRESS_MARGIN);
    pointer('pointerup', VIEW_W / 2 + 3, VIEW_H / 2 + 13);
    expect(shownLoupes()).toEqual([]);
  });

  it('shows four loupes during fine rotation', () => {
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Drehen"]')!.click();
    const nw = cornerOnView(0);
    pointer('pointerdown', nw.x, nw.y);
    pointer('pointermove', nw.x + 4, nw.y);
    expect(shownLoupes()).toEqual(['nw', 'ne', 'se', 'sw']);
    pointer('pointerup', nw.x + 4, nw.y);
    expect(shownLoupes()).toEqual([]);
  });

  it('moves a single loupe away from a corner dragged in the stage centre', () => {
    // A small frame whose nw corner lies in the stage centre.
    capture.frame = frame({ cx: 1500 + 600, cy: 2000 + 700, width: 1000, height: 1200 });
    view.open(capture);
    const nw = cornerOnView(0);
    expect(Math.abs(nw.x - VIEW_W / 2)).toBeLessThan(LOUPE_DIAMETER / 2);
    pointer('pointerdown', nw.x, nw.y);
    pointer('pointermove', nw.x + 5, nw.y + 5);
    expect(shownLoupes()).toEqual(['nw']);
    const b = view.visibleLoupeBounds!;
    expect(b.y + b.height <= nw.y - LOUPE_SUPPRESS_MARGIN || b.y >= nw.y + LOUPE_SUPPRESS_MARGIN).toBe(true);
    pointer('pointerup', nw.x + 5, nw.y + 5);
    expect(shownLoupes()).toEqual([]);
  });

  it('shows nothing when the stage is too small to place the cluster clear of the finger', () => {
    Object.defineProperty(stage, 'clientWidth', { value: 120, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: 120, configurable: true });
    view.layout();
    pointer('pointerdown', 60, 60);
    pointer('pointermove', 63, 63);
    expect(shownLoupes()).toEqual([]);
    pointer('pointerup', 63, 63);
  });

  it('draws each visible loupe on every move', () => {
    const loupeCanvas = stage.querySelector<HTMLCanvasElement>('.loupe[data-corner="nw"] canvas')!;
    const loupeCtx = loupeCanvas.getContext('2d')!;
    const draw = vi.spyOn(loupeCtx, 'drawImage');
    const stroke = vi.spyOn(loupeCtx, 'stroke');
    const nw = cornerOnView(0);
    pointer('pointerdown', nw.x, nw.y);
    pointer('pointermove', nw.x + 5, nw.y + 5);
    pointer('pointermove', nw.x + 8, nw.y + 8);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(stroke).toHaveBeenCalledTimes(2);
    expect(loupeCanvas.width).toBe(LOUPE_INNER * Math.min(2, window.devicePixelRatio || 1));
    pointer('pointerup', nw.x + 8, nw.y + 8);
    view.close();
    expect(loupeCanvas.width).toBe(0);
  });
});
