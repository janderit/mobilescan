// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { App } from '../src/app';
import { MAX_PAGES } from '../src/model';
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

/** Lets every pending timer and microtask (busy overlay, toBlob, decode) run. */
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

function header(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.page-header')!;
}

function position(root: HTMLElement): string {
  return root.querySelector('.page-position')?.textContent ?? '';
}

describe('multi-page scans (v0.5)', () => {
  let root: HTMLElement;
  let app: App;
  let stub: CanvasStub;

  /** Start page -> camera -> shutter: first page captured. */
  async function scanFirstPage(): Promise<void> {
    root.querySelector<HTMLButtonElement>('.start-button')!.click();
    await settle();
    expect(app.screen).toBe('camera');
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
  }

  /** [+] -> camera -> shutter: another page appended. */
  async function addPage(): Promise<void> {
    button(root, 'Weitere Seite scannen').click();
    await settle();
    expect(app.screen).toBe('camera');
    expect(app.liveCanvasCount).toBe(0);
    button(root, 'Foto aufnehmen').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.liveCanvasCount).toBe(1);
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
    stub = stubCanvas();
    // jsdom paces animation frames at 60 Hz; the busy overlay waits for two of them.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0),
    );
    startCameraMock.mockImplementation((video) => Promise.resolve(fakeSession(video)));
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
  });

  it('shows [+] and no header for a single page', async () => {
    await scanFirstPage();
    expect(app.pageCount).toBe(1);
    expect(header(root).hidden).toBe(true);
    const add = button(root, 'Weitere Seite scannen', '.screen-captured');
    expect(add.getAttribute('aria-disabled')).toBe('false');
    expect(stub.encodeCount).toBe(0);
  });

  it('appends a page with [+], shows the header and keeps one live canvas', async () => {
    await scanFirstPage();
    await addPage();
    expect(app.pageCount).toBe(2);
    expect(app.currentIndex).toBe(1);
    expect(header(root).hidden).toBe(false);
    expect(position(root)).toBe('2/2');
    expect(button(root, 'Nächste Seite').getAttribute('aria-disabled')).toBe('true');
    expect(button(root, 'Vorherige Seite').getAttribute('aria-disabled')).toBe('false');
    expect(app.liveCanvasCount).toBe(1);
    expect(app.pageList[0]!.blob).not.toBeNull();
    expect(app.pageList[0]!.image).toBeNull();
  });

  it('returns to the same page with the count unchanged when the camera is left after [+]', async () => {
    await scanFirstPage();
    await addPage();
    button(root, 'Vorherige Seite').click();
    await settle();
    expect(position(root)).toBe('1/2');

    button(root, 'Weitere Seite scannen').click();
    await settle();
    expect(app.screen).toBe('camera');
    button(root, 'Zurück', '.screen-camera').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(2);
    expect(app.currentIndex).toBe(0);
    expect(position(root)).toBe('1/2');
    expect(app.liveCanvasCount).toBe(1);
  });

  it('hardware back in the camera after [+] also returns to the page', async () => {
    await scanFirstPage();
    await addPage();
    button(root, 'Weitere Seite scannen').click();
    await settle();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(2);
    expect(position(root)).toBe('2/2');
  });

  it('swipes between pages over the image', async () => {
    await scanFirstPage();
    await addPage();
    const stage = root.querySelector<HTMLElement>('.screen-captured .captured-stage')!;
    const drag = (fromX: number, toX: number, toY = 0): void => {
      stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, isPrimary: true, clientX: fromX, clientY: 0 }));
      stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true, clientX: toX, clientY: toY }));
    };
    expect(position(root)).toBe('2/2');
    drag(200, 80); // swipe left at the last page: nothing
    await settle();
    expect(position(root)).toBe('2/2');
    drag(80, 200); // swipe right: previous page
    await settle();
    expect(position(root)).toBe('1/2');
    expect(app.liveCanvasCount).toBe(1);
    drag(200, 200, 120); // vertical drag: nothing
    drag(200, 180); // too short: nothing
    await settle();
    expect(position(root)).toBe('1/2');
    drag(200, 80); // swipe left: next page
    await settle();
    expect(position(root)).toBe('2/2');
  });

  it('ignores swipes with a single page', async () => {
    await scanFirstPage();
    const stage = root.querySelector<HTMLElement>('.screen-captured .captured-stage')!;
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, isPrimary: true, clientX: 200, clientY: 0 }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true, clientX: 40, clientY: 0 }));
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.currentIndex).toBe(0);
  });

  it('does not re-encode unchanged pages while navigating back and forth', async () => {
    await scanFirstPage();
    await addPage();
    const encodedAfterAdd = stub.encodeCount;
    expect(encodedAfterAdd).toBe(1);
    for (let i = 0; i < 10; i += 1) {
      button(root, 'Vorherige Seite').click();
      await settle();
      expect(position(root)).toBe('1/2');
      expect(app.liveCanvasCount).toBe(1);
      button(root, 'Nächste Seite').click();
      await settle();
      expect(position(root)).toBe('2/2');
      expect(app.liveCanvasCount).toBe(1);
    }
    // Page 2 was encoded once on the first switch; page 1 never again.
    expect(stub.encodeCount).toBe(2);
    expect(app.pageList[0]!.dirty).toBe(false);
    expect(app.pageList[1]!.dirty).toBe(false);
  });

  it('edits the current page only; the other page keeps its blob untouched', async () => {
    await scanFirstPage();
    await addPage();
    button(root, 'Vorherige Seite').click();
    await settle();
    const page2Blob = app.pageList[1]!.blob;
    expect(page2Blob).not.toBeNull();
    const page1Image = app.pageList[0]!.image;

    button(root, 'Bearbeiten').click();
    button(root, 'Zuschneiden und drehen').click();
    await settle();
    expect(app.screen).toBe('edit');
    button(root, 'Um 90° nach rechts drehen', '.screen-edit').click();
    button(root, 'Bestätigen', '.screen-edit').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageList[0]!.dirty).toBe(true);
    expect(app.pageList[0]!.image).not.toBe(page1Image);
    // Rotation by 90° swaps the image sides.
    expect(app.pageList[0]!.width).toBe(app.pageList[0]!.image!.width);
    expect(app.pageList[1]!.blob).toBe(page2Blob);
    expect(app.pageList[1]!.dirty).toBe(false);
    expect(app.liveCanvasCount).toBe(1);

    // Leaving the edited page re-encodes it; page 2 is not touched.
    const before = stub.encodeCount;
    button(root, 'Nächste Seite').click();
    await settle();
    expect(stub.encodeCount).toBe(before + 1);
    expect(app.pageList[0]!.dirty).toBe(false);
    expect(app.pageList[1]!.blob).toBe(page2Blob);
  });

  it('back on page 2 of 2 removes it and shows page 1; back again reopens the camera', async () => {
    await scanFirstPage();
    await addPage();
    button(root, 'Zurück', '.screen-captured').click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(1);
    expect(app.currentIndex).toBe(0);
    expect(header(root).hidden).toBe(true);
    expect(app.liveCanvasCount).toBe(1);

    button(root, 'Zurück', '.screen-captured').click();
    await settle();
    expect(app.screen).toBe('camera');
    expect(app.pageCount).toBe(0);
  });

  it('back on the first of three pages shows the new first page', async () => {
    await scanFirstPage();
    await addPage();
    await addPage();
    button(root, 'Vorherige Seite').click();
    await settle();
    button(root, 'Vorherige Seite').click();
    await settle();
    expect(position(root)).toBe('1/3');
    const second = app.pageList[1];
    button(root, 'Zurück', '.screen-captured').click();
    await settle();
    expect(app.pageCount).toBe(2);
    expect(app.currentIndex).toBe(0);
    expect(app.pageList[0]).toBe(second);
    expect(position(root)).toBe('1/2');
  });

  it('hardware back on the captured view follows the same rule', async () => {
    await scanFirstPage();
    await addPage();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(1);
  });

  it('shares all pages in order as one PDF and then discards them', async () => {
    let shared: File | null = null;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: (data: { files: File[] }) => {
        shared = data.files[0]!;
        return Promise.resolve();
      },
      configurable: true,
    });
    await scanFirstPage();
    await addPage();
    await addPage();
    expect(app.pageCount).toBe(3);

    button(root, 'Teilen').click();
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect(shared).not.toBeNull();
    const bytes = new Uint8Array(await (shared as unknown as File).arrayBuffer());
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    expect(app.screen).toBe('start');
    expect(app.pageCount).toBe(0);
    expect(app.liveCanvasCount).toBe(0);
  });

  it('keeps all pages and the position when the share sheet is cancelled', async () => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      configurable: true,
    });
    await scanFirstPage();
    await addPage();
    await addPage();
    button(root, 'Vorherige Seite').click();
    await settle();
    expect(position(root)).toBe('2/3');

    button(root, 'Teilen').click();
    button(root, 'Bestätigen', '.sheet').click();
    await settle();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(3);
    expect(app.currentIndex).toBe(1);
    expect(position(root)).toBe('2/3');
    expect(app.liveCanvasCount).toBe(1);
    expect(root.querySelector<HTMLElement>('.sheet-backdrop')?.hidden).toBe(true);
  });

  it('disables [+] at the page limit', async () => {
    await scanFirstPage();
    for (let i = 1; i < MAX_PAGES; i += 1) {
      await addPage();
    }
    expect(app.pageCount).toBe(MAX_PAGES);
    const add = button(root, 'Weitere Seite scannen');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    add.click();
    await settle();
    expect(app.screen).toBe('captured');
    expect(app.pageCount).toBe(MAX_PAGES);
  });
});
