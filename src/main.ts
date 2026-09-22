/**
 * MobileScan v0.1: start -> camera -> captured -> share sheet -> busy.
 * One in-memory state machine, plain DOM, no persistence.
 */

import './styles.css';
import * as icons from './icons';
import type { Capture, CompressionLevel } from './model';
import { coverTransform, frameToViewRect, initialFrame, scaleFrame, visibleImageRect } from './geometry';
import type { Frame } from './model';
import { COMPRESSION_LEVELS, DEFAULT_COMPRESSION } from './quality';
import { captureStill, startCamera, stopCamera, type CameraSession } from './camera';
import { buildPdfFile, releaseCanvas, renderFrame, sharePdf } from './share';

type Screen = 'start' | 'camera' | 'captured';

interface State {
  screen: Screen;
  sheetOpen: boolean;
  busy: boolean;
  level: CompressionLevel;
}

/** Long side of the on-screen preview canvas; the PDF uses the full frame. */
const PREVIEW_MAX_LONG_SIDE = 2048;

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

function iconButton(icon: string, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  return button;
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

class App {
  private readonly state: State = {
    screen: 'start',
    sheetOpen: false,
    busy: false,
    level: DEFAULT_COMPRESSION,
  };

  private capture: Capture | null = null;
  private session: CameraSession | null = null;
  /** Frame shown over the live video, in track pixel coordinates. */
  private liveFrame: Frame | null = null;

  // Screens
  private readonly startScreen: HTMLElement;
  private readonly cameraScreen: HTMLElement;
  private readonly capturedScreen: HTMLElement;

  // Camera
  private readonly video: HTMLVideoElement;
  private readonly frameOverlay: HTMLElement;
  private readonly shutterButton: HTMLButtonElement;

  // Captured
  private readonly previewCanvas: HTMLCanvasElement;

  // Share sheet
  private readonly sheetBackdrop: HTMLElement;
  private readonly levelButtons: Record<CompressionLevel, HTMLButtonElement>;

  // Busy
  private readonly busyOverlay: HTMLElement;

  constructor(root: HTMLElement) {
    // Start
    const startButton = el('button', 'start-button', 'Dokument scannen');
    startButton.type = 'button';
    startButton.addEventListener('click', () => void this.openCamera());
    // Version line: makes it visible on the phone whether a new build has arrived.
    const version = el('p', 'app-version', `v${__APP_VERSION__} (${__APP_BUILD__})`);
    this.startScreen = el(
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

    // Captured
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.className = 'captured-canvas';
    const capturedBack = iconButton(icons.arrowLeft, 'Zurück');
    capturedBack.addEventListener('click', () => void this.retake());
    const shareButton = iconButton(icons.share, 'Teilen', 'primary');
    shareButton.addEventListener('click', () => this.openSheet());
    const editButton = iconButton(icons.edit, 'Bearbeiten');
    editButton.setAttribute('aria-disabled', 'true');
    editButton.tabIndex = -1;

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

    this.capturedScreen = el(
      'section',
      'screen screen-captured',
      el('div', 'captured-stage', this.previewCanvas),
      el('div', 'button-bar', capturedBack, shareButton, editButton),
      this.sheetBackdrop,
    );

    // Busy
    this.busyOverlay = el('div', 'busy');
    this.busyOverlay.innerHTML = icons.spinner;
    this.busyOverlay.setAttribute('role', 'status');
    this.busyOverlay.setAttribute('aria-label', 'Bitte warten');
    this.busyOverlay.querySelector('svg')?.setAttribute('aria-hidden', 'true');

    root.append(this.startScreen, this.cameraScreen, this.capturedScreen, this.busyOverlay);

    const relayout = (): void => this.layoutFrame();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(relayout).observe(this.cameraScreen);
    }
    window.addEventListener('pagehide', () => this.discardEverything());

    this.render();
  }

  // ---- rendering -------------------------------------------------------

  private render(): void {
    const { screen, sheetOpen, busy, level } = this.state;
    this.startScreen.hidden = screen !== 'start';
    this.cameraScreen.hidden = screen !== 'camera';
    this.capturedScreen.hidden = screen !== 'captured';
    this.sheetBackdrop.hidden = !(screen === 'captured' && sheetOpen);
    this.busyOverlay.hidden = !busy;
    for (const l of COMPRESSION_LEVELS) {
      this.levelButtons[l].setAttribute('aria-checked', String(l === level));
    }
    if (screen === 'camera') this.layoutFrame();
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

  // ---- transitions -----------------------------------------------------

  private async openCamera(): Promise<void> {
    if (this.session) return;
    try {
      this.session = await startCamera(this.video);
    } catch (error) {
      console.error('Kamera nicht verfügbar', error);
      return;
    }
    this.state.screen = 'camera';
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
      console.error('Aufnahme fehlgeschlagen', error);
      return;
    }
    // The capture canvas may be downscaled (iOS pixel cap): scale the live frame with it.
    const frame = this.liveFrame
      ? scaleFrame(this.liveFrame, image.width / session.width)
      : initialFrame(image.width, image.height);
    this.stopSession();
    this.capture = { image, frame };
    this.renderPreview();
    this.state.screen = 'captured';
    this.state.sheetOpen = false;
    this.render();
  }

  /** Back from the captured view: drop the image and reopen the camera. */
  private async retake(): Promise<void> {
    this.discardCapture();
    this.state.screen = 'start';
    this.render();
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
      console.error('Teilen fehlgeschlagen', error);
      this.state.busy = false;
      this.state.sheetOpen = false;
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
    this.discardCapture();
  }
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app missing');
}
new App(root);
