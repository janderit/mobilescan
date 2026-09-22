/**
 * MobileScan app shell: start -> camera (or camera error) -> captured ->
 * (share sheet | edit popover -> crop/rotate | brightness/contrast | [+] camera) -> busy.
 * One in-memory state machine, plain DOM, no persistence. A scan is a list of
 * pages of which only the current one holds a full-resolution canvas (v0.5).
 * The captured view shows the current page on a zoomable `FrameStage` (v0.9);
 * the zoom is view state only and resets whenever the view is entered.
 */

import * as icons from './icons';
import { MAX_PAGES, type Capture, type CompressionLevel, type Page } from './model';
import { afterPaint, iconButton, prefersReducedMotion, svgEl } from './ui';
import {
  coverTransform,
  frameToViewRect,
  hasCornerOffsets,
  initialFrame,
  scaleFrame,
  visibleImageRect,
  type CoverTransform,
  type Quad,
} from './geometry';
import type { Frame, Point } from './model';
import { COMPRESSION_LEVELS, DEFAULT_COMPRESSION } from './quality';
import {
  cameraErrorKind,
  captureStill,
  startCamera,
  stopCamera,
  type CameraErrorKind,
  type CameraSession,
} from './camera';
import { buildPdfFile, sharePdf } from './share';
import type { UpdateChecker } from './update';
import { applyCapture, asCapture, newPage, parkPage, releasePage, wakePage } from './pages';
import { CropRotateView } from './editor';
import { ToneView } from './tone-view';
import { isNeutralTone, type Tone } from './tone';
import { bakeFrame, bakeTone, frameNeedsBake } from './bake';
import { BackTrap } from './navigation';
import { swipeDirection } from './swipe';
import { FrameStage } from './frame-stage';
import type { ZoomState } from './zoom';
import { detectFrameStrict, frameWorkingLayout, type TrackerState } from './detect';
import { sampleImage } from './canvas';
import { LiveDetector } from './live-detect';

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
  /** v0.10: live document detection and auto-bake on capture; session state only. */
  liveDetect: boolean;
}

/** Cross-fade between screens; must match `--fade` in styles.css. */
export const FADE_MS = 150;

/** How long the icon-only error notice stays on screen. */
export const NOTICE_MS = 2000;

/** Vibration when the live outline turns green (the shutter uses 30 ms). */
const FOUND_VIBRATION_MS = 15;

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

/** Disabled look and no action, without removing the button from the focus order. */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.setAttribute('aria-disabled', String(disabled));
  button.disabled = disabled;
}

function sameFrame(a: Frame, b: Frame): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.width === b.width && a.height === b.height && a.angle === b.angle;
}

/**
 * v0.10: the strict detection on the still, from the static frame. Null when
 * no document is found or the detection fails; the capture then keeps the
 * static frame. Runs synchronously (about 0.5 MP of work).
 */
function detectStill(image: HTMLCanvasElement, frame: Frame): Frame | null {
  try {
    const layout = frameWorkingLayout(frame);
    const working = sampleImage(image, layout.transform, layout.width, layout.height);
    return detectFrameStrict(working, layout, frame, image.width);
  } catch (error) {
    console.error('Erkennung fehlgeschlagen', error);
    return null;
  }
}

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
  /** Update check for the start page; omitted in tests that do not care. */
  updates?: UpdateChecker;
}

/** Minimum time between two update checks, so returning to the start page repeatedly stays cheap. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

export class App {
  private readonly state: State = {
    screen: 'start',
    sheetOpen: false,
    menuOpen: false,
    busy: false,
    level: DEFAULT_COMPRESSION,
    cameraError: 'unavailable',
    cameraOrigin: 'start',
    liveDetect: true,
  };

  /** Pages in capture order; empty outside a scan. */
  private readonly pages: Page[] = [];
  /** Index of the page on screen. */
  private current = 0;
  private session: CameraSession | null = null;
  /** Frame shown over the live video, in track pixel coordinates. */
  private liveFrame: Frame | null = null;
  /** Track pixels -> viewport pixels of the camera screen. */
  private cover: CoverTransform | null = null;
  /** Live detection (v0.10): the loop and its last state. */
  private readonly liveDetector: LiveDetector;
  private liveState: TrackerState = { found: false, corners: null };

  // Screens
  private readonly screens: Record<Screen, HTMLElement>;
  private shownScreen: Screen = 'start';
  private readonly leaveTimers = new Map<Screen, ReturnType<typeof setTimeout>>();

  // Camera
  private readonly cameraScreen: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly frameOverlay: SVGSVGElement;
  private readonly frameShade: SVGPathElement;
  private readonly framePolygon: SVGPolygonElement;
  private readonly shutterButton: HTMLButtonElement;
  private readonly detectButton: HTMLButtonElement;
  private readonly flash: HTMLElement;

  // Camera error
  private readonly errorStatus: HTMLElement;

  // Captured
  private readonly capturedStage: FrameStage;
  private readonly menuBackdrop: HTMLElement;
  private readonly editButton: HTMLButtonElement;
  private readonly addButton: HTMLButtonElement;
  private readonly pageHeader: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly pagePosition: HTMLElement;
  /** Start of a pointer drag over the captured stage, for swipe detection. */
  private swipeStart: { id: number; x: number; y: number } | null = null;

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

  // Updates
  private readonly updates: UpdateChecker | null;
  private readonly updateButton: HTMLButtonElement;
  private updateAvailable = false;
  private updateChecking = false;
  private lastUpdateCheck = Number.NEGATIVE_INFINITY;

  /** Detaches the window/document listeners on dispose(). */
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, options: AppOptions) {
    this.updates = options.updates ?? null;

    // Start
    const startButton = el('button', 'start-button', 'Dokument scannen');
    startButton.type = 'button';
    startButton.addEventListener('click', () => void this.openCamera());
    // Update button: shown only when the server has a newer build. The slot
    // keeps its height so the layout does not jump when the button appears.
    this.updateButton = iconButton(icons.refresh, 'App aktualisieren', 'primary update-button');
    this.updateButton.hidden = true;
    this.updateButton.addEventListener('click', () => void this.applyUpdate());
    // Version line: makes it visible on the phone whether a new build has arrived.
    const version = el('p', 'app-version', `v${options.version} (${options.build})`);
    const startScreen = el(
      'section',
      'screen screen-start',
      el('h1', 'app-title', 'MobileScan'),
      startButton,
      el('div', 'update-slot', this.updateButton),
      version,
    );

    // Camera
    this.video = document.createElement('video');
    this.video.className = 'camera-video';
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    // The frame overlay: a shade with a hole and the dashed outline, which is
    // the static DIN rectangle or, with a document found (v0.10), its corners.
    this.frameOverlay = svgEl('svg', { class: 'camera-frame', 'aria-hidden': 'true' });
    this.frameShade = svgEl('path', { class: 'camera-shade', 'fill-rule': 'evenodd' });
    this.framePolygon = svgEl('polygon', { class: 'camera-outline' });
    this.frameOverlay.append(this.frameShade, this.framePolygon);
    this.frameOverlay.setAttribute('hidden', '');
    const cameraBack = iconButton(icons.arrowLeft, 'Zurück', 'dark camera-back');
    cameraBack.addEventListener('click', () => this.closeCamera());
    this.shutterButton = iconButton(icons.shutter, 'Foto aufnehmen', 'camera-shutter');
    this.shutterButton.addEventListener('click', () => void this.takePhoto());
    this.detectButton = iconButton(icons.magicWand, 'Dokument automatisch erkennen', 'dark camera-detect');
    this.detectButton.addEventListener('click', () => this.toggleLiveDetect());
    this.cameraScreen = el(
      'section',
      'screen screen-camera',
      this.video,
      this.frameOverlay,
      cameraBack,
      this.shutterButton,
      this.detectButton,
    );
    this.liveDetector = new LiveDetector(this.video, { onResult: (state) => this.onLiveResult(state) });

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

    // Captured: the frame region on a zoomable stage. In the fitted view a
    // one-finger swipe over the image moves between pages like the arrows;
    // zoomed in, one finger pans instead.
    this.capturedStage = new FrameStage('captured-canvas', {
      onPointerDown: (event) => this.onSwipeStart(event),
      onPointerEnd: (event) => this.onSwipeEnd(event),
      onGestureStart: () => {
        this.swipeStart = null;
      },
    });
    const capturedBack = iconButton(icons.arrowLeft, 'Zurück');
    capturedBack.addEventListener('click', () => void this.backFromCaptured());
    const shareButton = iconButton(icons.share, 'Teilen', 'primary');
    shareButton.addEventListener('click', () => this.openSheet());
    this.editButton = iconButton(icons.edit, 'Bearbeiten');
    this.editButton.setAttribute('aria-haspopup', 'menu');
    this.editButton.addEventListener('click', () => this.toggleMenu());
    this.addButton = iconButton(icons.addPage, 'Weitere Seite scannen');
    this.addButton.addEventListener('click', () => void this.addPage());

    // Page header: [previous] "n/m" [next], only with two or more pages.
    this.previousButton = iconButton(icons.chevronLeft, 'Vorherige Seite', 'compact page-arrow');
    this.previousButton.addEventListener('click', () => void this.showPage(this.current - 1));
    this.nextButton = iconButton(icons.chevronRight, 'Nächste Seite', 'compact page-arrow');
    this.nextButton.addEventListener('click', () => void this.showPage(this.current + 1));
    this.pagePosition = el('span', 'page-position');
    this.pagePosition.setAttribute('aria-live', 'polite');
    this.pageHeader = el('div', 'page-header', this.previousButton, this.pagePosition, this.nextButton);
    this.pageHeader.hidden = true;

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
      this.pageHeader,
      this.capturedStage.element,
      el('div', 'button-bar', capturedBack, shareButton, this.editButton, this.addButton),
      this.menuBackdrop,
      this.sheetBackdrop,
    );

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
    this.checkForUpdate();
  }

  /** Current screen, for tests. */
  get screen(): Screen {
    return this.state.screen;
  }

  /** Number of pages in the scan, for tests. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** Index of the page on screen, for tests. */
  get currentIndex(): number {
    return this.current;
  }

  /** Pages holding a full-resolution canvas; must never exceed one (tests). */
  get liveCanvasCount(): number {
    return this.pages.filter((page) => page.image !== null).length;
  }

  /** Read-only view of the pages, for tests. */
  get pageList(): readonly Page[] {
    return this.pages;
  }

  /** Zoom state of the captured view, for tests. */
  get capturedZoom(): ZoomState {
    return this.capturedStage.zoom;
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
      if (screen === 'start') this.checkForUpdate();
    }
    this.updateButton.hidden = !this.updateAvailable;
    this.sheetBackdrop.hidden = !(screen === 'captured' && sheetOpen);
    this.menuBackdrop.hidden = !(screen === 'captured' && menuOpen);
    this.editButton.setAttribute('aria-expanded', String(menuOpen));
    this.editButton.classList.toggle('primary', menuOpen);
    this.busyOverlay.hidden = !busy;
    this.errorStatus.setAttribute('aria-label', CAMERA_ERROR_LABELS[cameraError]);
    this.detectButton.setAttribute('aria-pressed', String(this.state.liveDetect));
    for (const l of COMPRESSION_LEVELS) {
      this.levelButtons[l].setAttribute('aria-checked', String(l === level));
    }
    this.renderPageHeader();
    if (screen === 'camera') this.layoutFrame();
    if (screen === 'captured') this.capturedStage.layout();
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
    if (to === 'captured') this.capturedStage.resetZoom();
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
   * Computes the static DIN frame over the video (track pixels) and the cover
   * transform to the viewport, draws the overlay and keeps the live detection
   * in step with the frame.
   */
  private layoutFrame(): void {
    const session = this.session;
    if (!session || this.state.screen !== 'camera') {
      this.frameOverlay.setAttribute('hidden', '');
      return;
    }
    const viewW = this.cameraScreen.clientWidth;
    const viewH = this.cameraScreen.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    // Fit the frame into the part of the video the screen shows (object-fit: cover
    // crops the sides on tall phones), so the dashes are always fully visible.
    const visible = visibleImageRect(session.width, session.height, viewW, viewH);
    const frame = initialFrame(session.width, session.height, visible);
    const changed = !this.liveFrame || !sameFrame(this.liveFrame, frame);
    this.liveFrame = frame;
    this.cover = coverTransform(session.width, session.height, viewW, viewH);
    this.frameOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    this.frameOverlay.removeAttribute('hidden');
    this.syncLiveDetector(changed);
    this.renderCameraFrame();
  }

  /** Draws the shade and the outline: the detected corners while found, else the static frame. */
  private renderCameraFrame(): void {
    const frame = this.liveFrame;
    const cover = this.cover;
    if (!frame || !cover) return;
    const toView = (p: Point): Point => ({ x: p.x * cover.scale + cover.offsetX, y: p.y * cover.scale + cover.offsetY });
    const found = this.state.liveDetect && this.liveState.found && this.liveState.corners !== null;
    let points: Point[];
    if (found) {
      points = (this.liveState.corners as Quad).map(toView);
    } else {
      const rect = frameToViewRect(frame, cover);
      points = [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
      ];
    }
    const viewW = this.cameraScreen.clientWidth;
    const viewH = this.cameraScreen.clientHeight;
    const inner = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    this.framePolygon.setAttribute('points', inner);
    const outer = `M0 0H${viewW}V${viewH}H0Z`;
    const hole = `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`;
    this.frameShade.setAttribute('d', outer + hole);
    this.frameOverlay.classList.toggle('found', found);
  }

  /** Starts, restarts or stops the live detection to match the screen, the toggle and the frame. */
  private syncLiveDetector(frameChanged: boolean): void {
    const wanted = this.session !== null && this.state.screen === 'camera' && this.state.liveDetect && this.liveFrame !== null;
    if (!wanted) {
      this.liveDetector.stop();
      this.liveState = { found: false, corners: null };
      return;
    }
    if (frameChanged || !this.liveDetector.running) {
      this.liveState = { found: false, corners: null };
      this.liveDetector.start(this.liveFrame as Frame, (this.session as CameraSession).width);
    }
  }

  private onLiveResult(state: TrackerState): void {
    const wasFound = this.liveState.found;
    this.liveState = state;
    if (state.found && !wasFound) this.vibrate(FOUND_VIBRATION_MS);
    this.renderCameraFrame();
  }

  private toggleLiveDetect(): void {
    this.state.liveDetect = !this.state.liveDetect;
    this.syncLiveDetector(false);
    this.render();
  }

  /** Page navigation above the image; hidden with a single page. */
  private renderPageHeader(): void {
    const count = this.pages.length;
    this.pageHeader.hidden = count <= 1;
    this.pagePosition.textContent = count > 0 ? `${this.current + 1}/${count}` : '';
    setDisabled(this.previousButton, this.current <= 0);
    setDisabled(this.nextButton, this.current >= count - 1);
    setDisabled(this.addButton, count >= MAX_PAGES);
  }

  private currentPage(): Page | null {
    return this.pages[this.current] ?? null;
  }

  /** The current page as a capture; null when it is parked or absent. */
  private currentCapture(): Capture | null {
    const page = this.currentPage();
    return page?.image ? asCapture(page) : null;
  }

  /** Shows the current page's frame region on the captured stage, fitted (the zoom resets). */
  private renderPreview(): void {
    const capture = this.currentCapture();
    if (!capture) {
      this.capturedStage.clear();
      return;
    }
    this.capturedStage.show(capture);
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
      this.checkForUpdate();
    }
    if (this.state.screen !== 'camera') return;
    if (document.visibilityState === 'hidden') {
      this.stopSession();
    } else if (!this.session) {
      void this.openCamera();
    }
  }

  // ---- updates ---------------------------------------------------------

  /**
   * Asks the server for a newer build, at most once a minute and only while
   * online (the checker treats offline and failures as "no update"). Once an
   * update is known, the button stays until it is applied.
   */
  private checkForUpdate(): void {
    if (!this.updates || this.updateAvailable || this.updateChecking) return;
    const now = Date.now();
    if (now - this.lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastUpdateCheck = now;
    this.updateChecking = true;
    this.updates.check().then(
      (available) => {
        this.updateChecking = false;
        if (!available) return;
        this.updateAvailable = true;
        this.render();
      },
      () => {
        this.updateChecking = false;
      },
    );
  }

  /** Activates the new build behind the busy overlay; the page reloads on success. */
  private async applyUpdate(): Promise<void> {
    if (!this.updates || this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      await this.updates.apply();
    } catch (error) {
      console.error(error);
      this.state.busy = false;
      this.render();
      this.showNotice();
    }
  }

  // ---- transitions -----------------------------------------------------

  private async openCamera(origin: CameraOrigin = 'start'): Promise<void> {
    if (this.session) return;
    if (this.state.screen !== 'camera' && this.state.screen !== 'error') {
      this.state.cameraOrigin = origin;
    }
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

  /** Camera back: to the start page, or back to the page shown before [+]. */
  private closeCamera(): void {
    if (this.state.busy) return;
    this.stopSession();
    if (this.state.cameraOrigin === 'captured' && this.pages.length > 0) {
      void this.returnToCaptured();
      return;
    }
    this.discardPages();
    this.state.screen = 'start';
    this.render();
  }

  /** Wakes the current page and shows the captured view. */
  private async returnToCaptured(): Promise<void> {
    const page = this.currentPage();
    if (page && !page.image) {
      await this.runBusyAsync(() => wakePage(page), 'Seite konnte nicht geladen werden');
      if (!page.image) {
        // The page is lost; fall back to the start page rather than a blank view.
        this.discardPages();
        this.state.screen = 'start';
        this.render();
        return;
      }
    }
    this.renderPreview();
    this.state.screen = 'captured';
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    this.render();
  }

  private async takePhoto(): Promise<void> {
    const session = this.session;
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
    const staticFrame = this.liveFrame
      ? scaleFrame(this.liveFrame, image.width / session.width)
      : initialFrame(image.width, image.height);
    const liveFound = this.state.liveDetect && this.liveState.found;
    this.stopSession();
    // v0.10: the still is detected once more from the static frame; the live
    // result is only feedback (the still is grabbed later than the last video frame).
    const detected = this.state.liveDetect ? detectStill(image, staticFrame) : null;
    const frame = detected ?? staticFrame;
    // Appended after the last page; the previous current page was parked by [+].
    const page = newPage({ image, frame });
    this.pages.push(page);
    this.current = this.pages.length - 1;
    this.renderPreview();
    this.state.screen = 'captured';
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    this.render();
    if (detected) {
      await this.runBusy(() => {
        applyCapture(page, bakeFrame(asCapture(page), detected));
      }, 'Entzerren fehlgeschlagen', frameNeedsBake(detected));
      // A failed bake leaves the image with the detected frame still pending (rotated or with
      // offsets), which the rest of the app never expects on a page: fall back to the static frame.
      if (frameNeedsBake(page.frame)) page.frame = staticFrame;
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
    this.vibrate(30);
  }

  /** Haptic feedback where supported; silent under reduced motion. */
  private vibrate(ms: number): void {
    if (prefersReducedMotion() || typeof navigator.vibrate !== 'function') return;
    try {
      navigator.vibrate(ms);
    } catch {
      // Not permitted; feedback is optional.
    }
  }

  /**
   * Back from the captured view. With several pages: remove the current page
   * and show its neighbour. With one page: drop it and reopen the camera.
   */
  private async backFromCaptured(): Promise<void> {
    if (this.state.busy) return;
    this.state.sheetOpen = false;
    this.state.menuOpen = false;
    if (this.pages.length <= 1) {
      this.discardPages();
      await this.openCamera('start');
      return;
    }
    const [removed] = this.pages.splice(this.current, 1);
    if (removed) releasePage(removed);
    this.capturedStage.clear();
    // The previous page, or the next one if the first page was removed.
    await this.switchToPage(Math.max(0, this.current - 1));
  }

  /** [+]: park the current page and open the camera for the next one. */
  private async addPage(): Promise<void> {
    if (this.state.busy || this.pages.length >= MAX_PAGES) return;
    const page = this.currentPage();
    if (!page) return;
    this.state.menuOpen = false;
    this.state.sheetOpen = false;
    await this.runBusyAsync(() => parkPage(page), 'Seite konnte nicht abgelegt werden');
    if (page.image) return; // parking failed; stay on the page
    this.capturedStage.clear();
    await this.openCamera('captured');
  }

  /** Previous/next: park the page on screen, wake the target. Not a screen change. */
  private async showPage(index: number): Promise<void> {
    if (this.state.busy || index < 0 || index >= this.pages.length || index === this.current) return;
    const leaving = this.currentPage();
    if (leaving) {
      await this.runBusyAsync(() => parkPage(leaving), 'Seite konnte nicht abgelegt werden');
      if (leaving.image) return; // parking failed; stay
    }
    await this.switchToPage(index);
  }

  private onSwipeStart(event: PointerEvent): void {
    if (!event.isPrimary) return;
    this.swipeStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  private onSwipeEnd(event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || event.pointerId !== start.id) return;
    this.swipeStart = null;
    if (this.state.busy || this.state.menuOpen || this.state.sheetOpen || this.pages.length < 2) return;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction === 'left') void this.showPage(this.current + 1);
    else if (direction === 'right') void this.showPage(this.current - 1);
  }

  /** Makes a page current: wakes it if parked and redraws the preview. */
  private async switchToPage(index: number): Promise<void> {
    this.current = index;
    const page = this.currentPage();
    if (page && !page.image) {
      await this.runBusyAsync(() => wakePage(page), 'Seite konnte nicht geladen werden');
    }
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
    const capture = this.currentCapture();
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
    const page = this.currentPage();
    if (frame && page?.image) {
      await this.runBusy(() => {
        applyCapture(page, bakeFrame(asCapture(page), frame));
      }, hasCornerOffsets(frame) ? 'Entzerren fehlgeschlagen' : 'Drehen fehlgeschlagen', frameNeedsBake(frame));
      this.renderPreview();
    }
    this.state.screen = 'captured';
    this.render();
  }

  private openToneView(): void {
    const capture = this.currentCapture();
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
    const page = this.currentPage();
    if (tone && page?.image) {
      await this.runBusy(() => {
        applyCapture(page, bakeTone(asCapture(page), tone));
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

  /**
   * Runs asynchronous work (parking, waking) behind the busy overlay.
   * Failures show the notice; the caller checks the outcome on the page.
   */
  private async runBusyAsync(work: () => Promise<void>, failMessage: string): Promise<void> {
    this.state.busy = true;
    this.render();
    await afterPaint();
    try {
      await work();
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
    if (this.pages.length === 0 || this.state.busy) return;
    this.state.busy = true;
    this.render();
    try {
      const file = await buildPdfFile(this.pages, this.state.level);
      const outcome = await sharePdf(file);
      this.state.busy = false;
      this.state.sheetOpen = false;
      if (outcome === 'shared') {
        this.discardPages();
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
    this.liveDetector.stop();
    this.liveState = { found: false, corners: null };
    if (this.session) {
      stopCamera(this.session);
      this.session = null;
    }
    this.liveFrame = null;
    this.cover = null;
    this.frameOverlay.setAttribute('hidden', '');
  }

  /** Drops every page of the scan; nothing is retained. */
  private discardPages(): void {
    for (const page of this.pages) releasePage(page);
    this.pages.length = 0;
    this.current = 0;
    this.capturedStage.clear();
  }

  private discardEverything(): void {
    this.stopSession();
    this.editor.close();
    this.toneView.close();
    this.discardPages();
  }
}
