/**
 * A4 PDF from one JPEG per page (see intent/v0.1-mvp.md "PDF" and
 * intent/v0.5-multi-page.md "Share").
 * No DOM access: takes the encoded JPEG bytes and returns the PDF bytes.
 */

import { PDFDocument } from 'pdf-lib';

/** A4 in PDF points, portrait. */
export const A4 = { width: 595.28, height: 841.89 } as const;

/** Page size and image placement, in PDF points, origin bottom-left. */
export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One encoded scan page: JPEG bytes and their pixel size. */
export interface PdfImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * A4 page whose orientation follows the image, with the image scaled uniformly
 * to fit inside it and centred. Borders on one axis are accepted.
 */
export function pageLayout(imageWidth: number, imageHeight: number): PageLayout {
  const portrait = imageHeight >= imageWidth;
  const pageWidth = portrait ? A4.width : A4.height;
  const pageHeight = portrait ? A4.height : A4.width;
  const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    pageWidth,
    pageHeight,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

/** Builds the PDF with one A4 page per image, in the given order. */
export async function buildPdf(images: readonly PdfImage[]): Promise<Uint8Array<ArrayBuffer>> {
  if (images.length === 0) {
    throw new Error('no pages');
  }
  const doc = await PDFDocument.create();
  doc.setTitle('MobileScan');
  doc.setProducer('MobileScan');
  doc.setCreator('MobileScan');

  for (const { jpeg, width, height } of images) {
    const image = await doc.embedJpg(jpeg);
    const layout = pageLayout(width, height);
    const page = doc.addPage([layout.pageWidth, layout.pageHeight]);
    page.drawImage(image, {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
    });
  }

  // pdf-lib allocates a plain ArrayBuffer; narrowing the buffer type lets callers
  // hand the bytes straight to Blob/File without a copy.
  return (await doc.save()) as Uint8Array<ArrayBuffer>;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** `scan-YYYYMMDD-HHMMSS.pdf` in local time. */
export function pdfFileName(date: Date): string {
  const stamp =
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `scan-${stamp}.pdf`;
}
