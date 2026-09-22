/**
 * Homography resampling for the shear bake (v0.7, see intent/v0.7-shear.md
 * "Confirm"): a JavaScript pixel loop with bilinear sampling, working in
 * strips of output rows so that only the source pixels and one strip are held
 * at a time. No WebGL: one code path, testable in Vitest, no texture limits.
 */

import type { Homography } from './geometry';
import { invertHomography, type WarpLayout } from './geometry';
import { createCanvas, releaseCanvas } from './canvas';

/** Output rows per strip: bounds the ImageData written at once. */
export const WARP_STRIP_ROWS = 256;

/** Pixels of a source image as read by `getImageData`. */
export interface PixelSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Fills `rows` output rows starting at `rowStart` of a `dstWidth` wide
 * output, sampling the source through `inverse` (output pixel centre ->
 * source pixel centre) with bilinear interpolation. Output pixels whose
 * source position lies outside the source stay white. `dst` must hold
 * `rows * dstWidth * 4` bytes and is written in full.
 */
export function warpRows(
  src: PixelSource,
  inverse: Homography,
  dst: Uint8ClampedArray,
  dstWidth: number,
  rowStart: number,
  rows: number,
): void {
  const { data, width: sw, height: sh } = src;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = inverse;
  const maxX = sw - 1;
  const maxY = sh - 1;
  let o = 0;
  for (let row = 0; row < rows; row += 1) {
    // Source position of the pixel centre, advanced incrementally along the row.
    const y = rowStart + row + 0.5;
    let px = h1 * y + h2 + 0.5 * h0;
    let py = h4 * y + h5 + 0.5 * h3;
    let pw = h7 * y + h8 + 0.5 * h6;
    for (let col = 0; col < dstWidth; col += 1) {
      let r = 255;
      let g = 255;
      let b = 255;
      if (pw > 1e-12) {
        // Back to pixel indices: the centre of source pixel (i, j) is (i + 0.5, j + 0.5).
        const sx = px / pw - 0.5;
        const sy = py / pw - 0.5;
        if (sx > -1 && sy > -1 && sx < sw && sy < sh) {
          let x0 = Math.floor(sx);
          let y0 = Math.floor(sy);
          const fx = sx - x0;
          const fy = sy - y0;
          let x1 = x0 + 1;
          let y1 = y0 + 1;
          // Clamp the taps at the border: the edge pixel extends half a pixel outward.
          if (x0 < 0) x0 = 0;
          if (y0 < 0) y0 = 0;
          if (x1 > maxX) x1 = maxX;
          if (y1 > maxY) y1 = maxY;
          const i00 = (y0 * sw + x0) * 4;
          const i10 = (y0 * sw + x1) * 4;
          const i01 = (y1 * sw + x0) * 4;
          const i11 = (y1 * sw + x1) * 4;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;
          r = data[i00]! * w00 + data[i10]! * w10 + data[i01]! * w01 + data[i11]! * w11;
          g = data[i00 + 1]! * w00 + data[i10 + 1]! * w10 + data[i01 + 1]! * w01 + data[i11 + 1]! * w11;
          b = data[i00 + 2]! * w00 + data[i10 + 2]! * w10 + data[i01 + 2]! * w01 + data[i11 + 2]! * w11;
        }
      }
      dst[o] = r;
      dst[o + 1] = g;
      dst[o + 2] = b;
      dst[o + 3] = 255;
      o += 4;
      px += h0;
      py += h3;
      pw += h6;
    }
  }
}

/**
 * Warps the whole source into a new canvas of the layout's size with white
 * fill wherever no source pixel lands. The source pixels are read once; if
 * the device cannot allocate that ImageData, the source is read at half
 * resolution instead and sampled through an adjusted homography (logged, not
 * shown). The source canvas is left untouched.
 */
export function warpImage(source: HTMLCanvasElement, layout: WarpLayout): HTMLCanvasElement {
  const { pixels, sourceScale } = readSource(source);
  // Output -> full-size source -> (possibly halved) source pixels.
  const toSource = invertHomography(layout.homography);
  const inverse: Homography =
    sourceScale === 1
      ? toSource
      : [
          toSource[0] * sourceScale,
          toSource[1] * sourceScale,
          toSource[2] * sourceScale,
          toSource[3] * sourceScale,
          toSource[4] * sourceScale,
          toSource[5] * sourceScale,
          toSource[6],
          toSource[7],
          toSource[8],
        ];
  const { canvas, ctx } = createCanvas(layout.width, layout.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += WARP_STRIP_ROWS) {
    const rows = Math.min(WARP_STRIP_ROWS, canvas.height - y);
    const strip = ctx.createImageData(canvas.width, rows);
    warpRows(pixels, inverse, strip.data, canvas.width, y, rows);
    ctx.putImageData(strip, 0, y);
  }
  return canvas;
}

/** Reads the source pixels, falling back to half resolution when the full read fails. */
function readSource(source: HTMLCanvasElement): { pixels: PixelSource; sourceScale: number } {
  const ctx = source.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }
  try {
    return { pixels: ctx.getImageData(0, 0, source.width, source.height), sourceScale: 1 };
  } catch (error) {
    console.warn('Reading the full image failed, warping at half resolution', error);
  }
  const scale = 0.5;
  const { canvas: half, ctx: halfCtx } = createCanvas(source.width * scale, source.height * scale);
  halfCtx.drawImage(source, 0, 0, half.width, half.height);
  try {
    const pixels = halfCtx.getImageData(0, 0, half.width, half.height);
    return { pixels, sourceScale: half.width / source.width };
  } finally {
    releaseCanvas(half);
  }
}
