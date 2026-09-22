/**
 * Rear camera stream: start, stop and grab a still into a canvas.
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

const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 4096 },
    height: { ideal: 4096 },
  },
  audio: false,
};

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
 * Requests the rear camera and attaches it to the given video element.
 * Rejects when the camera is unavailable or permission is denied.
 */
export async function startCamera(video: HTMLVideoElement): Promise<CameraSession> {
  if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new DOMException('Camera needs a secure context', 'SecurityError');
  }
  const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
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
