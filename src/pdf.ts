/**
 * Single-page A4 PDF from one JPEG (see intent/v0.1-mvp.md "PDF").
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

/**
 * A4 page whose orientation follows the image, with the image scaled uniformly
 * to fit inside it and centred. Borders on one axis are accepted
 * (decision 2026-09-22).
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

/** Build the one-page PDF embedding the given JPEG. */
export async function buildPdf(
  jpeg: Uint8Array,
  imageWidth: number,
  imageHeight: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.setTitle('MobileScan');
  doc.setProducer('MobileScan');
  doc.setCreator('MobileScan');

  const image = await doc.embedJpg(jpeg);
  const layout = pageLayout(imageWidth, imageHeight);
  const page = doc.addPage([layout.pageWidth, layout.pageHeight]);
  page.drawImage(image, {
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
  });

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
