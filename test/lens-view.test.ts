// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { LensSwitchError, type CameraSession, type Lens, type LensControl } from '../src/camera';
import { RUN_INTERVAL_MS } from '../src/live-detect';
import type { Frame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return {
    ...actual,
    startCamera: vi.fn(),
    stopCamera: vi.fn(),
    probeLenses: vi.fn(),
    captureStill: vi.fn(actual.captureStill),
  };
});

vi.mock('../src/detect', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/detect')>();
  return { ...original, detectFrameStrict: vi.fn(original.detectFrameStrict) };
});

import { captureStill, probeLenses, startCamera, stopCamera } from '../src/camera';
import { detectFrameStrict } from '../src/detect';

const startCameraMock = vi.mocked(startCamera);
const stopCameraMock = vi.mocked(stopCamera);
const probeMock = vi.mocked(probeLenses);
const captureStillMock = vi.mocked(captureStill);
const detectMock = vi.mocked(detectFrameStrict);

const STREAM_W = 300;
const STREAM_H = 400;

function fakeSession(video: HTMLVideoElement, width = STREAM_W, height = STREAM_H): CameraSession {
  return { stream: { getTracks: () => [] } as unknown as MediaStream, video, width, height };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

/** A control whose `select` the test resolves by hand. */
interface ManualControl extends LensControl {
  resolve: (session: CameraSession) => void;
  reject: (error: unknown) => void;
  calls: Lens[];
}

function manualControl(): ManualControl {
  let resolve: (session: CameraSession) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const control: ManualControl = {
    kind: 'device',
    calls: [],
    select: vi.fn((lens: Lens) => {
      control.calls.push(lens);
      return new Promise<CameraSession>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    }),
    resolve: (session) => resolve(session),
    reject: (error) => reject(error),
  };
  return control;
}

describe('wide-angle lens switch (v1.2)', () => {
  let root: HTMLElement;
  let app: App;
  let stub: CanvasStub;
  let pendingFrame: (() => void) | null;
  let clock: number;
  let video: HTMLVideoElement;

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
    startCameraMock.mockImplementation((v) => {
      video = v;
      return Promise.resolve(fakeSession(v));
    });
    probeMock.mockResolvedValue(null);
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, { version: '0', build: 'test' });
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

  function lensSwitch(): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>('button[aria-label="Weitwinkel"]');
  }

  /** Three agreeing hits: the outline turns green and the frozen still is grabbed. */
  function turnGreen(): void {
    const hit: Frame = { cx: 150, cy: 200, width: 180, height: 250, angle: 0 };
    detectMock.mockReturnValue(hit);
    captureStillMock.mockClear();
    videoFrame();
    videoFrame();
    videoFrame();
    expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(true);
    expect(captureStillMock).toHaveBeenCalledTimes(1);
  }

  it('renders no switch when the probe finds no wide lens', async () => {
    await openCamera();
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(lensSwitch()!.hidden).toBe(true);
  });

  it('switches to the wide lens: frozen still released, loop restarted, frame laid out on the new stream', async () => {
    const control = manualControl();
    probeMock.mockResolvedValue(control);
    await openCamera();
    const toggle = lensSwitch()!;
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    turnGreen();
    const frozen = captureStillMock.mock.results[0]!.value as HTMLCanvasElement;
    const outlineBefore = root.querySelector('.camera-outline')!.getAttribute('points');

    toggle.click();
    await settle();
    expect(control.calls).toEqual(['wide']);
    expect(lensSwitch()!.hidden).toBe(true); // hidden while the switch is pending
    expect(frozen.width).toBe(0); // released
    expect(pendingFrame).toBeNull(); // the loop is stopped
    expect(root.querySelector('.camera-frame')!.classList.contains('found')).toBe(false);

    // The wide stream is landscape-ish wider: the static frame changes with it.
    control.resolve(fakeSession(video, 400, 400));
    await settle();
    expect(lensSwitch()!.hidden).toBe(false);
    expect(lensSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(app.lens).toBe('wide');
    expect(pendingFrame).not.toBeNull(); // the loop runs again on the new stream
    expect(root.querySelector('.camera-outline')!.getAttribute('points')).not.toBe(outlineBefore);
    expect(root.querySelector('.camera-frame')!.hasAttribute('hidden')).toBe(false);
  });

  it('keeps the lens choice across camera opens and applies it on reopen', async () => {
    const control = manualControl();
    probeMock.mockResolvedValue(control);
    await openCamera();
    lensSwitch()!.click();
    await settle();
    control.resolve(fakeSession(video));
    await settle();
    expect(app.lens).toBe('wide');

    // Back to start and in again: the probe runs anew and the wide lens is selected without a tap.
    button(root, 'Zurück').click();
    await settle();
    expect(app.screen).toBe('start');
    const reopened = manualControl();
    probeMock.mockResolvedValue(reopened);
    await openCamera();
    expect(reopened.calls).toEqual(['wide']);
    reopened.resolve(fakeSession(video));
    await settle();
    expect(lensSwitch()!.getAttribute('aria-checked')).toBe('true');
  });

  it('a wide lens that does not open on reopen falls back to default with the switch off, no error', async () => {
    const control = manualControl();
    probeMock.mockResolvedValue(control);
    await openCamera();
    lensSwitch()!.click();
    await settle();
    control.resolve(fakeSession(video));
    await settle();
    button(root, 'Zurück').click();
    await settle();

    const reopened = manualControl();
    probeMock.mockResolvedValue(reopened);
    await openCamera();
    expect(reopened.calls).toEqual(['wide']);
    const fallback = fakeSession(video);
    reopened.reject(new LensSwitchError('no', fallback, new Error('busy')));
    await settle();
    expect(app.screen).toBe('camera');
    expect(app.lens).toBe('default');
    expect(lensSwitch()!.hidden).toBe(false);
    expect(lensSwitch()!.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('.camera-frame')!.hasAttribute('hidden')).toBe(false);
  });

  it('a switch that loses the camera shows the error screen; retry opens the default lens', async () => {
    const control = manualControl();
    probeMock.mockResolvedValue(control);
    await openCamera();
    lensSwitch()!.click();
    await settle();
    control.reject(new LensSwitchError('gone', null, new DOMException('busy', 'NotReadableError')));
    await settle();
    expect(app.screen).toBe('error');
    expect(app.lens).toBe('default');

    probeMock.mockResolvedValue(null);
    startCameraMock.mockClear();
    button(root, 'Kamera erneut versuchen').click();
    await settle();
    expect(app.screen).toBe('camera');
    expect(startCameraMock).toHaveBeenCalledTimes(1);
    expect(lensSwitch()!.hidden).toBe(true);
  });

  it('a camera closed during a pending switch stops the arriving stream and shows nothing', async () => {
    const control = manualControl();
    probeMock.mockResolvedValue(control);
    await openCamera();
    lensSwitch()!.click();
    await settle();
    button(root, 'Zurück').click();
    await settle();
    expect(app.screen).toBe('start');
    stopCameraMock.mockClear();
    const late = fakeSession(video);
    control.resolve(late);
    await settle();
    expect(stopCameraMock).toHaveBeenCalledWith(late);
    expect(lensSwitch()!.hidden).toBe(true);
  });
});
