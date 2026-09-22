/**
 * Pure geometry for the capture frame (see intent/v0.1-mvp.md "Data model").
 * No DOM access: everything here is plain number maths so it can be unit tested.
 */

import type { Frame } from './model';

/** Aspect ratio of the DIN A formats: height = width * SQRT2 in portrait. */
export const SQRT2 = Math.SQRT2;

/** Axis-aligned rectangle, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fraction of the captured image the initial frame occupies. */
const FRAME_FILL = 0.9;

/**
 * Initial DIN A frame for a freshly captured image:
 * 90 % of the image width, 1:sqrt2 portrait, reduced proportionally so that it
 * also stays within 90 % of the image height. Centred, unrotated.
 *
 * With `visible` (the part of the image the screen actually shows, see
 * `visibleImageRect`), the frame is fitted into that region instead, so the
 * dashes are always fully on screen. The margin outside the frame is then
 * whatever the capture holds beyond the screen, which is at least 10 %.
 */
export function initialFrame(imageWidth: number, imageHeight: number, visible?: Rect): Frame {
  const region: Rect = visible ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
  let width = FRAME_FILL * region.width;
  let height = width * SQRT2;
  const maxHeight = FRAME_FILL * region.height;
  if (height > maxHeight) {
    height = maxHeight;
    width = height / SQRT2;
  }
  return {
    cx: region.x + region.width / 2,
    cy: region.y + region.height / 2,
    width,
    height,
    angle: 0,
  };
}

/** Scales a frame from one image size to another (e.g. track size -> capture canvas size). */
export function scaleFrame(frame: Frame, factor: number): Frame {
  return {
    cx: frame.cx * factor,
    cy: frame.cy * factor,
    width: frame.width * factor,
    height: frame.height * factor,
    angle: frame.angle,
  };
}

/** iOS Safari caps canvases at roughly 16.7 M pixels; stay below that. */
export const MAX_CAPTURE_PIXELS = 16_000_000;

/**
 * Size of the capture canvas for a video track: the track's own size when it
 * fits under the canvas pixel cap, otherwise uniformly scaled down.
 */
export function captureSize(
  trackWidth: number,
  trackHeight: number,
  maxPixels = MAX_CAPTURE_PIXELS,
): { width: number; height: number } {
  const pixels = trackWidth * trackHeight;
  if (pixels <= maxPixels) {
    return { width: trackWidth, height: trackHeight };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  let width = Math.floor(trackWidth * scale);
  let height = Math.floor(trackHeight * scale);
  // Flooring can only shrink, but guard against rounding leaving us over the cap.
  while (width * height > maxPixels && (width > 1 || height > 1)) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * The transform that `object-fit: cover; object-position: center` applies.
 * A source point p maps to the view as `p * scale + offset`.
 */
export interface CoverTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Cover transform of a source of the given size displayed in the given view. */
export function coverTransform(
  srcWidth: number,
  srcHeight: number,
  viewWidth: number,
  viewHeight: number,
): CoverTransform {
  const scale = Math.max(viewWidth / srcWidth, viewHeight / srcHeight);
  return {
    scale,
    offsetX: (viewWidth - srcWidth * scale) / 2,
    offsetY: (viewHeight - srcHeight * scale) / 2,
  };
}

/**
 * The part of the source that is visible in the view under a cover transform,
 * in source coordinates (clipped to the source bounds).
 */
export function visibleImageRect(
  srcWidth: number,
  srcHeight: number,
  viewWidth: number,
  viewHeight: number,
): Rect {
  const t = coverTransform(srcWidth, srcHeight, viewWidth, viewHeight);
  const x = Math.max(0, -t.offsetX / t.scale);
  const y = Math.max(0, -t.offsetY / t.scale);
  return {
    x,
    y,
    width: Math.min(srcWidth, viewWidth / t.scale),
    height: Math.min(srcHeight, viewHeight / t.scale),
  };
}

/**
 * The frame as an axis-aligned rectangle in view coordinates.
 * `angle` is 0 in v0.1 and therefore ignored here.
 */
export function frameToViewRect(frame: Frame, t: CoverTransform): Rect {
  const width = frame.width * t.scale;
  const height = frame.height * t.scale;
  return {
    x: frame.cx * t.scale + t.offsetX - width / 2,
    y: frame.cy * t.scale + t.offsetY - height / 2,
    width,
    height,
  };
}

/**
 * The frame as a source rectangle for `drawImage`, in image pixels.
 * `angle` is 0 in v0.1 and therefore ignored here.
 */
export function frameSourceRect(frame: Frame): Rect {
  return {
    x: frame.cx - frame.width / 2,
    y: frame.cy - frame.height / 2,
    width: frame.width,
    height: frame.height,
  };
}
