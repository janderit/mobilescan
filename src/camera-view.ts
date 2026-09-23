/**
 * Camera screen: the live video, the frame overlay (shade with a hole and the
 * dashed outline, which is the static DIN rectangle or, with a document found,
 * its corners), back, shutter and the live-detect toggle. Owns the
 * camera session while open and the `LiveDetector` loop. When the outline
 * turns green the view grabs a still at once (`frozen`) and keeps it for
 * `FROZEN_STILL_MS`, so that a shutter pressed in reaction to the green
 * outline gets the steady picture from before the press moved the phone
 * (v0.12). The capture itself (`takePhoto`) stays in the app shell, which
 * reads `liveFrame` and `liveFound` at the shutter and takes the still
 * through `takeStill`.
 */

import * as icons from './icons';
import type { Point, UprightFrame } from './model';
import { iconButton, switchButton, el, prefersReducedMotion } from './ui';
import { applyAffine, coverTransform, frameCorners, initialFrame, visibleImageRect, type Affine } from './geometry';
import { captureStill, stopCamera, type CameraSession } from './camera';
import { releaseCanvas } from './canvas';
import { AGREE_FRACTION, quadsAgree, type TrackerState } from './detect';
import type { Quad } from './geometry';
import { LiveDetector } from './live-detect';
import { FrameOverlay } from './frame-overlay';

/** Vibration when the live outline turns green (the shutter uses 30 ms). */
const FOUND_VIBRATION_MS = 15;
/**
 * How long the still grabbed when the outline turned green stays usable:
 * reaction to the buzz plus the press take about half a second, and holding
 * the still longer only costs memory (one full capture canvas).
 */
export const FROZEN_STILL_MS = 600;

/** The still grabbed at the moment the outline turned green. */
interface FrozenStill {
  image: HTMLCanvasElement;
  /** The tracker's corners at that moment, in track pixels. */
  corners: Quad;
  /** `performance.now()` of the grab. */
  at: number;
}

/** Haptic feedback where supported; silent under reduced motion. */
export function vibrate(ms: number): void {
  if (prefersReducedMotion() || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(ms);
  } catch {
    // Not permitted; feedback is optional.
  }
}

function sameFrame(a: UprightFrame, b: UprightFrame): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.width === b.width && a.height === b.height;
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

  private readonly frameOverlay: FrameOverlay;
  private readonly detectButton: HTMLButtonElement;
  private readonly liveDetector: LiveDetector;
  private liveState: TrackerState = { found: false, corners: null };
  /** Live document detection and auto-bake on capture; session state only. */
  private detectEnabled = true;

  private currentSession: CameraSession | null = null;
  private frozen: FrozenStill | null = null;
  private frozenTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.frameOverlay = new FrameOverlay({
      svgClass: 'camera-frame',
      shadeClass: 'camera-shade',
      outlineClass: 'camera-outline',
    });
    this.frameOverlay.visible = false;
    const back = iconButton(icons.arrowLeft, 'Zurück', 'camera-back');
    back.addEventListener('click', () => callbacks.onBack());
    const shutter = iconButton(icons.shutter, 'Foto aufnehmen', 'camera-shutter');
    // The still is grabbed on the press, not the release: the finger moves the
    // phone most on the way down. The click that follows finds the session
    // closed and does nothing; keyboard activation still arrives as a click.
    shutter.addEventListener('pointerdown', (event) => {
      if (event.button === 0) callbacks.onShutter();
    });
    shutter.addEventListener('click', () => callbacks.onShutter());
    // A switch, not a button: a green wand button read as "press for magic" on the device (v0.12).
    this.detectButton = switchButton(icons.magicWand, 'Dokument automatisch erkennen', 'camera-detect');
    this.detectButton.addEventListener('click', () => this.toggleLiveDetect());
    this.element = el('section', 'screen screen-camera', this.video, this.frameOverlay.element, back, shutter, this.detectButton);
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

  /**
   * The still for the shutter: the frozen one when it is young enough, the
   * outline is still green and the document has not moved since (each corner
   * within `AGREE_FRACTION` of the frame width), else a fresh grab from the
   * video. Either way the frozen still is given up. Throws when the grab fails.
   */
  takeStill(): HTMLCanvasElement {
    const session = this.currentSession;
    if (!session) throw new Error('Keine Kamera');
    const frozen = this.frozen;
    const frame = this.frame;
    const corners = this.liveFound ? this.liveState.corners : null;
    if (
      frozen &&
      frame &&
      corners &&
      performance.now() - frozen.at <= FROZEN_STILL_MS &&
      quadsAgree(corners, frozen.corners, AGREE_FRACTION * frame.width)
    ) {
      this.frozen = null;
      this.clearFrozenTimer();
      return frozen.image;
    }
    this.releaseFrozen();
    return captureStill(session);
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
      this.frameOverlay.visible = false;
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
    this.frameOverlay.setViewBox(viewW, viewH);
    this.frameOverlay.visible = true;
    this.syncLiveDetector(changed);
    this.renderCameraFrame();
  }

  /** Stops the detection loop and the camera stream and hides the overlay. */
  close(): void {
    this.liveDetector.stop();
    this.releaseFrozen();
    this.liveState = { found: false, corners: null };
    if (this.currentSession) {
      stopCamera(this.currentSession);
      this.currentSession = null;
    }
    this.frame = null;
    this.cover = null;
    this.frameOverlay.visible = false;
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
    this.frameOverlay.render(points);
    this.frameOverlay.element.classList.toggle('found', found);
  }

  /** Starts, restarts or stops the live detection to match the session, the toggle and the frame. */
  private syncLiveDetector(frameChanged: boolean): void {
    const session = this.currentSession;
    const frame = this.frame;
    if (!session || !this.detectEnabled || !frame) {
      this.liveDetector.stop();
      this.releaseFrozen();
      this.liveState = { found: false, corners: null };
      return;
    }
    if (frameChanged || !this.liveDetector.running) {
      this.releaseFrozen();
      this.liveState = { found: false, corners: null };
      this.liveDetector.start(frame, session.width);
    }
  }

  private onLiveResult(state: TrackerState): void {
    const wasFound = this.liveState.found;
    this.liveState = state;
    if (state.found && !wasFound) {
      vibrate(FOUND_VIBRATION_MS);
      this.freezeStill(state.corners);
    } else if (!state.found) {
      this.releaseFrozen();
    }
    this.renderCameraFrame();
  }

  /** Grabs the still of the moment the outline turned green; a failed grab leaves none. */
  private freezeStill(corners: Quad | null): void {
    this.releaseFrozen();
    const session = this.currentSession;
    if (!session || !corners) return;
    try {
      this.frozen = { image: captureStill(session), corners, at: performance.now() };
    } catch (error) {
      console.error('Standbild fehlgeschlagen', error);
      return;
    }
    this.frozenTimer = setTimeout(() => this.releaseFrozen(), FROZEN_STILL_MS);
  }

  private releaseFrozen(): void {
    this.clearFrozenTimer();
    if (this.frozen) releaseCanvas(this.frozen.image);
    this.frozen = null;
  }

  private clearFrozenTimer(): void {
    if (this.frozenTimer !== null) clearTimeout(this.frozenTimer);
    this.frozenTimer = null;
  }

  private toggleLiveDetect(): void {
    this.liveDetect = !this.detectEnabled;
  }

  private renderToggle(): void {
    this.detectButton.setAttribute('aria-checked', String(this.detectEnabled));
  }
}
