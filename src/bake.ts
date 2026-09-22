/**
 * Bakes edits into the captured image on confirm: the frame rotation,
 * displaced corners (shear) and the tone chain (brightness, contrast,
 * temperature, grayscale). Cropping never touches pixels.
 */

import type { Capture, Frame } from './model';
import { bakeLayout, hasCornerOffsets, uprightFrame, warpLayout, withoutCorners } from './geometry';
import { createCanvas, releaseCanvas } from './canvas';
import { warpImage } from './warp';
import {
  applyTonePixels,
  isNeutralTone,
  toneFilter,
  toneLookups,
  toneUsesShorthandOnly,
  type Tone,
} from './tone';

/**
 * Returns a capture whose frame is upright. For angle 0 the image is reused
 * untouched. Otherwise the image is rotated about the frame centre, exposed
 * areas are filled white, the old canvas is released and the frame is
 * expressed in the new canvas with angle 0.
 */
export function bakeRotation(capture: Capture, frame: Frame): Capture {
  if (frame.angle === 0) {
    return { image: capture.image, frame: uprightFrame(frame) };
  }
  const { image } = capture;
  const layout = bakeLayout(image.width, image.height, frame);
  const { canvas, ctx } = createCanvas(layout.width, layout.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t = layout.transform;
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  ctx.drawImage(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  releaseCanvas(image);
  return { image: canvas, frame: layout.frame };
}

/**
 * Confirm of the crop/rotate view: a frame whose corners are displaced is
 * baked by warping the whole image so that the quadrilateral becomes the
 * upright target rectangle (rotation included, one resample). Otherwise the
 * plain rotation path (`bakeRotation`) runs. The result never carries corner offsets.
 */
export function bakeFrame(capture: Capture, frame: Frame): Capture {
  if (!hasCornerOffsets(frame)) {
    return bakeRotation(capture, withoutCorners(frame));
  }
  const { image } = capture;
  const layout = warpLayout(image.width, image.height, frame);
  const canvas = warpImage(image, layout);
  releaseCanvas(image);
  return { image: canvas, frame: layout.frame };
}

/** True when confirming `frame` changes pixels (rotation or displaced corners). */
export function frameNeedsBake(frame: Frame): boolean {
  return frame.angle !== 0 || hasCornerOffsets(frame);
}

/** Rows per strip in the pixel-loop fallback, bounding the ImageData held at once. */
const FALLBACK_STRIP_ROWS = 256;

function contextSupportsFilter(): boolean {
  return (
    typeof CanvasRenderingContext2D === 'function' &&
    'filter' in CanvasRenderingContext2D.prototype
  );
}

/**
 * Bakes brightness, contrast, temperature and grayscale into the whole
 * captured image, so that later cropping stays consistent.
 * Neutral values return the capture untouched. The frame is unchanged; the
 * old canvas is released.
 *
 * The 2D context filter is used when the chain consists of CSS shorthand
 * functions only; the temperature step needs an SVG filter reference, which
 * canvas contexts do not support everywhere, so it goes through the pixel loop.
 */
export function bakeTone(capture: Capture, tone: Tone): Capture {
  if (isNeutralTone(tone)) {
    return capture;
  }
  const { image, frame } = capture;
  const { canvas, ctx } = createCanvas(image.width, image.height);
  if (toneUsesShorthandOnly(tone) && contextSupportsFilter()) {
    ctx.filter = toneFilter(tone);
    ctx.drawImage(image, 0, 0);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(image, 0, 0);
    const luts = toneLookups(tone);
    for (let y = 0; y < canvas.height; y += FALLBACK_STRIP_ROWS) {
      const rows = Math.min(FALLBACK_STRIP_ROWS, canvas.height - y);
      const strip = ctx.getImageData(0, y, canvas.width, rows);
      applyTonePixels(strip.data, tone, luts);
      ctx.putImageData(strip, 0, y);
    }
  }
  releaseCanvas(image);
  return { image: canvas, frame };
}
