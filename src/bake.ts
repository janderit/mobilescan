/**
 * Bakes the frame rotation into the captured image (v0.2 confirm).
 * Cropping never touches pixels; only a non-zero angle gets here.
 */

import type { Capture, Frame } from './model';
import { bakeLayout } from './geometry';
import { releaseCanvas } from './share';

/**
 * Returns a capture whose frame is upright. For angle 0 the image is reused
 * untouched. Otherwise the image is rotated about the frame centre, exposed
 * areas are filled white, the old canvas is released and the frame is
 * expressed in the new canvas with angle 0.
 */
export function bakeRotation(capture: Capture, frame: Frame): Capture {
  if (frame.angle === 0) {
    return { image: capture.image, frame };
  }
  const { image } = capture;
  const layout = bakeLayout(image.width, image.height, frame);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t = layout.transform;
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  ctx.drawImage(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  releaseCanvas(image);
  return { image: canvas, frame: layout.frame };
}
