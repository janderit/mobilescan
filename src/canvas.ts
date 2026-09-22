/** Canvas helpers shared by the views, the bake and the page store. */

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

/** Releases the pixel buffer of a canvas. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Renders `image` through `transform` (image pixel -> output pixel) into a
 * temporary canvas of the given size and returns its pixels. Areas the image
 * does not cover stay transparent. Used for the auto-detect working copies.
 */
export function sampleImage(
  image: CanvasImageSource,
  transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  width: number,
  height: number,
): ImageData {
  const { canvas, ctx } = createCanvas(width, height);
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const t = transform;
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    ctx.drawImage(image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    releaseCanvas(canvas);
  }
}

/** Cap for a display canvas backing store (device pixels per CSS pixel). */
export const MAX_DPR = 2;

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
 * the cost follows the stage size, not the zoom level (v0.9).
 */
export function drawImageThrough(
  ctx: CanvasRenderingContext2D,
  image: HTMLCanvasElement,
  transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  width: number,
  height: number,
  dpr: number,
  clip?: { x: number; y: number; width: number; height: number },
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Visible image region: the stage corners mapped back into image pixels.
  const t = transform;
  const det = t.a * t.d - t.b * t.c;
  if (!det) return;
  const inv = { a: t.d / det, b: -t.b / det, c: -t.c / det, d: t.a / det };
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((p) => ({
    x: inv.a * (p.x - t.e) + inv.c * (p.y - t.f),
    y: inv.b * (p.x - t.e) + inv.d * (p.y - t.f),
  }));
  const x0 = Math.max(0, clip?.x ?? 0, Math.floor(Math.min(...corners.map((p) => p.x))) - 1);
  const y0 = Math.max(0, clip?.y ?? 0, Math.floor(Math.min(...corners.map((p) => p.y))) - 1);
  const x1 = Math.min(image.width, clip ? clip.x + clip.width : Infinity, Math.ceil(Math.max(...corners.map((p) => p.x))) + 1);
  const y1 = Math.min(image.height, clip ? clip.y + clip.height : Infinity, Math.ceil(Math.max(...corners.map((p) => p.y))) + 1);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.setTransform(t.a * dpr, t.b * dpr, t.c * dpr, t.d * dpr, t.e * dpr, t.f * dpr);
  ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
