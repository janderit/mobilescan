// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropRotateView } from '../src/editor';
import { ToneView } from '../src/tone-view';
import { App } from '../src/app';
import { affineScale, applyAffine, quadCorners, viewTransform } from '../src/geometry';
import type { Capture, Frame, UprightFrame } from '../src/model';
import { composeZoom, DOUBLE_TAP_ZOOM, IDENTITY_ZOOM } from '../src/zoom';
import type { CameraSession } from '../src/camera';
import { stubCanvas, type CanvasStub } from './canvas-stub';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return { ...actual, startCamera: vi.fn(), stopCamera: vi.fn() };
});

import { startCamera } from '../src/camera';

const W = 3000;
const H = 4000;
const VIEW_W = 360;
const VIEW_H = 480;

function frame(overrides: Partial<UprightFrame> = {}): UprightFrame {
  return { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...overrides };
}

function sizeStage(stage: HTMLElement, width = VIEW_W, height = VIEW_H): void {
  Object.defineProperty(stage, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: height, configurable: true });
  stage.setPointerCapture = () => {};
  stage.releasePointerCapture = () => {};
  stage.hasPointerCapture = () => false;
}

function pointer(target: HTMLElement, type: string, id: number, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: id, isPrimary: id === 1, clientX: x, clientY: y, bubbles: true }),
  );
}

/** Two fingers: down at `a0`/`b0`, move to `a1`/`b1`, lift both. */
function pinch(
  target: HTMLElement,
  a0: [number, number],
  b0: [number, number],
  a1: [number, number],
  b1: [number, number],
  release = true,
): void {
  pointer(target, 'pointerdown', 1, ...a0);
  pointer(target, 'pointerdown', 2, ...b0);
  pointer(target, 'pointermove', 1, ...a1);
  pointer(target, 'pointermove', 2, ...b1);
  if (release) {
    pointer(target, 'pointerup', 2, ...b1);
    pointer(target, 'pointerup', 1, ...a1);
  }
}

function doubleTap(target: HTMLElement, x: number, y: number): void {
  pointer(target, 'pointerdown', 1, x, y);
  pointer(target, 'pointerup', 1, x, y);
  pointer(target, 'pointerdown', 1, x, y);
  pointer(target, 'pointerup', 1, x, y);
}

describe('zoom in the crop/rotate view (v0.9)', () => {
  let stub: CanvasStub;
  let view: CropRotateView;
  let stage: HTMLElement;
  let capture: Capture;
  let confirmed: Frame | null;

  function shownLoupes(): string[] {
    if (stage.querySelector<HTMLElement>('.loupe-cluster')!.hidden) return [];
    return [...stage.querySelectorAll<HTMLElement>('.loupe')].filter((l) => !l.hidden).map((l) => l.dataset.corner!);
  }

  function handleCentre(handle: string): { x: number; y: number } {
    const circles = [...stage.querySelectorAll<SVGCircleElement>('.edit-handle')];
    const circle = circles[['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'].indexOf(handle)]!;
    const group = circle.parentElement!;
    const translate = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(group.getAttribute('transform')!)!;
    return { x: Number(translate[1]) + Number(circle.getAttribute('cx')), y: Number(translate[2]) + Number(circle.getAttribute('cy')) };
  }

  beforeEach(() => {
    stub = stubCanvas();
    confirmed = null;
    view = new CropRotateView({
      onCancel: () => {},
      onConfirm: (f) => {
        confirmed = f;
      },
      onNotice: () => {},
    });
    document.body.append(view.element);
    stage = view.element.querySelector<HTMLElement>('.edit-stage')!;
    sizeStage(stage);
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

  it('wraps the canvas but not the overlay, and starts fitted', () => {
    expect(stage.querySelector('.zoom-wrapper > canvas.edit-canvas')).not.toBeNull();
    expect(stage.querySelector('.zoom-wrapper > svg')).toBeNull();
    expect(stage.querySelector(':scope > svg.edit-overlay')).not.toBeNull();
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
  });

  it('pinches to twice the scale around the midpoint, moving the canvas by CSS only, then redraws', () => {
    const ctx = stage.querySelector<HTMLCanvasElement>('canvas.edit-canvas')!.getContext('2d')!;
    const draw = vi.spyOn(ctx, 'drawImage');
    const wrapper = stage.querySelector<HTMLElement>('.zoom-wrapper')!;
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240], false);
    expect(view.zoom.scale).toBeCloseTo(2, 9);
    // The image point under the midpoint (180, 240) stayed put.
    const fitted = viewTransform(W, H, 0, VIEW_W, VIEW_H);
    const composed = composeZoom(view.zoom, fitted);
    const imagePoint = { x: 1500, y: 2000 };
    const before = applyAffine(fitted, imagePoint);
    const after = applyAffine(composed, imagePoint);
    expect(before).toEqual({ x: 180, y: 240 });
    expect(after.x).toBeCloseTo(180, 9);
    expect(after.y).toBeCloseTo(240, 9);
    // No drawing during the gesture: the wrapper carries the transform.
    expect(draw).not.toHaveBeenCalled();
    expect(wrapper.style.transform).toMatch(/^translate\(.*\) scale\(2\)$/);
    // Handles follow the composed transform and keep their radius.
    const nw = handleCentre('nw');
    const nwImage = quadCorners(capture.frame)[0]!;
    const expected = applyAffine(composed, nwImage);
    expect(nw.x).toBeCloseTo(expected.x, 6);
    expect(nw.y).toBeCloseTo(expected.y, 6);
    expect(stage.querySelector('.edit-handle')!.getAttribute('r')).toBe('9');
    // Release: crisp redraw, wrapper reset.
    pointer(stage, 'pointerup', 2, 280, 240);
    pointer(stage, 'pointerup', 1, 80, 240);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(wrapper.style.transform).toBe('');
    expect(view.zoom.scale).toBeCloseTo(2, 9);
  });

  it('pinching out below the fitted view clamps to the fitted view', () => {
    pinch(stage, [80, 240], [280, 240], [150, 250], [210, 250]);
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
  });

  it('a second finger cancels the drag in progress and keeps the frame where it was', () => {
    const se = applyAffine(viewTransform(W, H, 0, VIEW_W, VIEW_H), quadCorners(capture.frame)[2]!);
    pointer(stage, 'pointerdown', 1, se.x, se.y);
    pointer(stage, 'pointermove', 1, se.x - 30, se.y - 12);
    expect(shownLoupes()).toEqual(['se']);
    pointer(stage, 'pointerdown', 2, 100, 100);
    expect(shownLoupes()).toEqual([]);
    // Further movement of the first finger is a pinch, not a corner drag.
    pointer(stage, 'pointermove', 1, se.x - 60, se.y - 12);
    pointer(stage, 'pointerup', 2, 100, 100);
    pointer(stage, 'pointerup', 1, se.x - 60, se.y - 12);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Bestätigen"]')!.click();
    const scale = VIEW_W / W;
    expect(confirmed!.corners![2]!.x).toBeCloseTo(-30 / scale, 6);
    expect(confirmed!.corners![2]!.y).toBeCloseTo(-12 / scale, 6);
  });

  it('after a pinch the remaining finger pans when clear of the handles and never starts a drag', () => {
    // Finger 1 ends the pinch in the stage body: it pans.
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240], false);
    pointer(stage, 'pointerup', 2, 280, 240);
    const zoom = { ...view.zoom };
    pointer(stage, 'pointermove', 1, 60, 200);
    pointer(stage, 'pointerup', 1, 60, 200);
    expect(view.zoom.tx).toBeCloseTo(zoom.tx - 20, 9);
    expect(view.zoom.ty).toBeCloseTo(zoom.ty - 40, 9);
    // Finger 1 ends the pinch on a handle: it does nothing until it lifts.
    const nw = handleCentre('nw');
    pointer(stage, 'pointerdown', 1, nw.x, nw.y);
    pointer(stage, 'pointerdown', 2, nw.x + 100, nw.y + 100);
    pointer(stage, 'pointerup', 2, nw.x + 100, nw.y + 100);
    const after = { ...view.zoom };
    pointer(stage, 'pointermove', 1, nw.x + 40, nw.y + 40);
    pointer(stage, 'pointerup', 1, nw.x + 40, nw.y + 40);
    expect(view.zoom).toEqual(after);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Bestätigen"]')!.click();
    expect(confirmed!.corners).toBeUndefined();
  });

  it('zoomed in, one finger pans in crop mode when it lands clear of every handle, and drags a handle otherwise', () => {
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    const zoom = { ...view.zoom };
    const nw = handleCentre('nw');
    // Clear of the handles: pan.
    pointer(stage, 'pointerdown', 1, 180, 240);
    pointer(stage, 'pointermove', 1, 150, 210);
    pointer(stage, 'pointerup', 1, 150, 210);
    expect(view.zoom.scale).toBeCloseTo(2, 9);
    expect(view.zoom.tx).toBeCloseTo(zoom.tx - 30, 9);
    expect(view.zoom.ty).toBeCloseTo(zoom.ty - 30, 9);
    // Just inside the handle's 22 px target: a drag, no pan.
    const panned = { ...view.zoom };
    const nw2 = handleCentre('nw');
    expect(nw2.x).toBeCloseTo(nw.x - 30, 6);
    pointer(stage, 'pointerdown', 1, nw2.x + 20, nw2.y);
    pointer(stage, 'pointermove', 1, nw2.x + 44, nw2.y + 12);
    expect(shownLoupes()).toEqual(['nw']);
    pointer(stage, 'pointerup', 1, nw2.x + 44, nw2.y + 12);
    expect(view.zoom).toEqual(panned);
    // Just outside it: a pan, and the frame is untouched.
    const beforeCorner = handleCentre('nw');
    pointer(stage, 'pointerdown', 1, beforeCorner.x + 23, beforeCorner.y);
    pointer(stage, 'pointermove', 1, beforeCorner.x + 33, beforeCorner.y);
    pointer(stage, 'pointerup', 1, beforeCorner.x + 33, beforeCorner.y);
    expect(shownLoupes()).toEqual([]);
    expect(view.zoom.tx).toBeCloseTo(panned.tx + 10, 9);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Bestätigen"]')!.click();
    const composedScale = 0.24;
    expect(confirmed!.corners![0]!.x).toBeCloseTo(24 / composedScale, 6);
    expect(confirmed!.corners![0]!.y).toBeCloseTo(12 / composedScale, 6);
  });

  it('in rotate mode one finger still rotates while zoomed; panning there takes two fingers', () => {
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Drehen"]')!.click();
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    const zoom = { ...view.zoom };
    pointer(stage, 'pointerdown', 1, 300, 240);
    pointer(stage, 'pointermove', 1, 300, 270);
    pointer(stage, 'pointerup', 1, 300, 270);
    expect(view.zoom).toEqual(zoom);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Bestätigen"]')!.click();
    expect(confirmed!.angle).not.toBe(0);
  });

  it('zoomed in, a corner handle hits at its displayed position and moves by the finger delta over the composed scale', () => {
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    const composedScale = affineScale(composeZoom(view.zoom, viewTransform(W, H, 0, VIEW_W, VIEW_H)));
    expect(composedScale).toBeCloseTo(0.24, 9);
    const nw = handleCentre('nw');
    pointer(stage, 'pointerdown', 1, nw.x + 15, nw.y - 10); // within the 22 px target
    pointer(stage, 'pointermove', 1, nw.x + 15 + 24, nw.y - 10 + 12);
    pointer(stage, 'pointerup', 1, nw.x + 15 + 24, nw.y - 10 + 12);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Bestätigen"]')!.click();
    expect(confirmed!.corners![0]!.x).toBeCloseTo(24 / composedScale, 6);
    expect(confirmed!.corners![0]!.y).toBeCloseTo(12 / composedScale, 6);
  });

  it('hides the loupes once the view is as magnified as a loupe, shows them below that', () => {
    // 2x: below the 3x loupe magnification, loupes appear.
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    let nw = handleCentre('nw');
    pointer(stage, 'pointerdown', 1, nw.x, nw.y);
    pointer(stage, 'pointermove', 1, nw.x + 20, nw.y + 20);
    expect(shownLoupes()).toEqual(['nw']);
    pointer(stage, 'pointerup', 1, nw.x + 20, nw.y + 20);
    // 4x: at or above it, none.
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    expect(view.zoom.scale).toBeCloseTo(4, 9);
    nw = handleCentre('nw');
    pointer(stage, 'pointerdown', 1, nw.x, nw.y);
    pointer(stage, 'pointermove', 1, nw.x + 20, nw.y + 20);
    expect(shownLoupes()).toEqual([]);
    pointer(stage, 'pointerup', 1, nw.x + 20, nw.y + 20);
  });

  it('double tap toggles 3x at the tap and back', () => {
    doubleTap(stage, 100, 300);
    expect(view.zoom.scale).toBe(DOUBLE_TAP_ZOOM);
    const composed = composeZoom(view.zoom, viewTransform(W, H, 0, VIEW_W, VIEW_H));
    const fitted = viewTransform(W, H, 0, VIEW_W, VIEW_H);
    const imagePoint = applyAffine(
      { ...fitted, a: 1 / fitted.a, d: 1 / fitted.d, e: -fitted.e / fitted.a, f: -fitted.f / fitted.d },
      { x: 100, y: 300 },
    );
    const under = applyAffine(composed, imagePoint);
    expect(under.x).toBeCloseTo(100, 6);
    expect(under.y).toBeCloseTo(300, 6);
    doubleTap(stage, 50, 50);
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
  });

  it('resets on the 90° button and on reopening', () => {
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    expect(view.zoom.scale).toBeCloseTo(2, 9);
    view.element.querySelector<HTMLButtonElement>('button[aria-label="Um 90° nach rechts drehen"]')!.click();
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    view.close();
    view.open(capture);
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
  });

  it('keeps the frame reachable: the pan range covers the frame sticking out of the image', () => {
    // A frame rotated by 90°+skew extends beyond the image; zoom in and pan far left.
    view.close();
    view.open({ image: capture.image, frame: frame({ cx: 200, cy: 2000, width: 2000, height: 2800 }) });
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    // Pan: no one-finger pan here, use a two-finger translation far to the right.
    pinch(stage, [100, 240], [200, 240], [500, 240], [600, 240]);
    const composed = composeZoom(view.zoom, viewTransform(W, H, 0, VIEW_W, VIEW_H));
    // The frame's west edge (image x = -800) can be brought to the stage edge, not past it.
    const west = applyAffine(composed, { x: -800, y: 2000 });
    expect(west.x).toBeCloseTo(0, 6);
  });
});

describe('zoom in the brightness/contrast view (v0.9)', () => {
  let stub: CanvasStub;
  let view: ToneView;
  let stage: HTMLElement;

  beforeEach(() => {
    stub = stubCanvas();
    view = new ToneView({ onCancel: () => {}, onConfirm: () => {}, onNotice: () => {} });
    document.body.append(view.element);
    stage = view.element.querySelector<HTMLElement>('.captured-stage')!;
    sizeStage(stage);
    const image = document.createElement('canvas');
    image.width = W;
    image.height = H;
    view.open({ image, frame: frame() });
  });

  afterEach(() => {
    view.close();
    view.element.remove();
    stub.restore();
  });

  it('pinches, pans with one finger while zoomed and keeps the filter on the stage canvas', () => {
    const canvas = view.element.querySelector<HTMLCanvasElement>('canvas.tone-canvas')!;
    const slider = view.element.querySelector<HTMLInputElement>('input.tone-slider')!;
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    expect(view.zoom.scale).toBeCloseTo(2, 9);
    const before = { ...view.zoom };
    pointer(stage, 'pointerdown', 1, 180, 240);
    pointer(stage, 'pointermove', 1, 150, 200);
    pointer(stage, 'pointerup', 1, 150, 200);
    expect(view.zoom.tx).toBeCloseTo(before.tx - 30, 9);
    expect(view.zoom.ty).toBeCloseTo(before.ty - 40, 9);
    slider.value = '1000';
    slider.dispatchEvent(new Event('input'));
    expect(canvas.style.filter).toContain('brightness(1.5)');
    expect(canvas.parentElement!.className).toBe('zoom-wrapper');
  });

  it('opens fitted again', () => {
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    view.close();
    const image = document.createElement('canvas');
    image.width = W;
    image.height = H;
    view.open({ image, frame: frame() });
    expect(view.zoom).toEqual(IDENTITY_ZOOM);
  });
});

describe('zoom in the captured view (v0.9)', () => {
  let root: HTMLElement;
  let app: App;
  let stub: CanvasStub;
  let stage: HTMLElement;

  async function settle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function button(label: string): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>(`.screen-captured button[aria-label="${label}"]`)!;
  }

  async function scanPage(): Promise<void> {
    if (app.screen === 'captured') button('Weitere Seite scannen').click();
    else root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await settle();
    root.querySelector<HTMLButtonElement>('button[aria-label="Foto aufnehmen"]')!.click();
    await settle();
    expect(app.screen).toBe('captured');
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
    stub = stubCanvas();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    vi.mocked(startCamera).mockImplementation((video: HTMLVideoElement) =>
      Promise.resolve({ stream: { getTracks: () => [] } as unknown as MediaStream, video, width: W, height: H } as CameraSession),
    );
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, { version: '0', build: 'test' });
    stage = root.querySelector<HTMLElement>('.screen-captured .captured-stage')!;
    sizeStage(stage);
  });

  afterEach(() => {
    app.dispose();
    root.remove();
    stub.restore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('draws the stage canvas at the stage size from the full image', async () => {
    await scanPage();
    const canvas = stage.querySelector<HTMLCanvasElement>('canvas.captured-canvas')!;
    expect(canvas.width).toBe(VIEW_W);
    expect(canvas.height).toBe(VIEW_H);
    expect(canvas.parentElement!.className).toBe('zoom-wrapper');
  });

  it('one finger pans while zoomed and swipes between pages only in the fitted view', async () => {
    await scanPage();
    await scanPage();
    expect(app.currentIndex).toBe(1);
    pinch(stage, [130, 240], [230, 240], [80, 240], [280, 240]);
    expect(app.capturedZoom.scale).toBeCloseTo(2, 9);
    const before = { ...app.capturedZoom };
    // A long horizontal drag: a pan, not a page swipe.
    pointer(stage, 'pointerdown', 1, 80, 240);
    pointer(stage, 'pointermove', 1, 200, 240);
    pointer(stage, 'pointerup', 1, 200, 240);
    await settle();
    expect(app.currentIndex).toBe(1);
    expect(app.capturedZoom.tx).toBeGreaterThan(before.tx);
    // Back to fitted: the swipe works again and the page switch resets the zoom.
    doubleTap(stage, 100, 100);
    expect(app.capturedZoom).toEqual(IDENTITY_ZOOM);
    pointer(stage, 'pointerdown', 1, 80, 240);
    pointer(stage, 'pointermove', 1, 200, 240);
    pointer(stage, 'pointerup', 1, 200, 240);
    await settle();
    expect(app.currentIndex).toBe(0);
    expect(app.capturedZoom).toEqual(IDENTITY_ZOOM);
  });

  it('a pinch drops a pending swipe and a page switch by button resets the zoom', async () => {
    await scanPage();
    await scanPage();
    pointer(stage, 'pointerdown', 1, 80, 240);
    pointer(stage, 'pointerdown', 2, 180, 240);
    pointer(stage, 'pointermove', 1, 30, 240);
    pointer(stage, 'pointermove', 2, 230, 240);
    pointer(stage, 'pointerup', 2, 230, 240);
    pointer(stage, 'pointerup', 1, 30, 240);
    await settle();
    expect(app.currentIndex).toBe(1);
    expect(app.capturedZoom.scale).toBeCloseTo(2, 9);
    button('Vorherige Seite').click();
    await settle();
    expect(app.currentIndex).toBe(0);
    expect(app.capturedZoom).toEqual(IDENTITY_ZOOM);
  });

  it('resets when the view is re-entered from an edit view', async () => {
    await scanPage();
    doubleTap(stage, 100, 100);
    expect(app.capturedZoom.scale).toBe(DOUBLE_TAP_ZOOM);
    button('Bearbeiten').click();
    root.querySelector<HTMLButtonElement>('button[aria-label="Zuschneiden und drehen"]')!.click();
    await settle();
    expect(app.screen).toBe('edit');
    root.querySelector<HTMLButtonElement>('.screen-edit button[aria-label="Zurück"]')!.click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.capturedZoom).toEqual(IDENTITY_ZOOM);
  });
});
