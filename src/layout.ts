/**
 * Layouts: how the captured image and its frame map onto the screen (cover and
 * letterbox transforms) and onto a new canvas when a bake resamples the image
 * (rotation and shear). Pure maths; the drawing happens elsewhere.
 */

import type { Frame, Point, UprightFrame } from './model';
import { EPSILON } from './angles';
import {
  applyAffine,
  distance,
  imageCorners,
  mapQuad,
  rotationAbout,
  scaleAffine,
  translateAffine,
  type Affine,
} from './affine';
import { applyHomography, homographyFromPoints, multiplyHomography, type Homography } from './homography';
import { boundsOf, frameCorners, quadCorners, scaleFrame, type Rect } from './frame';

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
 * The transform that `object-fit: cover; object-position: center` applies to
 * a source of the given size displayed in the given view: a uniform scale
 * (`a`, `d`) and a centring offset (`e`, `f`), source pixel -> view pixel.
 */
export function coverTransform(
  srcWidth: number,
  srcHeight: number,
  viewWidth: number,
  viewHeight: number,
): Affine {
  const scale = Math.max(viewWidth / srcWidth, viewHeight / srcHeight);
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: (viewWidth - srcWidth * scale) / 2,
    f: (viewHeight - srcHeight * scale) / 2,
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
  const scale = t.a;
  return {
    x: Math.max(0, -t.e / scale),
    y: Math.max(0, -t.f / scale),
    width: Math.min(srcWidth, viewWidth / scale),
    height: Math.min(srcHeight, viewHeight / scale),
  };
}

// ---- rotation baking ----------------------------------------------------------

/** Result of the rotation-baking layout (pure maths; the drawing happens elsewhere). */
export interface BakeLayout {
  /** Size of the new canvas. */
  width: number;
  height: number;
  /** Maps old image pixels to new canvas pixels (rotate by -angle about the frame centre, then shift). */
  transform: Affine;
  /** The frame in the new canvas: same size, angle 0. */
  frame: UprightFrame;
}

/**
 * Layout for baking the frame rotation into the image: rotate the image by
 * `-angle` about the frame centre, size the canvas to hold both the rotated
 * image and the (now upright) frame, and express the frame in the new canvas.
 * Exposed areas are white fill. For exact multiples of 90° with the frame
 * inside the image, the canvas is exactly the swapped image size and the
 * transform is an exact pixel copy.
 */
export function bakeLayout(
  imageWidth: number,
  imageHeight: number,
  frame: Frame,
  maxPixels = MAX_CAPTURE_PIXELS,
): BakeLayout {
  const pivot = { x: frame.cx, y: frame.cy };
  const rotate = rotationAbout(-frame.angle, pivot);
  const rotatedImage = mapQuad(imageCorners(imageWidth, imageHeight), (p) => applyAffine(rotate, p));
  const upright: Frame = { ...frame, angle: 0 };
  const box = boundsOf([...rotatedImage, ...frameCorners(upright)]);
  // Snap to whole pixels: expand outward so nothing is clipped.
  const minX = Math.floor(box.x + EPSILON);
  const minY = Math.floor(box.y + EPSILON);
  const maxX = Math.ceil(box.x + box.width - EPSILON);
  const maxY = Math.ceil(box.y + box.height - EPSILON);
  let width = Math.max(1, maxX - minX);
  let height = Math.max(1, maxY - minY);
  let transform = rotationAbout(-frame.angle, pivot, -minX, -minY);
  let baked: UprightFrame = { cx: frame.cx - minX, cy: frame.cy - minY, width: frame.width, height: frame.height, angle: 0 };
  // The layout only handles the rectangle; displaced corners take `warpLayout`.
  if (width * height > maxPixels) {
    // A skewed image's bounding box can exceed the canvas pixel cap (iOS):
    // scale the whole result down uniformly.
    const scale = Math.sqrt(maxPixels / (width * height));
    const size = captureSize(width, height, maxPixels);
    width = size.width;
    height = size.height;
    transform = scaleAffine(transform, scale);
    baked = scaleFrame(baked, scale);
  }
  return { width, height, transform, frame: baked };
}

/**
 * The display transform of the crop/rotate view: the image turned by `-base`
 * (a multiple of 90°, so 90° taps are visible) and letterboxed into the view.
 * Image point -> CSS pixel.
 */
export function viewTransform(
  imageWidth: number,
  imageHeight: number,
  base: number,
  viewWidth: number,
  viewHeight: number,
): Affine {
  const rotate = rotationAbout(-base, { x: imageWidth / 2, y: imageHeight / 2 });
  const corners = mapQuad(imageCorners(imageWidth, imageHeight), (p) => applyAffine(rotate, p));
  const box = boundsOf(corners);
  const scale = Math.min(viewWidth / box.width, viewHeight / box.height);
  const offsetX = (viewWidth - box.width * scale) / 2 - box.x * scale;
  const offsetY = (viewHeight - box.height * scale) / 2 - box.y * scale;
  return translateAffine(scaleAffine(rotate, scale), offsetX, offsetY);
}

// ---- the shear bake layout ----------------------------------------------------

/** Output margin around the target rectangle, as a fraction of its size per side. */
export const WARP_MARGIN = 0.25;

/** Result of the shear-baking layout (pure maths; the resampling happens in `warp.ts`). */
export interface WarpLayout {
  /** Size of the new canvas. */
  width: number;
  height: number;
  /** Maps old image pixels to new canvas pixels. */
  homography: Homography;
  /** The frame in the new canvas: the upright target rectangle, angle 0, no offsets. */
  frame: UprightFrame;
}

/**
 * Layout for baking displaced corners (and any rotation) into the image: the
 * homography that maps the frame's quadrilateral onto an upright rectangle
 * whose sides are the mean lengths of the opposite quadrilateral edges, so the
 * pixel density stays close to the source's. The canvas covers the warped
 * image, clipped to the target rectangle enlarged by 25 % of its size on each
 * side (strong perspective sends the far image corners towards infinity), and
 * always the target rectangle itself. Above the pixel cap the whole result is
 * scaled down uniformly.
 */
export function warpLayout(
  imageWidth: number,
  imageHeight: number,
  frame: Frame,
  maxPixels = MAX_CAPTURE_PIXELS,
): WarpLayout {
  const quad = quadCorners(frame);
  const [nw, ne, se, sw] = quad;
  const width = (distance(nw, ne) + distance(sw, se)) / 2;
  const height = (distance(nw, sw) + distance(ne, se)) / 2;
  const target = imageCorners(width, height);
  const h = homographyFromPoints(quad, target);

  // Bounding box of the warped image, or unbounded where a corner crosses the
  // horizon (its projective w drops to zero or below).
  let box: Rect | null = null;
  const mapped: Point[] = [];
  let bounded = true;
  for (const p of imageCorners(imageWidth, imageHeight)) {
    const w = h[6] * p.x + h[7] * p.y + h[8];
    if (w <= 1e-9) {
      bounded = false;
      break;
    }
    mapped.push(applyHomography(h, p));
  }
  if (bounded) box = boundsOf(mapped);
  const clip: Rect = {
    x: -WARP_MARGIN * width,
    y: -WARP_MARGIN * height,
    width: (1 + 2 * WARP_MARGIN) * width,
    height: (1 + 2 * WARP_MARGIN) * height,
  };
  let minX = clip.x;
  let minY = clip.y;
  let maxX = clip.x + clip.width;
  let maxY = clip.y + clip.height;
  if (box) {
    minX = Math.max(minX, box.x);
    minY = Math.max(minY, box.y);
    maxX = Math.min(maxX, box.x + box.width);
    maxY = Math.min(maxY, box.y + box.height);
  }
  // The target rectangle is always inside the canvas, even where the
  // quadrilateral stuck out of the image (that area is white fill).
  minX = Math.floor(Math.min(minX, 0) + EPSILON);
  minY = Math.floor(Math.min(minY, 0) + EPSILON);
  maxX = Math.ceil(Math.max(maxX, width) - EPSILON);
  maxY = Math.ceil(Math.max(maxY, height) - EPSILON);

  let canvasWidth = Math.max(1, maxX - minX);
  let canvasHeight = Math.max(1, maxY - minY);
  let scale = 1;
  if (canvasWidth * canvasHeight > maxPixels) {
    scale = Math.sqrt(maxPixels / (canvasWidth * canvasHeight));
    const size = captureSize(canvasWidth, canvasHeight, maxPixels);
    canvasWidth = size.width;
    canvasHeight = size.height;
  }
  const shift: Homography = [scale, 0, -minX * scale, 0, scale, -minY * scale, 0, 0, 1];
  return {
    width: canvasWidth,
    height: canvasHeight,
    homography: multiplyHomography(shift, h),
    frame: {
      cx: (width / 2 - minX) * scale,
      cy: (height / 2 - minY) * scale,
      width: width * scale,
      height: height * scale,
      angle: 0,
    },
  };
}
