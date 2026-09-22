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
