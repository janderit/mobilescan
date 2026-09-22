/** Canvas helpers shared by the views, the bake and the page store. */

import { applyAffine, imageCorners, invertAffine, mapQuad, type Affine, type Rect } from './geometry';

/** A blank canvas of the given size with its 2D context. */
export function createCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }
  return { canvas, ctx };
}

/** Encodes a canvas as a JPEG blob at the given quality. */
export function encodeJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('JPEG encoding failed'));
      },
      'image/jpeg',
      quality,
    );
  });
}

/** Releases the pixel buffer of a canvas. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * A canvas kept between `sampleImage` calls (the live detection renders a
 * working copy several times a second): resized only when the requested size
 * differs, cleared before every draw, released with `release()`.
 */
export class WorkingCanvas {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  /** The canvas at `width` x `height`, cleared to transparent. */
  acquire(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!this.canvas || !this.ctx) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        this.canvas = null;
        throw new Error('2d context unavailable');
      }
      this.ctx = ctx;
    } else if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    return { canvas: this.canvas, ctx: this.ctx };
  }

  /** Releases the pixel buffer; the next `acquire` starts afresh. */
  release(): void {
    if (this.canvas) releaseCanvas(this.canvas);
    this.canvas = null;
    this.ctx = null;
  }
}

/**
 * Renders `image` through `transform` (image pixel -> output pixel) into a
 * canvas of the given size and returns its pixels. Areas the image does not
 * cover stay transparent. Used for the auto-detect working copies. Without
 * `into` a temporary canvas is used and released afterwards; with a
 * `WorkingCanvas` its canvas is reused across calls.
 */
export function sampleImage(
  image: CanvasImageSource,
  transform: Affine,
  width: number,
  height: number,
  into?: WorkingCanvas,
): ImageData {
  const { canvas, ctx } = into ? into.acquire(width, height) : createCanvas(width, height);
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const t = transform;
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    ctx.drawImage(image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    if (!into) releaseCanvas(canvas);
  }
}

/** Cap for a display canvas backing store (device pixels per CSS pixel). */
export const MAX_DPR = 2;

/**
 * One image pixel is never stretched beyond this many device pixels: past it
 * a zoomed stage or a loupe shows blur, not detail.
 */
export const MAX_DEVICE_PIXELS_PER_IMAGE_PIXEL = 2;

/** The device pixel ratio the display canvases use. */
export function displayDpr(): number {
  return Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
}

/**
 * Sizes a display canvas to `width` x `height` CSS pixels at `dpr`, keeping
 * the backing store when it already has that size. Returns true when it was
 * resized (and therefore cleared).
 */
export function sizeDisplayCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): boolean {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/**
 * Draws the part of `image` that lands inside a stage of `width` x `height`
 * CSS pixels through `transform` (image pixel -> CSS pixel), at `dpr` device
 * pixels per CSS pixel. Only the visible source rectangle (optionally
 * limited further to `clip`, in image pixels) is handed to `drawImage`, so
 * the cost follows the stage size, not the zoom level.
 */
export function drawImageThrough(
  ctx: CanvasRenderingContext2D,
  image: HTMLCanvasElement,
  transform: Affine,
  width: number,
  height: number,
  dpr: number,
  clip?: Rect,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Visible image region: the stage corners mapped back into image pixels.
  const t = transform;
  if (!(t.a * t.d - t.b * t.c)) return;
  const back = invertAffine(t);
  const corners = mapQuad(imageCorners(width, height), (p) => applyAffine(back, p));
  const x0 = Math.max(0, clip?.x ?? 0, Math.floor(Math.min(...corners.map((p) => p.x))) - 1);
  const y0 = Math.max(0, clip?.y ?? 0, Math.floor(Math.min(...corners.map((p) => p.y))) - 1);
  const x1 = Math.min(image.width, clip ? clip.x + clip.width : Infinity, Math.ceil(Math.max(...corners.map((p) => p.x))) + 1);
  const y1 = Math.min(image.height, clip ? clip.y + clip.height : Infinity, Math.ceil(Math.max(...corners.map((p) => p.y))) + 1);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.setTransform(t.a * dpr, t.b * dpr, t.c * dpr, t.d * dpr, t.e * dpr, t.f * dpr);
  ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
