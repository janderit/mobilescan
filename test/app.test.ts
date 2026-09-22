// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, CAMERA_ERROR_LABELS } from '../src/app';
import type { CameraSession } from '../src/camera';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return {
    ...actual,
    startCamera: vi.fn(),
    stopCamera: vi.fn(),
  };
});

import { startCamera, stopCamera } from '../src/camera';

const startCameraMock = vi.mocked(startCamera);

function fakeSession(video: HTMLVideoElement): CameraSession {
  return { stream: { getTracks: () => [] } as unknown as MediaStream, video, width: 3000, height: 4000 };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function button(root: HTMLElement, label: string, within?: string): HTMLButtonElement {
  const scope = within ? root.querySelector(within) : root;
  const found = scope?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

function visibleScreen(root: HTMLElement): string {
  const shown = [...root.querySelectorAll<HTMLElement>('.screen')].filter(
    (s) => !s.hidden && !s.classList.contains('leaving'),
  );
  expect(shown).toHaveLength(1);
  return shown[0]!.className.replace('screen ', '').split(' ')[0]!;
}

describe('App', () => {
  let root: HTMLElement;
  let app: App;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, { version: '0', build: 'test' });
  });

  afterEach(() => {
    app.dispose();
    root.remove();
    vi.clearAllMocks();
  });

  it('starts on the start page without a history entry', () => {
    expect(app.screen).toBe('start');
    expect(visibleScreen(root)).toBe('screen-start');
    expect(root.querySelector<HTMLElement>('.screen-error')?.hidden).toBe(true);
  });

  it('shows the error screen when the camera is denied, and retries', async () => {
    startCameraMock.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await flush();
    expect(app.screen).toBe('error');
    expect(root.querySelector('.error-icon')?.getAttribute('aria-label')).toBe(CAMERA_ERROR_LABELS.denied);

    startCameraMock.mockImplementationOnce((video) => Promise.resolve(fakeSession(video)));
    button(root, 'Kamera erneut versuchen').click();
    await flush();
    expect(app.screen).toBe('camera');
  });

  it('labels the error with the failure kind', async () => {
    startCameraMock.mockRejectedValueOnce(new DOMException('http', 'SecurityError'));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await flush();
    expect(root.querySelector('.error-icon')?.getAttribute('aria-label')).toBe(CAMERA_ERROR_LABELS.insecure);
    button(root, 'Zurück', '.screen-error').click();
    expect(app.screen).toBe('start');
  });

  it('treats a popstate as the back button and re-arms the trap', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await flush();
    expect(app.screen).toBe('camera');
    expect(pushState).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(app.screen).toBe('start');
    expect(stopCamera).toHaveBeenCalledTimes(1);
    // Back on the start page: the trap is disarmed without touching history again.
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  it('pops its own history entry silently when returning to start in-app', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await flush();
    button(root, 'Zurück', '.screen-camera').click();
    expect(app.screen).toBe('start');
    expect(back).toHaveBeenCalledTimes(1);
    // The browser answers with a popstate, which must not count as another back.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(app.screen).toBe('start');
  });

  it('stops the camera when the page is hidden and restarts it when shown', async () => {
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await flush();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stopCamera).toHaveBeenCalledTimes(1);
    expect(app.screen).toBe('camera');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(startCameraMock).toHaveBeenCalledTimes(2);
    expect(app.screen).toBe('camera');
  });

  it('stops a camera that finished starting while the page was hidden', async () => {
    let resolveStart: () => void = () => {};
    startCameraMock.mockImplementationOnce(
      (video) =>
        new Promise<CameraSession>((resolve) => {
          resolveStart = () => resolve(fakeSession(video));
        }),
    );
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stopCamera).not.toHaveBeenCalled();
    resolveStart();
    await flush();
    expect(stopCamera).toHaveBeenCalledTimes(1);
    expect(app.screen).toBe('camera');
    expect(root.querySelector('.camera-frame')?.hasAttribute('hidden')).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    startCameraMock.mockImplementationOnce((video) => Promise.resolve(fakeSession(video)));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(startCameraMock).toHaveBeenCalledTimes(2);
  });

  it('starts the camera once when the page becomes visible while it is still starting', async () => {
    let resolveStart: () => void = () => {};
    startCameraMock.mockImplementationOnce(
      (video) =>
        new Promise<CameraSession>((resolve) => {
          resolveStart = () => resolve(fakeSession(video));
        }),
    );
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    expect(startCameraMock).toHaveBeenCalledTimes(1);
    // Visible again while the first start is pending: no second stream.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(startCameraMock).toHaveBeenCalledTimes(1);
    resolveStart();
    await flush();
    expect(startCameraMock).toHaveBeenCalledTimes(1);
    expect(stopCamera).not.toHaveBeenCalled();
    expect(app.screen).toBe('camera');
  });

  it('fades: the new screen is shown at once, the old one hidden after the fade', async () => {
    vi.useFakeTimers();
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await vi.runAllTimersAsync();
    const start = root.querySelector<HTMLElement>('.screen-start')!;
    const camera = root.querySelector<HTMLElement>('.screen-camera')!;
    expect(camera.hidden).toBe(false);
    expect(start.hidden).toBe(true);
    expect(start.classList.contains('leaving')).toBe(false);
    vi.useRealTimers();
  });
});

describe('App updates', () => {
  let root: HTMLElement;
  let app: App | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    app?.dispose();
    app = null;
    root.remove();
    vi.clearAllMocks();
  });

  it('shows the update button on the start page once a newer build is reported', async () => {
    const updates = { check: vi.fn(() => Promise.resolve(true)), apply: vi.fn(() => new Promise<void>(() => {})) };
    app = new App(root, { version: '0', build: 'test', updates });
    const updateButton = button(root, 'App aktualisieren');
    expect(updateButton.hidden).toBe(true);
    await flush();
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updateButton.hidden).toBe(false);

    updateButton.click();
    await flush();
    expect(updates.apply).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLElement>('.busy')?.hidden).toBe(false);
  });

  it('hides the update button with a stylesheet rule, not only the attribute', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.update-button\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('keeps the button hidden without an update and without a checker', async () => {
    const updates = { check: vi.fn(() => Promise.resolve(false)), apply: vi.fn(() => Promise.resolve()) };
    app = new App(root, { version: '0', build: 'test', updates });
    await flush();
    expect(button(root, 'App aktualisieren').hidden).toBe(true);
    app.dispose();
    app = new App(root, { version: '0', build: 'test' });
    expect(button(root, 'App aktualisieren').hidden).toBe(true);
  });

  it('checks again when the start page becomes visible after an interval', async () => {
    vi.useFakeTimers();
    try {
      const updates = { check: vi.fn(() => Promise.resolve(false)), apply: vi.fn(() => Promise.resolve()) };
      app = new App(root, { version: '0', build: 'test', updates });
      await vi.runAllTimersAsync();
      expect(updates.check).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(updates.check).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(updates.check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the busy overlay and shows the warning when applying fails', async () => {
    const updates = { check: vi.fn(() => Promise.resolve(true)), apply: vi.fn(() => Promise.reject(new Error('x'))) };
    app = new App(root, { version: '0', build: 'test', updates });
    await flush();
    button(root, 'App aktualisieren').click();
    await flush();
    expect(root.querySelector<HTMLElement>('.busy')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.notice')?.hidden).toBe(false);
  });
});
