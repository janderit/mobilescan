/**
 * MobileScan app shell: start -> camera (or camera error) -> captured ->
 * (share sheet | edit popover -> crop/rotate | brightness/contrast) -> busy.
 * One in-memory state machine, plain DOM, no persistence.
 */

import * as icons from './icons';
import type { Capture, CompressionLevel } from './model';
import { afterPaint, iconButton, prefersReducedMotion } from './ui';
import { coverTransform, frameToViewRect, initialFrame, scaleFrame, visibleImageRect } from './geometry';
import type { Frame } from './model';
import { COMPRESSION_LEVELS, DEFAULT_COMPRESSION } from './quality';
import {
  cameraErrorKind,
  captureStill,
  startCamera,
  stopCamera,
  type CameraErrorKind,
  type CameraSession,
} from './camera';
import { buildPdfFile, releaseCanvas, renderFrame, sharePdf } from './share';
import { CropRotateView } from './editor';
import { ToneView } from './tone-view';
import { isNeutralTone, type Tone } from './tone';
import { bakeRotation, bakeTone } from './bake';
import { BackTrap } from './navigation';

export type Screen = 'start' | 'camera' | 'error' | 'captured' | 'edit' | 'tone';

interface State {
  screen: Screen;
  sheetOpen: boolean;
  menuOpen: boolean;
  busy: boolean;
  level: CompressionLevel;
  cameraError: CameraErrorKind;
}

/** Long side of the on-screen preview canvas; the PDF uses the full frame. */
const PREVIEW_MAX_LONG_SIDE = 2048;

/** Cross-fade between screens; must match `--fade` in styles.css. */
export const FADE_MS = 150;

/** How long the icon-only error notice stays on screen. */
export const NOTICE_MS = 2000;

const LEVEL_ICONS: Record<CompressionLevel, string> = {
  small: icons.fileSmall,
  medium: icons.fileMedium,
  large: icons.fileLarge,
};

const LEVEL_LABELS: Record<CompressionLevel, string> = {
  small: 'Kleine Datei',
  medium: 'Mittlere Datei',
  large: 'Große Datei',
};

/** Short captions under the file icons; the sheet is not self-explanatory with icons alone. */
const LEVEL_CAPTIONS: Record<CompressionLevel, string> = {
  small: 'Klein',
  medium: 'Mittel',
  large: 'Groß',
};

export const CAMERA_ERROR_LABELS: Record<CameraErrorKind, string> = {
  denied: 'Kamerazugriff verweigert',
  unavailable: 'Keine Kamera verfügbar',
  insecure: 'Kamera nur über eine sichere Verbindung verfügbar',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

export interface AppOptions {
  /** Build label shown on the start page. */
  version: string;
  build: string;
}

export class App {
  private readonly state: State = {
    screen: 'start',
    sheetOpen: false,
    menuOpen: false,
    busy: false,
    level: DEFAULT_COMPRESSION,
    cameraError: 'unavailable',
  };

  private capture: Capture | null = null;
  private session: CameraSession | null = null;
  /** Frame shown over the live video, in track pixel coordinates. */
  private liveFrame: Frame | null = null;

  // Screens
  private readonly screens: Record<Screen, HTMLElement>;
  private shownScreen: Screen = 'start';
  private readonly leaveTimers = new Map<Screen, ReturnType<typeof setTimeout>>();

  // Camera
  private readonly cameraScreen: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly frameOverlay: HTMLElement;
  private readonly shutterButton: HTMLButtonElement;
  private readonly flash: HTMLElement;

  // Camera error
  private readonly errorStatus: HTMLElement;

  // Captured
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly menuBackdrop: HTMLElement;
  private readonly editButton: HTMLButtonElement;

  // Crop/rotate
  private readonly editor: CropRotateView;

  // Brightness/contrast
  private readonly toneView: ToneView;

  // Share sheet
  private readonly sheetBackdrop: HTMLElement;
  private readonly levelButtons: Record<CompressionLevel, HTMLButtonElement>;

  // Overlays
  private readonly busyOverlay: HTMLElement;
  private readonly notice: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  // Navigation
  private readonly backTrap: BackTrap;

  /** Detaches the window/document listeners on dispose(). */
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, options: AppOptions) {
    // Start
    const startButton = el('button', 'start-button', 'Dokument scannen');
    startButton.type = 'button';
    startButton.addEventListener('click', () => void this.openCamera());
    // Version line: makes it visible on the phone whether a new build has arrived.
    const version = el('p', 'app-version', `v${options.version} (${options.build})`);
    const startScreen = el(
      'section',
      'screen screen-start',
      el('h1', 'app-title', 'MobileScan'),
      startButton,
      version,
    );

    // Camera
    this.video = document.createElement('video');
    this.video.className = 'camera-video';
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.frameOverlay = el('div', 'camera-frame');
    this.frameOverlay.hidden = true;
    const cameraBack = iconButton(icons.arrowLeft, 'Zurück', 'dark camera-back');
    cameraBack.addEventListener('click', () => this.closeCamera());
    this.shutterButton = iconButton(icons.shutter, 'Foto aufnehmen', 'camera-shutter');
    this.shutterButton.addEventListener('click', () => this.takePhoto());
    this.cameraScreen = el(
      'section',
      'screen screen-camera',
      this.video,
      this.frameOverlay,
      cameraBack,
      this.shutterButton,
    );

    // Camera error: warning, retry, back. No text.
    this.errorStatus = el('div', 'error-icon');
    this.errorStatus.innerHTML = icons.warning;
    this.errorStatus.setAttribute('role', 'status');
    this.errorStatus.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    const errorBack = iconButton(icons.arrowLeft, 'Zurück', 'dark camera-back');
    errorBack.addEventListener('click', () => this.closeCamera());
    const retryButton = iconButton(icons.refresh, 'Kamera erneut versuchen', 'primary');
    retryButton.addEventListener('click', () => void this.openCamera());
    const errorScreen = el('section', 'screen screen-error', errorBack, this.errorStatus, retryButton);

    // Captured
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.className = 'captured-canvas';
    const capturedBack = iconButton(icons.arrowLeft, 'Zurück');
    capturedBack.addEventListener('click', () => void this.retake());
    const shareButton = iconButton(icons.share, 'Teilen', 'primary');
    shareButton.addEventListener('click', () => this.openSheet());
    this.editButton = iconButton(icons.edit, 'Bearbeiten');
    this.editButton.setAttribute('aria-haspopup', 'menu');
    this.editButton.addEventListener('click', () => this.toggleMenu());

    // Edit popover: crop/rotate, brightness/contrast.
    const cropItem = iconButton(icons.crop, 'Zuschneiden und drehen', 'compact');
    cropItem.setAttribute('role', 'menuitem');
    cropItem.addEventListener('click', () => this.openEditor());
    const brightnessItem = iconButton(icons.brightness, 'Helligkeit und Kontrast', 'compact');
    brightnessItem.setAttribute('role', 'menuitem');
    brightnessItem.addEventListener('click', () => this.openToneView());
    const menu = el('div', 'popover', cropItem, brightnessItem);
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Bearbeiten');
    this.menuBackdrop = el('div', 'popover-backdrop', menu);
    this.menuBackdrop.addEventListener('click', (event) => {
      if (event.target === this.menuBackdrop) this.closeMenu();
    });

    // Share sheet
    const segmented = el('div', 'segmented');
    segmented.setAttribute('role', 'radiogroup');
    segmented.setAttribute('aria-label', 'Dateigröße');
    this.levelButtons = {} as Record<CompressionLevel, HTMLButtonElement>;
    for (const level of COMPRESSION_LEVELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', LEVEL_LABELS[level]);
      button.innerHTML = LEVEL_ICONS[level];
      button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
      button.append(el('span', 'segmented-caption', LEVEL_CAPTIONS[level]));
      button.addEventListener('click', () => this.selectLevel(level));
      this.levelButtons[level] = button;
      segmented.append(button);
    }
    const cancelButton = iconButton(icons.close, 'Abbrechen');
    cancelButton.addEventListener('click', () => this.closeSheet());
    const confirmButton = iconButton(icons.check, 'Bestätigen', 'primary');
    confirmButton.addEventListener('click', () => void this.confirmShare());
    const sheet = el(
      'div',
      'sheet',
      el('div', 'sheet-handle'),
      segmented,
      el('div', 'button-bar', cancelButton, confirmButton),
    );
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Teilen');
    this.sheetBackdrop = el('div', 'sheet-backdrop', sheet);
    this.sheetBackdrop.addEventListener('click', (event) => {
      if (event.target === this.sheetBackdrop) this.closeSheet();
    });

    const capturedScreen = el(
      'section',
      'screen screen-captured',
      el('div', 'captured-stage', this.previewCanvas),
      el('div', 'button-bar', capturedBack, shareButton, this.editButton),
      this.menuBackdrop,
      this.sheetBackdrop,
    );

    // Crop/rotate
    this.editor = new CropRotateView({
      onCancel: () => void this.closeEditor(null),
      onConfirm: (frame) => void this.closeEditor(frame),
    });

    // Brightness/contrast
    this.toneView = new ToneView(
      {
        onCancel: () => void this.closeToneView(null),
        onConfirm: (tone) => void this.closeToneView(tone),
      },
      PREVIEW_MAX_LONG_SIDE,
    );

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
      start: startScreen,
      camera: this.cameraScreen,
      error: errorScreen,
      captured: capturedScreen,
      edit: this.editor.element,
      tone: this.toneView.element,
    };
    for (const [name, screen] of Object.entries(this.screens)) {
      screen.hidden = name !== 'start';
    }

    root.append(
      startScreen,
      this.cameraScreen,
      errorScreen,
      capturedScreen,
      this.editor.element,
      this.toneView.element,
      this.flash,
      this.busyOverlay,
      this.notice,
    );

    const { signal } = this.listeners;
    const relayout = (): void => this.layoutFrame();
    window.addEventListener('resize', relayout, { signal });
    window.addEventListener('orientationchange', relayout, { signal });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(relayout).observe(this.cameraScreen);
    }

    // Lifecycle: the camera stream does not survive backgrounding on iOS.
    document.addEventListener('visibilitychange', () => this.onVisibilityChange(), { signal });
    window.addEventListener('pagehide', () => this.discardEverything(), { signal });
    window.addEventListener('beforeunload', () => this.discardEverything(), { signal });

    // Hardware back / swipe back acts as the on-screen back button.
    this.backTrap = new BackTrap(() => this.handleBack(), window.history);
    window.addEventListener('popstate', () => this.backTrap.handlePop(), { signal });

    this.render();
  }

  /** Current screen, for tests. */
  get screen(): Screen {
    return this.state.screen;
  }

  /** Releases resources and detaches global listeners (tests). */
  dispose(): void {
    this.discardEverything();
    this.listeners.abort();
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
    this.sheetBackdrop.hidden = !(screen === 'captured' && sheetOpen);
    this.menuBackdrop.hidden = !(screen === 'captured' && menuOpen);
    this.editButton.setAttribute('aria-expanded', String(menuOpen));
    this.editButton.classList.toggle('primary', menuOpen);
    this.busyOverlay.hidden = !busy;
    this.errorStatus.setAttribute('aria-label', CAMERA_ERROR_LABELS[cameraError]);
    for (const l of COMPRESSION_LEVELS) {
      this.levelButtons[l].setAttribute('aria-checked', String(l === level));
    }
    if (screen === 'camera') this.layoutFrame();
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

  /** Positions the dashed DIN frame over the video in viewport coordinates. */
  private layoutFrame(): void {
    const session = this.session;
    if (!session || this.state.screen !== 'camera') {
      this.frameOverlay.hidden = true;
      return;
    }
    const viewW = this.cameraScreen.clientWidth;
    const viewH = this.cameraScreen.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    // Fit the frame into the part of the video the screen shows (object-fit: cover
    // crops the sides on tall phones), so the dashes are always fully visible.
    const visible = visibleImageRect(session.width, session.height, viewW, viewH);
    const frame = initialFrame(session.width, session.height, visible);
    this.liveFrame = frame;
    const rect = frameToViewRect(frame, coverTransform(session.width, session.height, viewW, viewH));
    const style = this.frameOverlay.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    this.frameOverlay.hidden = false;
  }

  private renderPreview(): void {
    const capture = this.capture;
    if (!capture) {
      releaseCanvas(this.previewCanvas);
      return;
    }
    const source = renderFrame(capture, PREVIEW_MAX_LONG_SIDE);
    this.previewCanvas.width = source.width;
    this.previewCanvas.height = source.height;
    this.previewCanvas.getContext('2d')?.drawImage(source, 0, 0);
    releaseCanvas(source);
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

  private fail(message: string, error: unknown): void {
    console.error(message, error);
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
        else void this.retake();
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
    if (this.state.screen !== 'camera') return;
    if (document.visibilityState === 'hidden') {
      this.stopSession();
    } else if (!this.session) {
      void this.openCamera();
    }
  }

  // ---- transitions -----------------------------------------------------

  private async openCamera(): Promise<void> {
    if (this.session) return;
    this.state.screen = 'camera';
    this.render();
    try {
      this.session = await startCamera(this.video);
    } catch (error) {
      console.error('Kamera nicht verfügbar', error);
      this.state.cameraError = cameraErrorKind(error);
      if (this.state.screen === 'camera') this.state.screen = 'error';
      this.render();
      return;
    }
    if (this.state.screen !== 'camera') {
      // Left the camera while it was starting.
      this.stopSession();
      return;
    }
    this.render();
  }

  private closeCamera(): void {
    this.stopSession();
    this.state.screen = 'start';
    this.render();
  }

  private takePhoto(): void {
    const session = this.session;
    if (!session) return;
    let image: HTMLCanvasElement;
    try {
      image = captureStill(session);
    } catch (error) {
      this.fail('Aufnahme fehlgeschlagen', error);
      return;
    }
    this.shutterFeedback();
    // The capture canvas may be downscaled (iOS pixel cap): scale the live frame with it.
    const frame = this.liveFrame
      ? scaleFrame(this.liveFrame, image.width / session.width)
      : initialFrame(image.width, image.height);
    this.stopSession();
    this.capture = { image, frame };
    this.renderPreview();
    this.state.screen = 'captured';
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    this.render();
  }

  private shutterFeedback(): void {
    if (prefersReducedMotion()) return;
    this.flash.classList.remove('active');
    // Restart the animation even if the previous one is still running.
    void this.flash.offsetWidth;
    this.flash.classList.add('active');
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(30);
      } catch {
        // Not permitted; feedback is optional.
      }
    }
  }

  /** Back from the captured view: drop the image and reopen the camera directly. */
  private async retake(): Promise<void> {
    this.discardCapture();
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    await this.openCamera();
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
    const capture = this.capture;
    if (!capture) return;
    this.state.menuOpen = false;
    this.state.screen = 'edit';
    this.editor.open(capture);
    this.render();
  }

  /**
   * Leaves the crop/rotate view. With a frame: store it, baking any rotation
   * into the image first, behind the busy overlay. Without: discard the
   * pending edits. The view itself is closed once it has faded out.
   */
  private async closeEditor(frame: Frame | null): Promise<void> {
    if (this.state.busy || this.state.screen !== 'edit') return;
    if (frame && this.capture) {
      await this.runBusy(() => {
        if (this.capture) this.capture = bakeRotation(this.capture, frame);
      }, 'Drehen fehlgeschlagen', frame.angle !== 0);
      this.renderPreview();
    }
    this.state.screen = 'captured';
    this.render();
  }

  private openToneView(): void {
    const capture = this.capture;
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
    if (tone && this.capture) {
      await this.runBusy(() => {
        if (this.capture) this.capture = bakeTone(this.capture, tone);
      }, 'Anpassen fehlgeschlagen', !isNeutralTone(tone));
      this.renderPreview();
    }
    this.state.screen = 'captured';
    this.render();
  }

  /**
   * Runs synchronous pixel work behind the busy overlay. The overlay is
   * shown first and the work deferred until it has painted, otherwise the
   * spinner never appears. Failures leave the image untouched and show the
   * notice.
   */
  private async runBusy(work: () => void, failMessage: string, heavy = true): Promise<void> {
    if (!heavy) {
      try {
        work();
      } catch (error) {
        this.fail(failMessage, error);
      }
      return;
    }
    this.state.busy = true;
    this.render();
    await afterPaint();
    try {
      work();
    } catch (error) {
      this.fail(failMessage, error);
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
    const capture = this.capture;
    if (!capture || this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      const file = await buildPdfFile(capture, this.state.level);
      const outcome = await sharePdf(file);
      this.state.busy = false;
      this.state.sheetOpen = false;
      if (outcome === 'shared') {
        this.discardCapture();
        this.state.screen = 'start';
      }
    } catch (error) {
      this.state.busy = false;
      this.fail('Teilen fehlgeschlagen', error);
    }
    this.render();
  }

  // ---- resources -------------------------------------------------------

  private stopSession(): void {
    if (this.session) {
      stopCamera(this.session);
      this.session = null;
    }
    this.liveFrame = null;
    this.frameOverlay.hidden = true;
  }

  private discardCapture(): void {
    if (this.capture) {
      releaseCanvas(this.capture.image);
      this.capture = null;
    }
    releaseCanvas(this.previewCanvas);
  }

  private discardEverything(): void {
    this.stopSession();
    this.editor.close();
    this.toneView.close();
    this.discardCapture();
  }
}
