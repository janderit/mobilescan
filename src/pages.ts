/**
 * Page store of a multi-page scan (v0.5): parking pages that leave the
 * screen as a full-image JPEG blob and waking them back into a canvas, so
 * that only the current page holds a full-resolution canvas.
 */

import type { Capture, Page } from './model';
import { createCanvas, encodeJpegBlob, releaseCanvas } from './canvas';

/** JPEG quality of a parked page (decision 2026-09-22). */
export const PARK_QUALITY = 0.95;

/** Wraps a freshly captured image into a page: live canvas, nothing parked yet. */
export function newPage(capture: Capture): Page {
  return {
    image: capture.image,
    blob: null,
    width: capture.image.width,
    height: capture.image.height,
    frame: capture.frame,
    dirty: false,
  };
}

/** The page as the edit views and the share code see it. Throws for a parked page. */
export function asCapture(page: Page): Capture {
  if (!page.image) {
    throw new Error('page is parked');
  }
  return { image: page.image, frame: page.frame };
}

/**
 * Stores the outcome of an edit view. A bake hands back a new canvas, which
 * marks the page dirty; a crop only updates the frame.
 */
export function applyCapture(page: Page, capture: Capture): void {
  if (capture.image !== page.image) {
    page.dirty = true;
  }
  page.image = capture.image;
  page.width = capture.image.width;
  page.height = capture.image.height;
  page.frame = capture.frame;
}

/**
 * Parks a page: encodes the full image as JPEG unless an up-to-date blob
 * exists, then releases the canvas. Navigating back and forth between
 * unchanged pages therefore causes no repeated generation loss.
 */
export async function parkPage(page: Page): Promise<void> {
  const { image } = page;
  if (!image) return;
  if (page.dirty || !page.blob) {
    page.blob = await encodeJpegBlob(image, PARK_QUALITY);
    page.dirty = false;
  }
  releaseCanvas(image);
  page.image = null;
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('JPEG decoding failed'));
    };
    img.src = url;
  });
}

/**
 * Decodes a parked page's blob into a fresh full-size canvas. The caller owns
 * the canvas. Uses `createImageBitmap` where available, an `Image` otherwise.
 */
export async function decodePage(page: Page): Promise<HTMLCanvasElement> {
  if (!page.blob) {
    throw new Error('page has no blob');
  }
  const { canvas, ctx } = createCanvas(page.width, page.height);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(page.blob);
    try {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  } else {
    const img = await loadImageElement(page.blob);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/** Wakes a parked page: decodes its blob into a live canvas. The blob is kept. */
export async function wakePage(page: Page): Promise<void> {
  if (page.image) return;
  page.image = await decodePage(page);
}

/** Releases whatever a page holds. */
export function releasePage(page: Page): void {
  if (page.image) {
    releaseCanvas(page.image);
    page.image = null;
  }
  page.blob = null;
}
