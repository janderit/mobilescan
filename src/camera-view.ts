/**
 * Camera screen: the live video, the frame overlay (shade with a hole and the
 * dashed outline, which is the static DIN rectangle or, with a document found,
 * its corners), back, shutter and the live-detect toggle. Owns the
 * camera session while open and the `LiveDetector` loop. The capture itself
 * (`takePhoto`) stays in the app shell, which reads `session`, `liveFrame`
 * and `liveFound` at the shutter.
 */

import * as icons from './icons';
import type { Frame, Point, UprightFrame } from './model';
import { iconButton, el, prefersReducedMotion, svgEl } from './ui';
import { applyAffine, coverTransform, frameCorners, initialFrame, visibleImageRect, type Affine } from './geometry';
import { stopCamera, type CameraSession } from './camera';
import type { TrackerState } from './detect';
import { LiveDetector } from './live-detect';

/** Vibration when the live outline turns green (the shutter uses 30 ms). */
const FOUND_VIBRATION_MS = 15;

/** Haptic feedback where supported; silent under reduced motion. */
export function vibrate(ms: number): void {
  if (prefersReducedMotion() || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(ms);
  } catch {
    // Not permitted; feedback is optional.
  }
}

function sameFrame(a: Frame, b: Frame): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.width === b.width && a.height === b.height && a.angle === b.angle;
}

export interface CameraViewCallbacks {
  /** Back button. */
  onBack: () => void;
  /** Shutter button. */
  onShutter: () => void;
}

export class CameraView {
  readonly element: HTMLElement;
  /** The video element the camera stream is attached to (`startCamera`). */
  readonly video: HTMLVideoElement;

  private readonly frameOverlay: SVGSVGElement;
  private readonly frameShade: SVGPathElement;
  private readonly framePolygon: SVGPolygonElement;
  private readonly detectButton: HTMLButtonElement;
  private readonly liveDetector: LiveDetector;
  private liveState: TrackerState = { found: false, corners: null };
  /** Live document detection and auto-bake on capture; session state only. */
  private detectEnabled = true;

  private currentSession: CameraSession | null = null;
  /** Frame shown over the live video, in track pixel coordinates. */
  private frame: UprightFrame | null = null;
  /** Track pixels -> viewport pixels of the camera screen. */
  private cover: Affine | null = null;

  private observer: ResizeObserver | null = null;
  /** Detaches the window listeners on dispose(). */
  private readonly listeners = new AbortController();

  constructor(callbacks: CameraViewCallbacks) {
    this.video = document.createElement('video');
    this.video.className = 'camera-video';
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.frameOverlay = svgEl('svg', { class: 'camera-frame', 'aria-hidden': 'true' });
    this.frameShade = svgEl('path', { class: 'camera-shade', 'fill-rule': 'evenodd' });
    this.framePolygon = svgEl('polygon', { class: 'camera-outline' });
    this.frameOverlay.append(this.frameShade, this.framePolygon);
    this.frameOverlay.setAttribute('hidden', '');
    const back = iconButton(icons.arrowLeft, 'Zurück', 'dark camera-back');
    back.addEventListener('click', () => callbacks.onBack());
    const shutter = iconButton(icons.shutter, 'Foto aufnehmen', 'camera-shutter');
    shutter.addEventListener('click', () => callbacks.onShutter());
    this.detectButton = iconButton(icons.magicWand, 'Dokument automatisch erkennen', 'dark camera-detect');
    this.detectButton.addEventListener('click', () => this.toggleLiveDetect());
    this.element = el('section', 'screen screen-camera', this.video, this.frameOverlay, back, shutter, this.detectButton);
    this.liveDetector = new LiveDetector(this.video, { onResult: (state) => this.onLiveResult(state) });

    const { signal } = this.listeners;
    const relayout = (): void => this.layout();
    window.addEventListener('resize', relayout, { signal });
    window.addEventListener('orientationchange', relayout, { signal });
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(relayout);
      this.observer.observe(this.element);
    }
    this.renderToggle();
  }

  /** The running camera session, null while closed. */
  get session(): CameraSession | null {
    return this.currentSession;
  }

  /** The static frame over the live video in track pixels, null while closed or unlaid. */
  get liveFrame(): UprightFrame | null {
    return this.frame;
  }

  /** Whether live detection (and the auto-bake on capture) is on. */
  get liveDetect(): boolean {
    return this.detectEnabled;
  }

  set liveDetect(value: boolean) {
    this.detectEnabled = value;
    this.syncLiveDetector(false);
    this.renderToggle();
    this.renderCameraFrame();
  }

  /** True while the outline is green: detection on and a document found. */
  get liveFound(): boolean {
    return this.detectEnabled && this.liveState.found;
  }

  /** Shows a started camera session on the screen and lays out the frame. */
  open(session: CameraSession): void {
    this.currentSession = session;
    this.layout();
  }

  /**
   * Computes the static DIN frame over the video (track pixels) and the cover
   * transform to the viewport, draws the overlay and keeps the live detection
   * in step with the frame. Hides the overlay while no session runs.
   */
  layout(): void {
    const session = this.currentSession;
    if (!session) {
      this.frameOverlay.setAttribute('hidden', '');
      return;
    }
    const viewW = this.element.clientWidth;
    const viewH = this.element.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    // Fit the frame into the part of the video the screen shows (object-fit: cover
    // crops the sides on tall phones), so the dashes are always fully visible.
    const visible = visibleImageRect(session.width, session.height, viewW, viewH);
    const frame = initialFrame(session.width, session.height, visible);
    const changed = !this.frame || !sameFrame(this.frame, frame);
    this.frame = frame;
    this.cover = coverTransform(session.width, session.height, viewW, viewH);
    this.frameOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    this.frameOverlay.removeAttribute('hidden');
    this.syncLiveDetector(changed);
    this.renderCameraFrame();
  }

  /** Stops the detection loop and the camera stream and hides the overlay. */
  close(): void {
    this.liveDetector.stop();
    this.liveState = { found: false, corners: null };
    if (this.currentSession) {
      stopCamera(this.currentSession);
      this.currentSession = null;
    }
    this.frame = null;
    this.cover = null;
    this.frameOverlay.setAttribute('hidden', '');
  }

  /** Releases the view for good: closes it and detaches the listeners. */
  dispose(): void {
    this.close();
    this.observer?.disconnect();
    this.observer = null;
    this.listeners.abort();
  }

  /** Draws the shade and the outline: the detected corners while found, else the static frame. */
  private renderCameraFrame(): void {
    const frame = this.frame;
    const cover = this.cover;
    if (!frame || !cover) return;
    const corners = this.detectEnabled && this.liveState.found ? this.liveState.corners : null;
    const found = corners !== null;
    const points: Point[] = (corners ?? frameCorners(frame)).map((p) => applyAffine(cover, p));
    const viewW = this.element.clientWidth;
    const viewH = this.element.clientHeight;
    const inner = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    this.framePolygon.setAttribute('points', inner);
    const outer = `M0 0H${viewW}V${viewH}H0Z`;
    const hole = `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z`;
    this.frameShade.setAttribute('d', outer + hole);
    this.frameOverlay.classList.toggle('found', found);
  }

  /** Starts, restarts or stops the live detection to match the session, the toggle and the frame. */
  private syncLiveDetector(frameChanged: boolean): void {
    const session = this.currentSession;
    const frame = this.frame;
    if (!session || !this.detectEnabled || !frame) {
      this.liveDetector.stop();
      this.liveState = { found: false, corners: null };
      return;
    }
    if (frameChanged || !this.liveDetector.running) {
      this.liveState = { found: false, corners: null };
      this.liveDetector.start(frame, session.width);
    }
  }

  private onLiveResult(state: TrackerState): void {
    const wasFound = this.liveState.found;
    this.liveState = state;
    if (state.found && !wasFound) vibrate(FOUND_VIBRATION_MS);
    this.renderCameraFrame();
  }

  private toggleLiveDetect(): void {
    this.liveDetect = !this.detectEnabled;
  }

  private renderToggle(): void {
    this.detectButton.setAttribute('aria-pressed', String(this.detectEnabled));
  }
}
