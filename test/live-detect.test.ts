// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { CameraSession } from '../src/camera';
import { LiveDetector, RUN_INTERVAL_MS } from '../src/live-detect';
import { sampleImage, WorkingCanvas } from '../src/canvas';
import { hasCornerOffsets } from '../src/geometry';
import type { Frame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';
import * as bake from '../src/bake';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return { ...actual, startCamera: vi.fn(), stopCamera: vi.fn(), captureStill: vi.fn(actual.captureStill) };
});

/**
 * The stubbed canvas hands back transparent pixels, so the real detection
 * never finds anything. The hit paths substitute the strict detection.
 */
vi.mock('../src/detect', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/detect')>();
  return { ...original, detectFrameStrict: vi.fn(original.detectFrameStrict) };
});

vi.mock('../src/bake', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/bake')>();
  return { ...original, bakeFrame: vi.fn(original.bakeFrame) };
});

import { captureStill, startCamera } from '../src/camera';
import { detectFrameStrict } from '../src/detect';
import { FROZEN_STILL_MS } from '../src/camera-view';

const startCameraMock = vi.mocked(startCamera);
const captureStillMock = vi.mocked(captureStill);
const detectMock = vi.mocked(detectFrameStrict);
const bakeMock = vi.mocked(bake.bakeFrame);

/** A small stream, so the warp in the shear test stays cheap. */
const STREAM_W = 300;
const STREAM_H = 400;

function fakeSession(video: HTMLVideoElement): CameraSession {
  return { stream: { getTracks: () => [] } as unknown as MediaStream, video, width: STREAM_W, height: STREAM_H };
}

/** Lets timers, microtasks and jsdom's animation frames (the busy overlay's afterPaint) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function button(root: HTMLElement, label: string, within?: string): HTMLButtonElement {
  const scope = within ? root.querySelector(within) : root;
  const found = scope?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

const STATIC: Frame = { cx: 150, cy: 200, width: 200, height: 200 * Math.SQRT2, angle: 0 };

describe('live detection loop', () => {
  let stub: CanvasStub;
  let video: HTMLVideoElement;

  beforeEach(() => {
    stub = stubCanvas();
    video = document.createElement('video');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stub.restore();
    vi.restoreAllMocks();
  });

  it('feeds every run through the tracker and reports found after three agreeing hits', () => {
    const results: boolean[] = [];
    const hit: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: 0 };
    const detector = new LiveDetector(video, {
      onResult: (state) => results.push(state.found),
      detect: () => hit,
    });
    detector.start(STATIC, STREAM_W);
    expect(detector.run().found).toBe(false);
    expect(detector.run().found).toBe(false);
    expect(detector.run().found).toBe(true);
    expect(detector.state.corners).not.toBeNull();
    detector.stop();
    expect(detector.state.found).toBe(false);
  });

  it('starts at most one run per interval on the frame callback', () => {
    let now = 0;
    let callback: (() => void) | null = null;
    const frameVideo = video as unknown as {
      requestVideoFrameCallback: (cb: () => void) => number;
      cancelVideoFrameCallback: (handle: number) => void;
    };
    frameVideo.requestVideoFrameCallback = (cb) => {
      callback = cb;
      return 1;
    };
    frameVideo.cancelVideoFrameCallback = () => {
      callback = null;
    };
    const detect = vi.fn(() => null);
    const detector = new LiveDetector(video, { onResult: () => {}, now: () => now, detect });
    detector.start(STATIC, STREAM_W);
    expect(detector.running).toBe(true);
    callback!(); // first video frame: runs
    expect(detect).toHaveBeenCalledTimes(1);
    now += RUN_INTERVAL_MS / 2;
    callback!(); // too soon: skipped, rescheduled
    expect(detect).toHaveBeenCalledTimes(1);
    now += RUN_INTERVAL_MS / 2;
    callback!();
    expect(detect).toHaveBeenCalledTimes(2);
    detector.stop();
    expect(detector.running).toBe(false);
    expect(callback).toBeNull();
  });

  it('counts a failing run as a miss and keeps going', () => {
    const detector = new LiveDetector(video, {
      onResult: () => {},
      detect: () => {
        throw new Error('boom');
      },
    });
    detector.start(STATIC, STREAM_W);
    expect(detector.run().found).toBe(false);
    expect(detector.running).toBe(true);
    detector.stop();
  });
});

describe('working canvas reuse (v0.10)', () => {
  let stub: CanvasStub;

  beforeEach(() => {
    stub = stubCanvas();
  });

  afterEach(() => {
    stub.restore();
  });

  it('samples into one reused canvas, resizing it between calls of different sizes', () => {
    const into = new WorkingCanvas();
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const source = document.createElement('canvas');
    const first = sampleImage(source, identity, 80, 110, into);
    expect(first.width).toBe(80);
    expect(first.height).toBe(110);
    const { canvas } = into.acquire(80, 110);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(110);
    const second = sampleImage(source, identity, 60, 90, into);
    expect(second.width).toBe(60);
    expect(second.height).toBe(90);
    expect(into.acquire(60, 90).canvas).toBe(canvas);
    expect(canvas.width).toBe(60);
    expect(canvas.height).toBe(90);
    into.release();
    expect(canvas.width).toBe(0);
    expect(into.acquire(10, 10).canvas).not.toBe(canvas);
    into.release();
  });
});

describe('camera view with live detection (v0.10)', () => {
  let root: HTMLElement;
  let app: App;
  let stub: CanvasStub;
  /** The loop's pending animation frame; the tests fire it by hand. */
  let pendingFrame: (() => void) | null;
  let clock: number;

  /** One video frame for the loop, far enough apart to pass the throttle. */
  function videoFrame(): void {
    clock += RUN_INTERVAL_MS;
    const frame = pendingFrame;
    pendingFrame = null;
    frame?.();
  }

  beforeEach(() => {
    stub = stubCanvas();
    pendingFrame = null;
    clock = 0;
    // The loop prefers the video's frame callback; jsdom's animation frame stays for afterPaint().
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    proto['requestVideoFrameCallback'] = (cb: () => void) => {
      pendingFrame = cb;
      return 1;
    };
    proto['cancelVideoFrameCallback'] = () => {
      pendingFrame = null;
    };
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, { version: '0', build: 'test' });
    // jsdom lays nothing out: give the camera screen a phone-sized viewport.
    const camera = root.querySelector<HTMLElement>('.screen-camera')!;
    Object.defineProperty(camera, 'clientWidth', { value: 360, configurable: true });
    Object.defineProperty(camera, 'clientHeight', { value: 640, configurable: true });
  });

  afterEach(() => {
    app.dispose();
    root.remove();
    stub.restore();
    const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
    delete proto['requestVideoFrameCallback'];
    delete proto['cancelVideoFrameCallback'];
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function openCamera(): Promise<void> {
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await settle();
    expect(app.screen).toBe('camera');
  }

  it('shows the toggle on, the static outline and the shade', async () => {
    await openCamera();
    const toggle = button(root, 'Dokument automatisch erkennen');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const overlay = root.querySelector('.camera-frame')!;
    expect(overlay.hasAttribute('hidden')).toBe(false);
    expect(overlay.classList.contains('found')).toBe(false);
    expect(overlay.querySelector('.camera-outline')?.getAttribute('points')).toBeTruthy();
    expect(overlay.querySelector('.camera-shade')?.getAttribute('d')).toContain('Z');
  });

  it('bakes a detected page on capture: frame upright without offsets, one bake', async () => {
    await openCamera();
    const tilted: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: (3 * Math.PI) / 180 };
    detectMock.mockReturnValueOnce(tilted);
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(bakeMock).toHaveBeenCalledTimes(1);
    const page = app.pageList[0]!;
    expect(page.frame.angle).toBe(0);
    expect(hasCornerOffsets(page.frame)).toBe(false);
    expect(page.dirty).toBe(true);
  });

  it('warps a page with corner offsets and keeps the upright rectangle', async () => {
    await openCamera();
    const sheared: Frame = {
      cx: 150,
      cy: 200,
      width: 180,
      height: 250,
      angle: 0,
      corners: [
        { x: 6, y: 0 },
        { x: -6, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    };
    detectMock.mockReturnValueOnce(sheared);
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(bakeMock).toHaveBeenCalledTimes(1);
    const page = app.pageList[0]!;
    expect(hasCornerOffsets(page.frame)).toBe(false);
    expect(page.frame.angle).toBe(0);
  });

  it('keeps the static frame on a miss and bakes nothing', async () => {
    await openCamera();
    detectMock.mockReturnValueOnce(null);
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(bakeMock).not.toHaveBeenCalled();
    const page = app.pageList[0]!;
    expect(page.frame.angle).toBe(0);
    // The static frame: 90 % of the visible width of a 300 x 400 stream on a 360 x 640 view.
    expect(page.frame.width).toBeCloseTo(0.9 * (STREAM_H * 360) / 640, 0);
    expect(page.dirty).toBe(false);
    expect(root.querySelector<HTMLElement>('.notice')?.hidden).toBe(true);
  });

  it('never detects with the toggle off, and keeps the choice across a retake', async () => {
    await openCamera();
    const toggle = button(root, 'Dokument automatisch erkennen');
    toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(detectMock).not.toHaveBeenCalled();
    expect(bakeMock).not.toHaveBeenCalled();
    // Back with one page reopens the camera: the toggle is still off.
    button(root, 'Seite verwerfen', '.screen-captured').click();
    await settle();
    expect(app.screen).toBe('camera');
    expect(button(root, 'Dokument automatisch erkennen').getAttribute('aria-checked')).toBe('false');
  });

  it('stores nothing: no localStorage key is written', async () => {
    await openCamera();
    button(root, 'Dokument automatisch erkennen').click();
    button(root, 'Dokument automatisch erkennen').click();
    expect(localStorage.length).toBe(0);
  });

  it('turns the outline green after three agreeing live hits and vibrates once', async () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    await openCamera();
    expect(pendingFrame).not.toBeNull();
    const hit: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: 0 };
    detectMock.mockReturnValue(hit);
    const overlay = root.querySelector('.camera-frame')!;
    videoFrame();
    videoFrame();
    expect(overlay.classList.contains('found')).toBe(false);
    videoFrame();
    expect(overlay.classList.contains('found')).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
    videoFrame();
    expect(vibrate).toHaveBeenCalledTimes(1);
    // The outline follows the detected corners, not the static rectangle.
    const points = overlay.querySelector('.camera-outline')!.getAttribute('points')!;
    const [nwx] = points.split(' ')[0]!.split(',').map(Number);
    // nw corner: (150 - 90) stream px -> view px with the cover scale 640 / 400.
    expect(nwx).toBeCloseTo(60 * 1.6 + (360 - 300 * 1.6) / 2, 0);
    // Switching the toggle off drops the outline at once and stops the loop.
    button(root, 'Dokument automatisch erkennen').click();
    expect(overlay.classList.contains('found')).toBe(false);
    expect(pendingFrame).toBeNull();
  });

  it('shows the warning when the outline was green but the still is a miss', async () => {
    await openCamera();
    const hit: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: 0 };
    detectMock.mockReturnValue(hit);
    videoFrame();
    videoFrame();
    videoFrame();
    expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(true);
    detectMock.mockReturnValue(null);
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(bakeMock).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('.notice')?.hidden).toBe(false);
  });

  describe('frozen still (v0.12)', () => {
    const hit: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: 0 };

    /** Three agreeing runs: the outline turns green and the still of that moment is grabbed. */
    async function findDocument(): Promise<HTMLCanvasElement> {
      await openCamera();
      detectMock.mockReturnValue(hit);
      videoFrame();
      videoFrame();
      expect(captureStillMock).not.toHaveBeenCalled();
      videoFrame();
      expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(true);
      expect(captureStillMock).toHaveBeenCalledTimes(1);
      return captureStillMock.mock.results[0]!.value as HTMLCanvasElement;
    }

    it('uses the still of the green moment when the shutter follows within the window', async () => {
      const frozen = await findDocument();
      clock += FROZEN_STILL_MS - 50;
      button(root, 'Foto aufnehmen').click();
      await settle();
      expect(app.screen).toBe('captured');
      expect(captureStillMock).toHaveBeenCalledTimes(1);
      expect(app.pageList[0]!.image).toBe(frozen);
      expect(frozen.width).toBeGreaterThan(0);
      expect(bakeMock).toHaveBeenCalledTimes(1);
    });

    it('grabs a fresh still after the window and releases the frozen one', async () => {
      const frozen = await findDocument();
      clock += FROZEN_STILL_MS + 1;
      button(root, 'Foto aufnehmen').click();
      await settle();
      expect(captureStillMock).toHaveBeenCalledTimes(2);
      expect(app.pageList[0]!.image).not.toBe(frozen);
      expect(frozen.width).toBe(0);
    });

    it('grabs a fresh still when the document drifted since the green moment', async () => {
      const frozen = await findDocument();
      // Each run agrees with the smoothed outline, but the outline drifts away from the frozen corners.
      for (const dx of [2.5, 5, 7.5, 10]) {
        detectMock.mockReturnValue({ ...hit, cx: hit.cx + dx });
        videoFrame();
      }
      expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(true);
      clock = 0;
      button(root, 'Foto aufnehmen').click();
      await settle();
      expect(captureStillMock).toHaveBeenCalledTimes(2);
      expect(app.pageList[0]!.image).not.toBe(frozen);
      expect(frozen.width).toBe(0);
    });

    it('releases the frozen still when the outline is lost', async () => {
      const frozen = await findDocument();
      detectMock.mockReturnValue(null);
      videoFrame();
      videoFrame();
      expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(false);
      expect(frozen.width).toBe(0);
      button(root, 'Foto aufnehmen').click();
      await settle();
      expect(captureStillMock).toHaveBeenCalledTimes(2);
      expect(app.pageList[0]!.image).not.toBe(frozen);
    });

    it('releases the frozen still when the toggle is switched off and when the camera closes', async () => {
      const first = await findDocument();
      button(root, 'Dokument automatisch erkennen').click();
      expect(first.width).toBe(0);
      button(root, 'Dokument automatisch erkennen').click();
      videoFrame();
      videoFrame();
      videoFrame();
      const second = captureStillMock.mock.results[1]!.value as HTMLCanvasElement;
      expect(second.width).toBeGreaterThan(0);
      button(root, 'Zurück', '.screen-camera').click();
      expect(second.width).toBe(0);
    });

    it('takes the photo on the press of the shutter; the click that follows does nothing', async () => {
      await openCamera();
      const shutter = button(root, 'Foto aufnehmen');
      shutter.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      shutter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(app.screen).toBe('captured');
      expect(app.pageList).toHaveLength(1);
      expect(captureStillMock).toHaveBeenCalledTimes(1);
    });
  });

  it('stops the loop with the stream and hides the overlay', async () => {
    await openCamera();
    expect(pendingFrame).not.toBeNull();
    button(root, 'Zurück', '.screen-camera').click();
    expect(app.screen).toBe('start');
    expect(pendingFrame).toBeNull();
    expect(root.querySelector('.camera-frame')?.hasAttribute('hidden')).toBe(true);
  });
});
