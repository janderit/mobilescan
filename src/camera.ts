/**
 * Rear camera stream: start, stop and grab a still into a canvas, and the
 * lens switch of v1.2 (`probeLenses`): the wide-angle lens is a zoom range
 * below 1 on the logical rear camera (Chrome on Android) or a second video
 * input device (Safari on iOS); where neither exists there is no control.
 * No image data is kept here beyond the returned canvas.
 */

import { captureSize } from './geometry';
import { createCanvas } from './canvas';

export interface CameraSession {
  stream: MediaStream;
  video: HTMLVideoElement;
  /** Native frame size of the stream in pixels, as drawImage sees it. */
  width: number;
  height: number;
}

const IDEAL_SIZE = { width: { ideal: 4096 }, height: { ideal: 4096 } };

/** The default rear camera, or one device by id (the lens switch). */
function constraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId }, ...IDEAL_SIZE } : { facingMode: { ideal: 'environment' }, ...IDEAL_SIZE };
  return { video, audio: false };
}

/** Resolves once the video element reports its intrinsic size. */
function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

/**
 * Requests the rear camera (or the given device) and attaches it to the video
 * element. Rejects when the camera is unavailable or permission is denied.
 */
export async function startCamera(video: HTMLVideoElement, deviceId?: string): Promise<CameraSession> {
  if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new DOMException('Camera needs a secure context', 'SecurityError');
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  video.srcObject = stream;
  try {
    await video.play();
  } catch (error) {
    // autoplay + muted normally allows play(); log but continue, the metadata wait covers it
    console.error('video.play() failed', error);
  }
  await waitForMetadata(video);

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  let width = settings.width ?? video.videoWidth;
  let height = settings.height ?? video.videoHeight;
  // drawImage uses the element's intrinsic size; if the track settings disagree
  // (some browsers report the sensor size in landscape), trust the element.
  if (video.videoWidth > 0 && (width !== video.videoWidth || height !== video.videoHeight)) {
    width = video.videoWidth;
    height = video.videoHeight;
  }
  return { stream, video, width, height };
}

/** Why the camera could not be started; the error screen labels itself with it. */
export type CameraErrorKind = 'denied' | 'unavailable' | 'insecure';

export function cameraErrorKind(error: unknown): CameraErrorKind {
  // Duck-typed: DOMException may come from another realm than Error.
  const name =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  switch (name) {
    case 'SecurityError':
      return 'insecure';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied';
    default:
      return 'unavailable';
  }
}

/** Stops all tracks and detaches the stream from the video element. */
export function stopCamera(session: CameraSession): void {
  for (const track of session.stream.getTracks()) {
    track.stop();
  }
  session.video.srcObject = null;
}

/**
 * Draws the current video frame into a new canvas, downscaled if the stream
 * exceeds the canvas pixel cap (iOS). The caller owns the canvas.
 */
export function captureStill(session: CameraSession): HTMLCanvasElement {
  const size = captureSize(session.width, session.height);
  const { canvas, ctx } = createCanvas(size.width, size.height);
  ctx.drawImage(session.video, 0, 0, size.width, size.height);
  return canvas;
}

// ---- lens switch (v1.2) ----------------------------------------------------

export type Lens = 'default' | 'wide';

/**
 * Switches the running camera between the default and the wide-angle lens.
 * `select` resolves with the session to show afterwards (the same one when
 * the lens is a zoom value, a new one when it is another device) and rejects
 * with a `LensSwitchError` whose `fallback` is the session that still runs,
 * or null when the camera is gone.
 */
export interface LensControl {
  /** Which mechanism the wide lens is reached through (diagnostics and tests). */
  readonly kind: 'zoom' | 'device';
  select(lens: Lens): Promise<CameraSession>;
}

export class LensSwitchError extends Error {
  constructor(
    message: string,
    readonly fallback: CameraSession | null,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'LensSwitchError';
  }
}

/** The environment the probe reads; injectable for tests. */
export interface LensEnvironment {
  enumerateDevices: (() => Promise<MediaDeviceInfo[]>) | undefined;
  start: (video: HTMLVideoElement, deviceId?: string) => Promise<CameraSession>;
  /** Pause between start attempts; tests pass one that returns at once. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Chrome on Android may refuse a camera for a moment after another one was
 * stopped ("Could not start video source", NotReadableError); a device switch
 * therefore tries again a few times before it counts as failed.
 */
export const START_ATTEMPTS = 4;
export const START_RETRY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Errors that a retry cannot help with. */
function isFinalStartError(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? (error as { name: unknown }).name : '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError' || name === 'OverconstrainedError';
}

/** Starts a camera with `START_ATTEMPTS` tries, pausing `START_RETRY_MS` between them. */
async function startWithRetry(env: LensEnvironment, video: HTMLVideoElement, deviceId?: string): Promise<CameraSession> {
  const wait = env.wait ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    try {
      return await env.start(video, deviceId);
    } catch (error) {
      lastError = error;
      if (isFinalStartError(error) || attempt === START_ATTEMPTS) break;
      console.error(`Kamerastart fehlgeschlagen (Versuch ${attempt})`, error);
      await wait(START_RETRY_MS);
    }
  }
  throw lastError;
}

/** Zoom and focus are not in the DOM lib's track types yet. */
interface ZoomCapabilities {
  zoom?: { min?: number; max?: number };
  focusMode?: string[];
}
interface ZoomSettings {
  zoom?: number;
}

/**
 * Words the browsers' localised labels of the ultra-wide rear camera share
 * (English, German, French, Spanish, Italian, Portuguese, Dutch); Safari on
 * iOS names the lens this way, so such a device is the wide lens outright.
 */
const WIDE_LABEL_WORDS = ['ultra'];
/**
 * Chrome on Android labels cameras "camera N, facing back" and says nothing
 * about the lens; every other rear device is a candidate that has to be
 * opened once to be told apart (`isFixedFocus`).
 */
const REAR_LABEL_WORDS = ['facing back'];

function labelHas(label: string, words: string[]): boolean {
  const lower = label.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function videoTrack(session: CameraSession): MediaStreamTrack | null {
  const tracks = typeof session.stream.getVideoTracks === 'function' ? session.stream.getVideoTracks() : [];
  return tracks[0] ?? null;
}

function capabilitiesOf(track: MediaStreamTrack | null): MediaTrackCapabilities & ZoomCapabilities {
  return track && typeof track.getCapabilities === 'function' ? (track.getCapabilities() as MediaTrackCapabilities & ZoomCapabilities) : {};
}

function settingsOf(track: MediaStreamTrack | null): MediaTrackSettings & ZoomSettings {
  return track && typeof track.getSettings === 'function' ? (track.getSettings() as MediaTrackSettings & ZoomSettings) : {};
}

/**
 * Whether an opened rear camera is the ultra-wide: on Android phones the
 * ultra-wide is the fixed-focus lens (no continuous or single-shot autofocus
 * in its capabilities), while the main and telephoto lenses focus (Samsung
 * S22: camera 2 offers `focusMode: ["manual"]` only, camera 0 also
 * continuous). Unknown focus modes count as focusing, so nothing is claimed.
 */
export function isFixedFocus(capabilities: MediaTrackCapabilities & ZoomCapabilities): boolean {
  const modes = capabilities.focusMode;
  if (!Array.isArray(modes) || modes.length === 0) return false;
  return !modes.some((mode) => mode === 'continuous' || mode === 'single-shot');
}

function browserLensEnvironment(): LensEnvironment {
  const devices = navigator.mediaDevices;
  return {
    enumerateDevices: typeof devices?.enumerateDevices === 'function' ? () => devices.enumerateDevices() : undefined,
    start: startCamera,
  };
}

/** The wide lens as a zoom value below 1 on the running track (no restart). */
class ZoomLensControl implements LensControl {
  readonly kind = 'zoom';

  constructor(
    private readonly session: CameraSession,
    private readonly track: MediaStreamTrack,
    private readonly wideZoom: number,
    private readonly defaultZoom: number,
  ) {}

  async select(lens: Lens): Promise<CameraSession> {
    const zoom = lens === 'wide' ? this.wideZoom : this.defaultZoom;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
    } catch (error) {
      throw new LensSwitchError('Zoom nicht übernommen', this.session, error);
    }
    return this.session;
  }
}

/**
 * The wide lens as another video input device: stop the current stream, start
 * the other one. `wideDeviceId` is known from the label (iOS); otherwise the
 * `candidates` (Chrome's other rear cameras) are opened in turn on the first
 * wide select until one is fixed-focus, which is then remembered. No
 * candidate qualifying: the default comes back and the control remembers
 * that there is no wide lens, so later selects fail at once without a swap.
 */
class DeviceLensControl implements LensControl {
  readonly kind = 'device';
  private wideDeviceId: string | null;
  private candidates: string[];

  constructor(
    private current: CameraSession,
    wideDeviceId: string | null,
    candidates: string[],
    private readonly env: LensEnvironment,
  ) {
    this.wideDeviceId = wideDeviceId;
    this.candidates = candidates;
  }

  private start(video: HTMLVideoElement, deviceId?: string): Promise<CameraSession> {
    return startWithRetry(this.env, video, deviceId);
  }

  async select(lens: Lens): Promise<CameraSession> {
    if (lens === 'default') return this.open(undefined);
    if (this.wideDeviceId) return this.open(this.wideDeviceId);
    if (this.candidates.length === 0) {
      throw new LensSwitchError('Kein Weitwinkel gefunden', this.current, null);
    }
    // Trial: open each candidate once and look at its focus capabilities.
    const { video } = this.current;
    stopCamera(this.current);
    let lastError: unknown = null;
    for (const id of this.candidates) {
      try {
        const session = await this.start(video, id);
        if (isFixedFocus(capabilitiesOf(videoTrack(session)))) {
          this.wideDeviceId = id;
          this.current = session;
          return session;
        }
        stopCamera(session);
      } catch (error) {
        lastError = error;
        console.error('Kandidat nicht geöffnet', error);
      }
    }
    this.candidates = [];
    throw new LensSwitchError('Kein Weitwinkel gefunden', await this.restoreDefault(video), lastError);
  }

  /** Stops the current stream and starts a device (or the default); a failed wide device brings the default back. */
  private async open(deviceId: string | undefined): Promise<CameraSession> {
    const { video } = this.current;
    stopCamera(this.current);
    try {
      this.current = await this.start(video, deviceId);
      return this.current;
    } catch (error) {
      const fallback = deviceId ? await this.restoreDefault(video) : null;
      throw new LensSwitchError('Objektiv nicht verfügbar', fallback, error);
    }
  }

  private async restoreDefault(video: HTMLVideoElement): Promise<CameraSession | null> {
    try {
      this.current = await this.start(video);
      return this.current;
    } catch (error) {
      console.error('Kamera nach Objektivwechsel nicht neu gestartet', error);
      return null;
    }
  }
}

/**
 * Looks for a wide-angle lens next to the running session: the zoom range
 * first (no restart), then a second rear device. Resolves null when the
 * browser offers neither; never rejects.
 */
export async function probeLenses(session: CameraSession, env: LensEnvironment = browserLensEnvironment()): Promise<LensControl | null> {
  const track = videoTrack(session);
  if (!track) return null;
  try {
    const capabilities = capabilitiesOf(track);
    const min = capabilities.zoom?.min;
    if (typeof min === 'number' && min > 0 && min < 1) {
      return new ZoomLensControl(session, track, min, settingsOf(track).zoom ?? 1);
    }
    if (!env.enumerateDevices) return null;
    const currentId = settingsOf(track).deviceId;
    const others = (await env.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId !== currentId && d.deviceId !== '');
    const wide = others.find((d) => labelHas(d.label, WIDE_LABEL_WORDS));
    const candidates = wide ? [] : others.filter((d) => labelHas(d.label, REAR_LABEL_WORDS)).map((d) => d.deviceId);
    if (!wide && candidates.length === 0) return null;
    return new DeviceLensControl(session, wide?.deviceId ?? null, candidates, env);
  } catch (error) {
    console.error('Objektive nicht ermittelt', error);
    return null;
  }
}
