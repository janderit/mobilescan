// @vitest-environment jsdom
/**
 * v0.11: sharing a single page as a JPEG. With one page the share button
 * opens a popover (PDF | image) above itself; with several pages it opens
 * the sheet for the PDF at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { CameraSession } from '../src/camera';
import { stubCanvas, type CanvasStub } from './canvas-stub';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return {
    ...actual,
    startCamera: vi.fn(),
    stopCamera: vi.fn(),
  };
});

import { startCamera } from '../src/camera';

const startCameraMock = vi.mocked(startCamera);

function fakeSession(video: HTMLVideoElement): CameraSession {
  return { stream: { getTracks: () => [] } as unknown as MediaStream, video, width: 3000, height: 4000 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function button(root: HTMLElement, label: string, within?: string): HTMLButtonElement {
  const scope = within ? root.querySelector(within) : root;
  const found = scope?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

function shareMenu(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.popover[aria-label="Teilen"]')!.parentElement!;
}

function sheet(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.sheet-backdrop')!;
}

describe('share as JPEG (v0.11)', () => {
  let root: HTMLElement;
  let app: App;
  let stub: CanvasStub;
  let shared: File | null;

  async function scanFirstPage(): Promise<void> {
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await settle();
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
  }

  async function addPage(): Promise<void> {
    button(root, 'Weitere Seite scannen').click();
    await settle();
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
    stub = stubCanvas();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0),
    );
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
    shared = null;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: (data: { files: File[] }) => {
        shared = data.files[0]!;
        return Promise.resolve();
      },
      configurable: true,
    });
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, { version: '0', build: 'test' });
  });

  afterEach(() => {
    app.dispose();
    root.remove();
    stub.restore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens the share popover instead of the sheet with a single page', async () => {
    await scanFirstPage();
    const share = button(root, 'Teilen', '.button-bar');
    share.click();
    expect(shareMenu(root).hidden).toBe(false);
    expect(sheet(root).hidden).toBe(true);
    expect(share.getAttribute('aria-expanded')).toBe('true');
    expect(button(root, 'Als PDF teilen')).toBeTruthy();
    expect(button(root, 'Als Bild teilen')).toBeTruthy();
    // A second tap closes it again.
    share.click();
    expect(shareMenu(root).hidden).toBe(true);
  });

  it('shares the page as a JPEG at the chosen compression', async () => {
    await scanFirstPage();
    button(root, 'Teilen', '.button-bar').click();
    button(root, 'Als Bild teilen').click();
    expect(shareMenu(root).hidden).toBe(true);
    expect(sheet(root).hidden).toBe(false);
    button(root, 'Große Datei', '.sheet').click();
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect(shared).not.toBeNull();
    const file = shared as unknown as File;
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toMatch(/^scan-\d{8}-\d{6}\.jpg$/);
    // A JPEG starts with the SOI marker; the sheet's quality reached the encoder.
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(stub.lastQuality).toBe(0.92);
    expect(app.screen).toBe('start');
    expect(app.pageCount).toBe(0);
  });

  it('still shares a PDF when the popover item PDF is chosen', async () => {
    await scanFirstPage();
    button(root, 'Teilen', '.button-bar').click();
    button(root, 'Als PDF teilen').click();
    expect(sheet(root).hidden).toBe(false);
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect((shared as unknown as File).type).toBe('application/pdf');
    expect(app.screen).toBe('start');
  });

  it('skips the popover and shares the PDF with several pages', async () => {
    await scanFirstPage();
    await addPage();
    button(root, 'Teilen', '.button-bar').click();
    expect(shareMenu(root).hidden).toBe(true);
    expect(sheet(root).hidden).toBe(false);
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect((shared as unknown as File).type).toBe('application/pdf');
  });

  it('closes the popover on hardware back and on a backdrop tap without leaving the page', async () => {
    await scanFirstPage();
    button(root, 'Teilen', '.button-bar').click();
    expect(shareMenu(root).hidden).toBe(false);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(shareMenu(root).hidden).toBe(true);
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(1);

    button(root, 'Teilen', '.button-bar').click();
    shareMenu(root).click();
    expect(shareMenu(root).hidden).toBe(true);
    expect(app.screen).toBe('captured');
  });

  it('keeps the page when the image share is cancelled', async () => {
    Object.defineProperty(navigator, 'share', {
      value: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      configurable: true,
    });
    await scanFirstPage();
    button(root, 'Teilen', '.button-bar').click();
    button(root, 'Als Bild teilen').click();
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(1);
    expect(sheet(root).hidden).toBe(true);
  });
});
