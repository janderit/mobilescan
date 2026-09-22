/**
 * Frame region -> JPEG -> single-page A4 PDF -> Web Share (or download fallback).
 */

import type { Capture, CompressionLevel } from './model';
import { frameSourceRect } from './geometry';
import { jpegQuality } from './quality';
import { buildPdf, pdfFileName } from './pdf';

export type ShareOutcome = 'shared' | 'aborted';

/**
 * Renders the frame region of a capture into a new canvas.
 * `maxLongSide` optionally downscales (used for the on-screen preview only).
 */
export function renderFrame(capture: Capture, maxLongSide?: number): HTMLCanvasElement {
  const src = frameSourceRect(capture.frame);
  let width = Math.round(src.width);
  let height = Math.round(src.height);
  if (maxLongSide !== undefined) {
    const longSide = Math.max(width, height);
    if (longSide > maxLongSide) {
      const scale = maxLongSide / longSide;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }
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

/** Releases the pixel buffer of a canvas. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('JPEG encoding failed'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
      },
      'image/jpeg',
      quality,
    );
  });
}

/** Builds the PDF file for the frame region of a capture at the given compression. */
export async function buildPdfFile(capture: Capture, level: CompressionLevel): Promise<File> {
  const canvas = renderFrame(capture);
  try {
    const jpeg = await encodeJpeg(canvas, jpegQuality(level));
    const pdf = await buildPdf(jpeg, canvas.width, canvas.height);
    const bytes = new Uint8Array(pdf.byteLength);
    bytes.set(pdf);
    return new File([bytes], pdfFileName(new Date()), { type: 'application/pdf' });
  } finally {
    releaseCanvas(canvas);
  }
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
export async function sharePdf(file: File): Promise<ShareOutcome> {
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
