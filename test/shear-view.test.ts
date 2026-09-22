// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropRotateView } from '../src/editor';
import { bakeFrame, frameNeedsBake } from '../src/bake';
import { applyAffine, quadCorners, viewTransform } from '../src/geometry';
import type { Capture, Frame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';

const W = 3000;
const H = 4000;
const VIEW_W = 360;
const VIEW_H = 480;

function frame(overrides: Partial<Frame> = {}): Frame {
  return { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...overrides };
}

describe('corner shear and edge crop in the crop/rotate view', () => {
  let stub: CanvasStub;
  let view: CropRotateView;
  let stage: HTMLElement;
  let capture: Capture;
  let confirmed: Frame | null;
  let cancelled: number;

  function pointer(type: string, x: number, y: number): void {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
  }

  function button(label: string): HTMLButtonElement {
    return view.element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  }

  function shownLoupes(): string[] {
    if (stage.querySelector<HTMLElement>('.loupe-cluster')!.hidden) return [];
    return [...stage.querySelectorAll<HTMLElement>('.loupe')].filter((l) => !l.hidden).map((l) => l.dataset.corner!);
  }

  function visibleHandles(): number {
    return [...stage.querySelectorAll('.edit-handle')].filter((h) => h.getAttribute('visibility') === 'visible').length;
  }

  /** The polygon the overlay draws, as CSS pixel points relative to the frame centre. */
  function polygonPoints(): number[][] {
    return stage
      .querySelector('polygon.edit-frame')!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number));
  }

  function cornerOnView(index: number): { x: number; y: number } {
    const t = viewTransform(W, H, 0, VIEW_W, VIEW_H);
    return applyAffine(t, quadCorners(capture.frame)[index]!);
  }

  beforeEach(() => {
    stub = stubCanvas();
    confirmed = null;
    cancelled = 0;
    view = new CropRotateView({
      onCancel: () => {
        cancelled += 1;
      },
      onConfirm: (f) => {
        confirmed = f;
      },
    });
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

  it('offers two segments, opens in the crop/shear mode with all eight handles', () => {
    const group = view.element.querySelector('[role="radiogroup"]')!;
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Zuschneiden und entzerren',
      'Drehen',
    ]);
    expect(button('Zuschneiden und entzerren').getAttribute('aria-checked')).toBe('true');
    expect(stage.dataset.mode).toBe('crop');
    expect(visibleHandles()).toBe(8);
    button('Drehen').click();
    expect(visibleHandles()).toBe(0);
  });

  it('drags one corner on its own, draws the quadrilateral and shows one loupe', () => {
    const before = polygonPoints();
    const se = cornerOnView(2);
    pointer('pointerdown', se.x, se.y);
    pointer('pointermove', se.x - 30, se.y - 12);
    expect(shownLoupes()).toEqual(['se']);
    pointer('pointerup', se.x - 30, se.y - 12);
    expect(shownLoupes()).toEqual([]);
    const after = polygonPoints();
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[3]).toEqual(before[3]);
    expect(after[2]![0]).toBeCloseTo(before[2]![0]! - 30, 6);
    expect(after[2]![1]).toBeCloseTo(before[2]![1]! - 12, 6);
    // Confirm hands over the offsets in image pixels (frame-local).
    button('Bestätigen').click();
    const scale = VIEW_W / W;
    expect(confirmed!.corners![2]!.x).toBeCloseTo(-30 / scale, 6);
    expect(confirmed!.corners![2]!.y).toBeCloseTo(-12 / scale, 6);
    expect(confirmed!.corners![0]).toEqual({ x: 0, y: 0 });
    expect(frameNeedsBake(confirmed!)).toBe(true);
  });

  it('does not move the frame body', () => {
    const before = polygonPoints();
    pointer('pointerdown', VIEW_W / 2, VIEW_H / 2);
    pointer('pointermove', VIEW_W / 2 + 20, VIEW_H / 2 + 20);
    expect(shownLoupes()).toEqual([]);
    pointer('pointerup', VIEW_W / 2 + 20, VIEW_H / 2 + 20);
    expect(polygonPoints()).toEqual(before);
    expect(stage.querySelector('polygon.edit-frame')!.parentElement!.getAttribute('transform')).toContain('translate(180 240)');
  });

  it('keeps the displaced corner when cropping the right edge afterwards', () => {
    const ne = cornerOnView(1);
    pointer('pointerdown', ne.x, ne.y);
    pointer('pointermove', ne.x, ne.y + 20);
    pointer('pointerup', ne.x, ne.y + 20);
    expect(visibleHandles()).toBe(8);
    // The e handle now sits on the midpoint of the displaced right edge.
    const eHandle = stage.querySelectorAll<SVGCircleElement>('.edit-handle')[5]!;
    const ex = Number(eHandle.getAttribute('cx'));
    const ey = Number(eHandle.getAttribute('cy'));
    const centre = applyAffine(viewTransform(W, H, 0, VIEW_W, VIEW_H), { x: 1500, y: 2000 });
    pointer('pointerdown', centre.x + ex, centre.y + ey);
    pointer('pointermove', centre.x + ex - 25, centre.y + ey);
    pointer('pointerup', centre.x + ex - 25, centre.y + ey);
    button('Bestätigen').click();
    const scale = VIEW_W / W;
    expect(confirmed!.width).toBeCloseTo(2000 - 25 / scale, 6);
    expect(confirmed!.corners![1]!.y).toBeCloseTo(20 / scale, 6);
    expect(confirmed!.corners![2]).toEqual({ x: 0, y: 0 });
  });

  it('turns the quadrilateral with the 90° button and discards it on back', () => {
    const sw = cornerOnView(3);
    pointer('pointerdown', sw.x, sw.y);
    pointer('pointermove', sw.x + 15, sw.y);
    pointer('pointerup', sw.x + 15, sw.y);
    for (let i = 0; i < 4; i += 1) button('Um 90° nach rechts drehen').click();
    button('Bestätigen').click();
    const scale = VIEW_W / W;
    expect(confirmed!.angle).toBe(0);
    expect(confirmed!.corners![3]!.x).toBeCloseTo(15 / scale, 6);
    expect(confirmed!.corners![3]!.y).toBeCloseTo(0, 6);

    view.open(capture);
    pointer('pointerdown', sw.x, sw.y);
    pointer('pointermove', sw.x + 15, sw.y);
    pointer('pointerup', sw.x + 15, sw.y);
    button('Zurück').click();
    expect(cancelled).toBe(1);
    expect(capture.frame.corners).toBeUndefined();
  });
});

describe('bakeFrame', () => {
  let stub: CanvasStub;

  beforeEach(() => {
    stub = stubCanvas();
  });

  afterEach(() => {
    stub.restore();
  });

  function capture(): Capture {
    const image = document.createElement('canvas');
    image.width = 300;
    image.height = 400;
    return { image, frame: { cx: 150, cy: 200, width: 200, height: 280, angle: 0 } };
  }

  it('leaves the image untouched for zero offsets and angle 0 (v0.2 regression)', () => {
    const c = capture();
    const zero = { x: 0, y: 0 };
    const pending: Frame = { ...c.frame, cx: 140, corners: [zero, { x: 0.2, y: -0.3 }, zero, zero] };
    const result = bakeFrame(c, pending);
    expect(result.image).toBe(c.image);
    expect(result.frame).toEqual({ ...c.frame, cx: 140 });
    expect(result.frame.corners).toBeUndefined();
    expect(frameNeedsBake(pending)).toBe(false);
  });

  it('warps into a new canvas, releases the old one and returns an upright rectangle', () => {
    const c = capture();
    const source = c.image.getContext('2d')!;
    const read = vi.spyOn(source, 'getImageData');
    const zero = { x: 0, y: 0 };
    const pending: Frame = { ...c.frame, corners: [{ x: 20, y: 0 }, { x: -20, y: 0 }, zero, zero] };
    const result = bakeFrame(c, pending);
    expect(result.image).not.toBe(c.image);
    expect(c.image.width).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.frame.angle).toBe(0);
    expect(result.frame.corners).toBeUndefined();
    expect(result.frame.width).toBeCloseTo(180, 6);
    expect(result.frame.height).toBeCloseTo(Math.hypot(20, 280), 6);
    expect(result.image.width).toBeGreaterThan(result.frame.width);
    expect(result.image.height).toBeGreaterThan(result.frame.height);
  });

  it('falls back to half resolution when the full read fails', () => {
    const c = capture();
    const source = c.image.getContext('2d')!;
    let calls = 0;
    const original = source.getImageData.bind(source);
    vi.spyOn(source, 'getImageData').mockImplementation((x, y, w, h) => {
      calls += 1;
      if (w === 300) throw new Error('out of memory');
      return original(x, y, w, h);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zero = { x: 0, y: 0 };
    const result = bakeFrame(c, { ...c.frame, corners: [{ x: 20, y: 0 }, zero, zero, zero] });
    expect(result.image).not.toBe(c.image);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });
});
