/**
 * MobileScan app shell: start -> camera (or camera error) -> captured ->
 * (share sheet | edit popover -> crop/rotate | brightness/contrast | [+] camera) -> busy.
 * One in-memory state machine, plain DOM, no persistence. A scan is a list of
 * pages of which only the current one holds a full-resolution canvas (v0.5).
 * The captured screen (`CapturedView`) shows the current page on a zoomable
 * `FrameStage` (v0.9); the zoom is view state only and resets whenever the
 * view is entered.
 */

import * as icons from './icons';
import type { CompressionLevel, Frame, Page } from './model';
import { afterPaint, el, prefersReducedMotion } from './ui';
import { hasCornerOffsets, initialFrame, scaleFrame } from './geometry';
import { DEFAULT_COMPRESSION } from './quality';
import { cameraErrorKind, captureStill, startCamera, stopCamera, type CameraErrorKind, type CameraSession } from './camera';
import { buildPdfFile, sharePdf } from './share';
import type { UpdateChecker } from './update';
import { UpdatePrompt } from './update-prompt';
import { applyCapture, asCapture, newPage } from './pages';
import { Scan } from './scan';
import { StartView } from './start-view';
import { ErrorView } from './error-view';
import { CameraView, vibrate } from './camera-view';
import { CapturedView } from './captured-view';
import { CropRotateView } from './editor';
import { ToneView } from './tone-view';
import { isNeutralTone, type Tone } from './tone';
import { bakeFrame, bakeTone, frameNeedsBake } from './bake';
import { BackTrap } from './navigation';
import type { SwipeDirection } from './swipe';
import type { ZoomState } from './zoom';
import { detectFrameIn, detectFrameStrict } from './detect';

export type Screen = 'start' | 'camera' | 'error' | 'captured' | 'edit' | 'tone';

/** Where the camera was opened from; camera back returns there. */
type CameraOrigin = 'start' | 'captured';

interface State {
  screen: Screen;
  sheetOpen: boolean;
  menuOpen: boolean;
  busy: boolean;
  level: CompressionLevel;
  cameraError: CameraErrorKind;
  cameraOrigin: CameraOrigin;
}

/** Cross-fade between screens; written to `--fade` on the app root so styles.css follows it. */
export const FADE_MS = 150;

/** How long the icon-only error notice stays on screen. */
export const NOTICE_MS = 2000;

export { CAMERA_ERROR_LABELS } from './error-view';

/**
 * v0.10: the strict detection on the still, from the static frame. Null when
 * no document is found or the detection fails; the capture then keeps the
 * static frame. Runs synchronously (about 0.5 MP of work).
 */
function detectStill(image: HTMLCanvasElement, frame: Frame): Frame | null {
  try {
    return detectFrameIn(image, frame, image.width, detectFrameStrict);
  } catch (error) {
    console.error('Erkennung fehlgeschlagen', error);
    return null;
  }
}

export interface AppOptions {
  /** Build label shown on the start page. */
  version: string;
  build: string;
  /** Update check for the start page; omitted in tests that do not care. */
  updates?: UpdateChecker;
}

export class App {
  private readonly state: State = {
    screen: 'start',
    sheetOpen: false,
    menuOpen: false,
    busy: false,
    level: DEFAULT_COMPRESSION,
    cameraError: 'unavailable',
    cameraOrigin: 'start',
  };

  /** The pages of the scan and which one is on screen. */
  private readonly scan = new Scan();

  // Screens
  private readonly screens: Record<Screen, HTMLElement>;
  private shownScreen: Screen = 'start';
  private readonly leaveTimers = new Map<Screen, ReturnType<typeof setTimeout>>();

  // Start
  private readonly startView: StartView;

  // Camera
  private readonly cameraView: CameraView;
  private readonly flash: HTMLElement;
  /** True while a `startCamera` call is pending, so a second `openCamera` does not start a second stream. */
  private cameraStarting = false;

  // Camera error
  private readonly errorView: ErrorView;

  // Captured
  private readonly capturedView: CapturedView;

  // Crop/rotate
  private readonly editor: CropRotateView;

  // Brightness/contrast
  private readonly toneView: ToneView;

  // Overlays
  private readonly busyOverlay: HTMLElement;
  private readonly notice: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  // Navigation
  private readonly backTrap: BackTrap;

  // Updates
  private readonly updatePrompt: UpdatePrompt;

  /** Detaches the window/document listeners on dispose(). */
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, options: AppOptions) {
    this.updatePrompt = new UpdatePrompt(options.updates ?? null, () => this.render());
    root.style.setProperty('--fade', `${FADE_MS}ms`);

    // Start
    this.startView = new StartView(options, {
      onStart: () => void this.openCamera(),
      onUpdate: () => void this.applyUpdate(),
    });

    // Camera
    this.cameraView = new CameraView({
      onBack: () => this.closeCamera(),
      onShutter: () => void this.takePhoto(),
    });

    // Camera error: warning, retry, back. No text.
    this.errorView = new ErrorView({
      onBack: () => this.closeCamera(),
      onRetry: () => void this.openCamera(),
    });

    // Captured
    this.capturedView = new CapturedView({
      onBack: () => void this.backFromCaptured(),
      onShare: () => this.openSheet(),
      onSelectLevel: (level) => this.selectLevel(level),
      onCloseSheet: () => this.closeSheet(),
      onConfirmShare: () => void this.confirmShare(),
      onToggleMenu: () => this.toggleMenu(),
      onCloseMenu: () => this.closeMenu(),
      onEdit: () => this.openEditor(),
      onTone: () => this.openToneView(),
      onAddPage: () => void this.addPage(),
      onShowPage: (index) => void this.showPage(index),
      onSwipe: (direction) => this.onSwipe(direction),
    });

    // Crop/rotate
    this.editor = new CropRotateView({
      onCancel: () => void this.closeEditor(null),
      onConfirm: (frame) => void this.closeEditor(frame),
      onNotice: () => this.showNotice(),
    });

    // Brightness/contrast
    this.toneView = new ToneView({
      onCancel: () => void this.closeToneView(null),
      onConfirm: (tone) => void this.closeToneView(tone),
      onNotice: () => this.showNotice(),
    });

    // Busy
    this.busyOverlay = el('div', 'busy');
    this.busyOverlay.innerHTML = icons.spinner;
    this.busyOverlay.setAttribute('role', 'status');
    this.busyOverlay.setAttribute('aria-label', 'Bitte warten');
    this.busyOverlay.querySelector('svg')?.setAttribute('aria-hidden', 'true');

    // Brief icon-only error notice for share and bake failures.
    this.notice = el('div', 'notice');
    this.notice.innerHTML = icons.warning;
    this.notice.setAttribute('role', 'alert');
    this.notice.setAttribute('aria-label', 'Fehler');
    this.notice.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    this.notice.hidden = true;

    // Shutter flash.
    this.flash = el('div', 'flash');
    this.flash.setAttribute('aria-hidden', 'true');
    this.flash.addEventListener('animationend', () => this.flash.classList.remove('active'));

    this.screens = {
      start: this.startView.element,
      camera: this.cameraView.element,
      error: this.errorView.element,
      captured: this.capturedView.element,
      edit: this.editor.element,
      tone: this.toneView.element,
    };
    for (const [name, screen] of Object.entries(this.screens)) {
      screen.hidden = name !== 'start';
    }

    root.append(
      this.startView.element,
      this.cameraView.element,
      this.errorView.element,
      this.capturedView.element,
      this.editor.element,
      this.toneView.element,
      this.flash,
      this.busyOverlay,
      this.notice,
    );

    const { signal } = this.listeners;
    // Lifecycle: the camera stream does not survive backgrounding on iOS.
    document.addEventListener('visibilitychange', () => this.onVisibilityChange(), { signal });
    window.addEventListener('pagehide', () => this.discardEverything(), { signal });
    window.addEventListener('beforeunload', () => this.discardEverything(), { signal });

    // Hardware back / swipe back acts as the on-screen back button.
    this.backTrap = new BackTrap(() => this.handleBack(), window.history);
    window.addEventListener('popstate', () => this.backTrap.handlePop(), { signal });

    this.render();
    this.updatePrompt.check();
  }

  /** Current screen, for tests. */
  get screen(): Screen {
    return this.state.screen;
  }

  /** Number of pages in the scan, for tests. */
  get pageCount(): number {
    return this.scan.count;
  }

  /** Index of the page on screen, for tests. */
  get currentIndex(): number {
    return this.scan.currentIndex;
  }

  /** Pages holding a full-resolution canvas; must never exceed one (tests). */
  get liveCanvasCount(): number {
    return this.scan.liveCanvasCount;
  }

  /** Read-only view of the pages, for tests. */
  get pageList(): readonly Page[] {
    return this.scan.list;
  }

  /** Zoom state of the captured view, for tests. */
  get capturedZoom(): ZoomState {
    return this.capturedView.stage.zoom;
  }

  /** Releases resources and detaches global listeners (tests). */
  dispose(): void {
    this.discardEverything();
    this.listeners.abort();
    this.cameraView.dispose();
    this.capturedView.dispose();
    this.editor.dispose();
    this.toneView.dispose();
    for (const timer of this.leaveTimers.values()) clearTimeout(timer);
    this.leaveTimers.clear();
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
  }

  // ---- rendering -------------------------------------------------------

  private render(): void {
    const { screen, sheetOpen, menuOpen, busy, level, cameraError } = this.state;
    if (screen !== this.shownScreen) {
      this.switchScreen(this.shownScreen, screen);
      this.shownScreen = screen;
    }
    this.startView.render({ updateAvailable: this.updatePrompt.available });
    this.busyOverlay.hidden = !busy;
    this.errorView.render({ kind: cameraError });
    this.capturedView.render({
      active: screen === 'captured',
      count: this.scan.count,
      current: this.scan.currentIndex,
      isFull: this.scan.isFull,
      menuOpen,
      sheetOpen,
      level,
    });
    if (screen === 'camera') this.cameraView.layout();
    this.backTrap.setActive(screen !== 'start');
  }

  /**
   * Cross-fades from one screen to the next: the new screen fades in on top,
   * the old one stays underneath until the fade is over and is then hidden.
   */
  private switchScreen(from: Screen, to: Screen): void {
    const fromEl = this.screens[from];
    const toEl = this.screens[to];
    const pending = this.leaveTimers.get(to);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.leaveTimers.delete(to);
    }
    toEl.hidden = false;
    // Entering the captured view always starts from the fitted view (v0.9).
    if (to === 'captured') this.capturedView.stage.resetZoom();
    toEl.classList.remove('leaving');
    toEl.classList.add('entering');
    fromEl.classList.remove('entering');
    fromEl.classList.add('leaving');
    const delay = prefersReducedMotion() ? 0 : FADE_MS;
    const timer = setTimeout(() => {
      this.leaveTimers.delete(from);
      fromEl.classList.remove('leaving');
      fromEl.hidden = true;
      // The edit views keep their display copies until they are off screen.
      if (from === 'edit') this.editor.close();
      if (from === 'tone') this.toneView.close();
    }, delay);
    this.leaveTimers.set(from, timer);
  }

  /**
   * Moves to a screen with the sheet and the popover closed. Arriving on the
   * start page asks for an update.
   */
  private showScreen(screen: Screen): void {
    this.state.screen = screen;
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    this.render();
    if (screen === 'start') this.updatePrompt.check();
  }

  /** Shows the current page's frame region on the captured stage, fitted (the zoom resets). */
  private renderPreview(): void {
    const capture = this.scan.currentCapture();
    if (!capture) {
      this.capturedView.stage.clear();
      return;
    }
    this.capturedView.stage.show(capture);
  }

  /** Shows the warning icon briefly over the current view. */
  private showNotice(): void {
    this.notice.hidden = false;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice.hidden = true;
      this.noticeTimer = null;
    }, NOTICE_MS);
  }

  private fail(logLabel: string, error: unknown): void {
    console.error(logLabel, error);
    this.showNotice();
  }

  // ---- navigation ------------------------------------------------------

  /** Hardware back: the same action as the current screen's back button. */
  private handleBack(): void {
    if (this.state.busy) {
      // Nothing can be interrupted; keep the trap armed.
      this.render();
      return;
    }
    switch (this.state.screen) {
      case 'camera':
      case 'error':
        this.closeCamera();
        break;
      case 'captured':
        if (this.state.sheetOpen) this.closeSheet();
        else if (this.state.menuOpen) this.closeMenu();
        else void this.backFromCaptured();
        break;
      case 'edit':
        void this.closeEditor(null);
        break;
      case 'tone':
        void this.closeToneView(null);
        break;
      case 'start':
        this.render();
        break;
    }
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === 'visible' && this.state.screen === 'start') {
      this.updatePrompt.check();
    }
    if (this.state.screen !== 'camera') return;
    if (document.visibilityState === 'hidden') {
      this.cameraView.close();
    } else if (!this.cameraView.session) {
      void this.openCamera();
    }
  }

  // ---- updates ---------------------------------------------------------

  /** Activates the new build behind the busy overlay; the page reloads on success. */
  private async applyUpdate(): Promise<void> {
    if (!this.updatePrompt.enabled || this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      await this.updatePrompt.apply();
    } catch (error) {
      console.error(error);
      this.state.busy = false;
      this.render();
      this.showNotice();
    }
  }

  // ---- transitions -----------------------------------------------------

  private async openCamera(origin: CameraOrigin = 'start'): Promise<void> {
    if (this.cameraView.session || this.cameraStarting) return;
    if (this.state.screen !== 'camera' && this.state.screen !== 'error') {
      this.state.cameraOrigin = origin;
    }
    this.state.screen = 'camera';
    this.render();
    let session: CameraSession;
    this.cameraStarting = true;
    try {
      session = await startCamera(this.cameraView.video);
    } catch (error) {
      console.error('Kamera nicht verfügbar', error);
      this.state.cameraError = cameraErrorKind(error);
      if (this.state.screen === 'camera') this.state.screen = 'error';
      this.render();
      return;
    } finally {
      this.cameraStarting = false;
    }
    if (this.state.screen !== 'camera') {
      // Left the camera while it was starting.
      stopCamera(session);
      return;
    }
    if (document.visibilityState === 'hidden') {
      // Backgrounded while it was starting: the visibility handler restarts it on return.
      stopCamera(session);
      return;
    }
    this.cameraView.open(session);
    this.render();
  }

  /** Camera back: to the start page, or back to the page shown before [+]. */
  private closeCamera(): void {
    if (this.state.busy) return;
    this.cameraView.close();
    if (this.state.cameraOrigin === 'captured' && this.scan.count > 0) {
      void this.returnToCaptured();
      return;
    }
    this.discardPages();
    this.showScreen('start');
  }

  /** Wakes the current page and shows the captured view. */
  private async returnToCaptured(): Promise<void> {
    const page = this.scan.currentPage();
    if (page && !(await this.wakeOrLeave(page))) return;
    this.renderPreview();
    this.showScreen('captured');
  }

  /**
   * Wakes a parked page behind the busy overlay. When it cannot be decoded
   * the page is lost: the scan is discarded and the start page shown rather
   * than a blank view. Returns whether the page holds a canvas.
   */
  private async wakeOrLeave(page: Page): Promise<boolean> {
    if (!page.image) {
      await this.runBusy(() => this.scan.wake(page), 'Seite konnte nicht geladen werden');
    }
    if (page.image) return true;
    this.discardPages();
    this.showScreen('start');
    return false;
  }

  private async takePhoto(): Promise<void> {
    const { session, liveFrame, liveDetect, liveFound } = this.cameraView;
    if (!session || this.state.busy) return;
    let image: HTMLCanvasElement;
    try {
      image = captureStill(session);
    } catch (error) {
      this.fail('Aufnahme fehlgeschlagen', error);
      return;
    }
    this.shutterFeedback();
    // The capture canvas may be downscaled (iOS pixel cap): scale the live frame with it.
    const staticFrame = liveFrame
      ? scaleFrame(liveFrame, image.width / session.width)
      : initialFrame(image.width, image.height);
    this.cameraView.close();
    // v0.10: the still is detected once more from the static frame; the live
    // result is only feedback (the still is grabbed later than the last video frame).
    const detected = liveDetect ? detectStill(image, staticFrame) : null;
    // Appended after the last page; the previous current page was parked by [+].
    // The page starts with the static frame; a detected document is baked in below.
    const page = newPage({ image, frame: staticFrame });
    this.scan.add(page);
    this.renderPreview();
    this.showScreen('captured');
    if (detected) {
      // The bake hands back an upright frame; a failed bake leaves the page
      // with its image and the static frame.
      await this.runBusy(() => {
        applyCapture(page, bakeFrame(asCapture(page), detected));
      }, 'Entzerren fehlgeschlagen', frameNeedsBake(detected));
      this.renderPreview();
      this.render();
    } else if (liveFound) {
      this.showNotice();
    }
  }

  private shutterFeedback(): void {
    if (prefersReducedMotion()) return;
    this.flash.classList.remove('active');
    // Restart the animation even if the previous one is still running.
    void this.flash.offsetWidth;
    this.flash.classList.add('active');
    vibrate(30);
  }

  /**
   * Back from the captured view. With several pages: remove the current page
   * and show its neighbour. With one page: drop it and reopen the camera.
   */
  private async backFromCaptured(): Promise<void> {
    if (this.state.busy) return;
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    if (this.scan.count <= 1) {
      this.discardPages();
      await this.openCamera('start');
      return;
    }
    // The previous page, or the next one if the first page was removed.
    const next = this.scan.removeCurrent();
    this.capturedView.stage.clear();
    await this.switchToPage(next);
  }

  /** [+]: park the current page and open the camera for the next one. */
  private async addPage(): Promise<void> {
    if (this.state.busy || this.scan.isFull) return;
    const page = this.scan.currentPage();
    if (!page) return;
    this.state.menuOpen = false;
    this.state.sheetOpen = false;
    await this.runBusy(() => this.scan.park(page), 'Seite konnte nicht abgelegt werden');
    if (page.image) return; // parking failed; stay on the page
    this.capturedView.stage.clear();
    await this.openCamera('captured');
  }

  /** Previous/next: park the page on screen, wake the target. Not a screen change. */
  private async showPage(index: number): Promise<void> {
    if (this.state.busy || index < 0 || index >= this.scan.count || index === this.scan.currentIndex) return;
    const leaving = this.scan.currentPage();
    if (leaving) {
      await this.runBusy(() => this.scan.park(leaving), 'Seite konnte nicht abgelegt werden');
      if (leaving.image) return; // parking failed; stay
    }
    await this.switchToPage(index);
  }

  /** A swipe over the fitted image: next page on left, previous on right, unless something is open. */
  private onSwipe(direction: SwipeDirection): void {
    if (this.state.busy || this.state.menuOpen || this.state.sheetOpen || this.scan.count < 2) return;
    if (direction === 'left') void this.showPage(this.scan.currentIndex + 1);
    else void this.showPage(this.scan.currentIndex - 1);
  }

  /** Makes a page current: wakes it if parked and redraws the preview. */
  private async switchToPage(index: number): Promise<void> {
    const page = this.scan.switchTo(index);
    if (page && !(await this.wakeOrLeave(page))) return;
    this.renderPreview();
    this.render();
  }

  private openSheet(): void {
    this.state.level = DEFAULT_COMPRESSION;
    this.state.sheetOpen = true;
    this.render();
  }

  private closeSheet(): void {
    this.state.sheetOpen = false;
    this.render();
  }

  private toggleMenu(): void {
    this.state.menuOpen = !this.state.menuOpen;
    this.render();
  }

  private closeMenu(): void {
    this.state.menuOpen = false;
    this.render();
  }

  private openEditor(): void {
    const capture = this.scan.currentCapture();
    if (!capture) return;
    this.state.menuOpen = false;
    this.state.screen = 'edit';
    this.editor.open(capture);
    this.render();
  }

  /**
   * Leaves the crop/rotate view. With a frame: store it, baking any rotation
   * and displaced corners into the image first, behind the busy overlay.
   * Without: discard the pending edits. The view itself is closed once it
   * has faded out.
   */
  private async closeEditor(frame: Frame | null): Promise<void> {
    if (this.state.busy || this.state.screen !== 'edit') return;
    const page = this.scan.currentPage();
    if (frame && page?.image) {
      await this.runBusy(() => {
        applyCapture(page, bakeFrame(asCapture(page), frame));
      }, hasCornerOffsets(frame) ? 'Entzerren fehlgeschlagen' : 'Drehen fehlgeschlagen', frameNeedsBake(frame));
      this.renderPreview();
    }
    this.showScreen('captured');
  }

  private openToneView(): void {
    const capture = this.scan.currentCapture();
    if (!capture) return;
    this.state.menuOpen = false;
    this.state.screen = 'tone';
    this.toneView.open(capture);
    this.render();
  }

  /**
   * Leaves the brightness/contrast view. With values: bake them into the
   * whole image behind the busy overlay. Without: discard the pending values.
   */
  private async closeToneView(tone: Tone | null): Promise<void> {
    if (this.state.busy || this.state.screen !== 'tone') return;
    const page = this.scan.currentPage();
    if (tone && page?.image) {
      await this.runBusy(() => {
        applyCapture(page, bakeTone(asCapture(page), tone));
      }, 'Anpassen fehlgeschlagen', !isNeutralTone(tone));
      this.renderPreview();
    }
    this.showScreen('captured');
  }

  /**
   * Runs pixel work (baking, parking, waking) behind the busy overlay. The
   * overlay is shown first and the work deferred until it has painted,
   * otherwise the spinner never appears; work that is not heavy runs inline
   * without the overlay. Failures leave the image untouched and show the
   * notice; the caller checks the outcome on the page.
   */
  private async runBusy(work: () => void | Promise<void>, logLabel: string, heavy = true): Promise<void> {
    if (!heavy) {
      try {
        await work();
      } catch (error) {
        this.fail(logLabel, error);
      }
      return;
    }
    this.state.busy = true;
    this.render();
    await afterPaint();
    try {
      await work();
    } catch (error) {
      this.fail(logLabel, error);
    } finally {
      this.state.busy = false;
      this.render();
    }
  }

  private selectLevel(level: CompressionLevel): void {
    this.state.level = level;
    this.render();
  }

  private async confirmShare(): Promise<void> {
    if (this.scan.count === 0 || this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      const file = await buildPdfFile(this.scan.list, this.state.level);
      const outcome = await sharePdf(file);
      this.state.busy = false;
      if (outcome === 'shared') {
        this.discardPages();
        this.showScreen('start');
        return;
      }
      this.state.sheetOpen = false;
    } catch (error) {
      this.state.busy = false;
      this.fail('Teilen fehlgeschlagen', error);
    }
    this.render();
  }

  // ---- resources -------------------------------------------------------

  /** Drops every page of the scan; nothing is retained. */
  private discardPages(): void {
    this.scan.discard();
    this.capturedView.stage.clear();
  }

  private discardEverything(): void {
    this.cameraView.close();
    this.editor.close();
    this.toneView.close();
    this.discardPages();
  }
}
