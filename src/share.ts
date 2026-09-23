/**
 * Frame regions -> JPEGs -> A4 PDF (one page per scan) or, for a single
 * page, the JPEG itself -> Web Share (or download fallback).
 */

import type { Capture, CompressionLevel, Page } from './model';
import { frameSourceRect } from './geometry';
import { jpegQuality } from './quality';
import { buildPdf, pdfFileName, scanFileName, type PdfImage } from './pdf';
import { createCanvas, encodeJpegBlob, releaseCanvas } from './canvas';
import { decodePage } from './pages';

export type ShareOutcome = 'shared' | 'aborted';

/** Renders the frame region of a capture into a new canvas at full resolution. */
export function renderFrame(capture: Capture): HTMLCanvasElement {
  const src = frameSourceRect(capture.frame);
  const { canvas, ctx } = createCanvas(Math.round(src.width), Math.round(src.height));
  ctx.drawImage(
    capture.image,
    src.x,
    src.y,
    src.width,
    src.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

/** Renders and encodes the frame region of one page as a JPEG blob with its pixel size. */
async function encodePage(
  page: Page,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  // A parked page is decoded into a temporary canvas; the current page is
  // encoded from its live canvas. Peak memory: one full canvas plus one frame canvas.
  const full = page.image ?? (await decodePage(page));
  const temporary = full !== page.image;
  try {
    const frame = renderFrame({ image: full, frame: page.frame });
    try {
      const blob = await encodeJpegBlob(frame, quality);
      return { blob, width: frame.width, height: frame.height };
    } finally {
      releaseCanvas(frame);
    }
  } finally {
    if (temporary) releaseCanvas(full);
  }
}

/** Renders and encodes the frame region of one page for the PDF. */
async function encodePdfImage(page: Page, quality: number): Promise<PdfImage> {
  const { blob, width, height } = await encodePage(page, quality);
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/**
 * Builds the PDF file with one page per scan, in order, at the given
 * compression. Pages are encoded one after the other.
 */
export async function buildPdfFile(pages: readonly Page[], level: CompressionLevel): Promise<File> {
  const quality = jpegQuality(level);
  const images: PdfImage[] = [];
  for (const page of pages) {
    images.push(await encodePdfImage(page, quality));
  }
  const pdf = await buildPdf(images);
  const bytes = new Uint8Array(pdf.byteLength);
  bytes.set(pdf);
  return new File([bytes], pdfFileName(new Date()), { type: 'application/pdf' });
}

/**
 * Builds the JPEG file of one page's frame region at the given compression:
 * the same encoding the PDF embeds, without the page around it.
 */
export async function buildJpegFile(page: Page, level: CompressionLevel): Promise<File> {
  const { blob } = await encodePage(page, jpegQuality(level));
  return new File([blob], scanFileName(new Date(), 'jpg'), { type: 'image/jpeg' });
}


function canShareFiles(files: File[]): boolean {
  if (typeof navigator.share !== 'function') {
    return false;
  }
  if (typeof navigator.canShare !== 'function') {
    return false;
  }
  return navigator.canShare({ files });
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Defer revocation so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Hands the file to the OS share sheet. Falls back to a download when the
 * browser cannot share files. Rejects with the original error for anything
 * other than a user abort.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  const files = [file];
  if (!canShareFiles(files)) {
    downloadFile(file);
    return 'shared';
  }
  try {
    await navigator.share({ files, title: 'Scan' });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return 'aborted';
    }
    throw error;
  }
}
