/**
 * MobileScan app shell: start -> camera (or camera error) -> captured ->
 * (share popover -> share sheet | edit popover -> crop/rotate | brightness/contrast | [+] camera) -> busy.
 * One in-memory state machine, plain DOM, no persistence. A scan is a list of
 * pages of which only the current one holds a full-resolution canvas.
 *
 * The shell wires the screens to three helpers: `ScreenSwitcher` cross-fades
 * between them, `Overlays` owns the busy spinner and the error notice and
 * runs work behind them, and `PageFlow` parks, wakes and bakes pages over
 * the `Scan`. The captured screen (`CapturedView`) shows the current page on
 * a zoomable `FrameStage`; the zoom is view state only and resets whenever
 * the view is entered.
 */

import type { CompressionLevel, Frame, Page, ShareFormat } from './model';
import { el, prefersReducedMotion } from './ui';
import { initialFrame, scaleFrame } from './geometry';
import { DEFAULT_COMPRESSION } from './quality';
import { cameraErrorKind, captureStill, startCamera, stopCamera, type CameraErrorKind, type CameraSession } from './camera';
import { buildJpegFile, buildPdfFile, shareFile } from './share';
import type { UpdateChecker } from './update';
import { UpdatePrompt } from './update-prompt';
import { newPage } from './pages';
import { Scan } from './scan';
import { PageFlow } from './page-flow';
import { Overlays } from './overlays';
import { ScreenSwitcher } from './screen-switcher';
import { StartView } from './start-view';
import { ErrorView } from './error-view';
import { CameraView, vibrate } from './camera-view';
import { CapturedView } from './captured-view';
import { CropRotateView } from './editor';
import { ToneView } from './tone-view';
import type { Tone } from './tone';
import { BackTrap } from './navigation';
import type { SwipeDirection } from './swipe';
import type { ZoomState } from './zoom';
import { detectStill } from './live-detect';

export type Screen = 'start' | 'camera' | 'error' | 'captured' | 'edit' | 'tone';

/** Where the camera was opened from; camera back returns there. */
type CameraOrigin = 'start' | 'captured';

interface State {
  screen: Screen;
  /** The share popover (PDF | image); opens only while the scan has one page. */
  shareMenuOpen: boolean;
  sheetOpen: boolean;
  menuOpen: boolean;
  /** What the sheet's confirm produces; chosen in the share popover, PDF with several pages. */
  format: ShareFormat;
  level: CompressionLevel;
  cameraError: CameraErrorKind;
  cameraOrigin: CameraOrigin;
}

export { FADE_MS } from './screen-switcher';
export { NOTICE_MS } from './overlays';
export { CAMERA_ERROR_LABELS } from './error-view';

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
    shareMenuOpen: false,
    sheetOpen: false,
    menuOpen: false,
    format: 'pdf',
    level: DEFAULT_COMPRESSION,
    cameraError: 'unavailable',
    cameraOrigin: 'start',
  };

  /** The pages of the scan and which one is on screen. */
  private readonly scan = new Scan();
  /** Park, wake and bake behind the busy overlay. */
  private readonly pages: PageFlow;

  // Screens
  private readonly switcher: ScreenSwitcher<Screen>;
  private readonly startView: StartView;
  private readonly cameraView: CameraView;
  private readonly errorView: ErrorView;
  private readonly capturedView: CapturedView;
  private readonly editor: CropRotateView;
  private readonly toneView: ToneView;

  /** True while a `startCamera` call is pending, so a second `openCamera` does not start a second stream. */
  private cameraStarting = false;
  private readonly flash: HTMLElement;

  // Overlays, navigation, updates
  private readonly overlays: Overlays;
  private readonly backTrap: BackTrap;
  private readonly updatePrompt: UpdatePrompt;

  /** Detaches the window/document listeners on dispose(). */
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, options: AppOptions) {
    this.updatePrompt = new UpdatePrompt(options.updates ?? null, () => this.render());
    this.overlays = new Overlays(() => this.render());
    this.pages = new PageFlow(this.scan, this.overlays);

    this.startView = new StartView(options, {
      onStart: () => void this.openCamera(),
      onUpdate: () => void this.applyUpdate(),
    });
    this.cameraView = new CameraView({
      onBack: () => this.closeCamera(),
      onShutter: () => void this.takePhoto(),
    });
    // Camera error: warning, retry, back. No text.
    this.errorView = new ErrorView({
      onBack: () => this.closeCamera(),
      onRetry: () => void this.openCamera(),
    });
    this.capturedView = new CapturedView({
      onBack: () => void this.backFromCaptured(),
      onShare: () => this.share(),
      onCloseShareMenu: () => this.closeShareMenu(),
      onSharePdf: () => this.openSheet('pdf'),
      onShareImage: () => this.openSheet('jpeg'),
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
    this.editor = new CropRotateView({
      onCancel: () => void this.closeEditor(null),
      onConfirm: (frame) => void this.closeEditor(frame),
      onNotice: () => this.overlays.showNotice(),
    });
    this.toneView = new ToneView({
      onCancel: () => void this.closeToneView(null),
      onConfirm: (tone) => void this.closeToneView(tone),
      onNotice: () => this.overlays.showNotice(),
    });

    // Shutter flash.
    this.flash = el('div', 'flash');
    this.flash.setAttribute('aria-hidden', 'true');
    this.flash.addEventListener('animationend', () => this.flash.classList.remove('active'));

    this.switcher = new ScreenSwitcher<Screen>(
      root,
      {
        start: this.startView.element,
        camera: this.cameraView.element,
        error: this.errorView.element,
        captured: this.capturedView.element,
        edit: this.editor.element,
        tone: this.toneView.element,
      },
      'start',
      {
        // Entering the captured view always starts from the fitted view.
        onEnter: (screen) => {
          if (screen === 'captured') this.capturedView.stage.resetZoom();
        },
        // The edit views keep their display copies until they are off screen.
        onLeft: (screen) => {
          if (screen === 'edit') this.editor.close();
          if (screen === 'tone') this.toneView.close();
        },
      },
    );

    root.append(
      this.startView.element,
      this.cameraView.element,
      this.errorView.element,
      this.capturedView.element,
      this.editor.element,
      this.toneView.element,
      this.flash,
      this.overlays.busyElement,
      this.overlays.noticeElement,
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
    this.switcher.dispose();
    this.overlays.dispose();
  }

  // ---- rendering -------------------------------------------------------

  private render(): void {
    const { screen, shareMenuOpen, sheetOpen, menuOpen, level, cameraError } = this.state;
    this.switcher.show(screen);
    this.startView.render({ updateAvailable: this.updatePrompt.available });
    this.errorView.render({ kind: cameraError });
    this.capturedView.render({
      active: screen === 'captured',
      count: this.scan.count,
      current: this.scan.currentIndex,
      isFull: this.scan.isFull,
      shareMenuOpen,
      menuOpen,
      sheetOpen,
      level,
    });
    if (screen === 'camera') this.cameraView.layout();
    this.backTrap.setActive(screen !== 'start');
  }

  /**
   * Moves to a screen with the sheet and the popover closed. Arriving on the
   * start page asks for an update.
   */
  private showScreen(screen: Screen): void {
    this.state.screen = screen;
    this.state.shareMenuOpen = false;
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

  /** Nothing may be interrupted while work runs behind the spinner. */
  private get busy(): boolean {
    return this.overlays.busy;
  }

  // ---- navigation ------------------------------------------------------

  /** Hardware back: the same action as the current screen's back button. */
  private handleBack(): void {
    if (this.busy) {
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
        else if (this.state.shareMenuOpen) this.closeShareMenu();
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
    if (!this.updatePrompt.enabled || this.busy) return;
    // The update yields on its own, so the spinner shows without waiting for a paint.
    await this.overlays.run(() => this.updatePrompt.apply(), 'Aktualisierung fehlgeschlagen', { paint: false });
  }

  // ---- camera ----------------------------------------------------------

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
    if (this.busy) return;
    this.cameraView.close();
    if (this.state.cameraOrigin === 'captured' && this.scan.count > 0) {
      void this.returnToCaptured();
      return;
    }
    this.leaveScan();
  }

  /** Wakes the current page and shows the captured view. */
  private async returnToCaptured(): Promise<void> {
    if (!(await this.pages.wakeCurrent())) {
      this.leaveScan();
      return;
    }
    this.renderPreview();
    this.showScreen('captured');
  }

  private async takePhoto(): Promise<void> {
    const { session, liveFrame, liveDetect, liveFound } = this.cameraView;
    if (!session || this.busy) return;
    let image: HTMLCanvasElement;
    try {
      image = captureStill(session);
    } catch (error) {
      this.overlays.fail('Aufnahme fehlgeschlagen', error);
      return;
    }
    this.shutterFeedback();
    // The capture canvas may be downscaled (iOS pixel cap): scale the live frame with it.
    const staticFrame = liveFrame
      ? scaleFrame(liveFrame, image.width / session.width)
      : initialFrame(image.width, image.height);
    this.cameraView.close();
    // The still is detected once more from the static frame; the live result
    // is only feedback (the still is grabbed later than the last video frame).
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
      await this.pages.bakeFrame(page, detected, 'Entzerren fehlgeschlagen');
      this.renderPreview();
      this.render();
    } else if (liveFound) {
      this.overlays.showNotice();
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

  // ---- pages -----------------------------------------------------------

  /**
   * Back from the captured view. With several pages: remove the current page
   * and show its neighbour. With one page: drop it and reopen the camera.
   */
  private async backFromCaptured(): Promise<void> {
    if (this.busy) return;
    this.state.shareMenuOpen = false;
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
    if (this.busy || this.scan.isFull || !this.scan.currentPage()) return;
    this.state.shareMenuOpen = false;
    this.state.menuOpen = false;
    this.state.sheetOpen = false;
    if (!(await this.pages.parkCurrent())) return; // parking failed; stay on the page
    this.capturedView.stage.clear();
    await this.openCamera('captured');
  }

  /** Previous/next: park the page on screen, wake the target. Not a screen change. */
  private async showPage(index: number): Promise<void> {
    if (this.busy || index < 0 || index >= this.scan.count || index === this.scan.currentIndex) return;
    if (!(await this.pages.parkCurrent())) return; // parking failed; stay
    await this.switchToPage(index);
  }

  /** A swipe over the fitted image: next page on left, previous on right, unless something is open. */
  private onSwipe(direction: SwipeDirection): void {
    if (this.busy || this.state.menuOpen || this.state.sheetOpen || this.scan.count < 2) return;
    if (direction === 'left') void this.showPage(this.scan.currentIndex + 1);
    else void this.showPage(this.scan.currentIndex - 1);
  }

  /** Makes a page current: wakes it if parked and redraws the preview, or leaves the scan when it is lost. */
  private async switchToPage(index: number): Promise<void> {
    if (!(await this.pages.switchTo(index))) {
      this.leaveScan();
      return;
    }
    this.renderPreview();
    this.render();
  }

  // ---- sheet and popover -----------------------------------------------

  /**
   * The share button. With one page the format is the user's choice, so the
   * popover asks PDF or image; with several pages only the PDF makes sense
   * and the sheet opens at once.
   */
  private share(): void {
    if (this.scan.count > 1) {
      this.openSheet('pdf');
      return;
    }
    this.state.shareMenuOpen = !this.state.shareMenuOpen;
    this.render();
  }

  private closeShareMenu(): void {
    this.state.shareMenuOpen = false;
    this.render();
  }

  private openSheet(format: ShareFormat): void {
    this.state.format = format;
    this.state.level = DEFAULT_COMPRESSION;
    this.state.shareMenuOpen = false;
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

  private selectLevel(level: CompressionLevel): void {
    this.state.level = level;
    this.render();
  }

  private async confirmShare(): Promise<void> {
    if (this.scan.count === 0 || this.busy) return;
    // Encoding and sharing yield on their own, so the spinner shows without waiting for a paint.
    const outcome = await this.overlays.run(
      async () => shareFile(await this.buildShareFile()),
      'Teilen fehlgeschlagen',
      { paint: false },
    );
    if (outcome === 'shared') {
      this.leaveScan();
      return;
    }
    this.state.sheetOpen = false;
    this.render();
  }

  /** The file the sheet's confirm shares: a JPEG of the single page, or the PDF of all. */
  private buildShareFile(): Promise<File> {
    const page = this.scan.currentPage();
    if (this.state.format === 'jpeg' && this.scan.count === 1 && page) {
      return buildJpegFile(page, this.state.level);
    }
    return buildPdfFile(this.scan.list, this.state.level);
  }

  // ---- edit views ------------------------------------------------------

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
    if (this.busy || this.state.screen !== 'edit') return;
    const page = this.scan.currentPage();
    if (frame && page) {
      await this.pages.bakeFrame(page, frame);
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
    if (this.busy || this.state.screen !== 'tone') return;
    const page = this.scan.currentPage();
    if (tone && page) {
      await this.pages.bakeTone(page, tone);
      this.renderPreview();
    }
    this.showScreen('captured');
  }

  // ---- resources -------------------------------------------------------

  /** Drops every page of the scan; nothing is retained. */
  private discardPages(): void {
    this.scan.discard();
    this.capturedView.stage.clear();
  }

  /** Drops the scan and shows the start page. */
  private leaveScan(): void {
    this.discardPages();
    this.showScreen('start');
  }

  private discardEverything(): void {
    this.cameraView.close();
    this.editor.close();
    this.toneView.close();
    this.discardPages();
  }
}
