import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { A4, buildPdf, pageLayout, pdfFileName, scanFileName } from '../src/pdf';
import { SQRT2 } from '../src/geometry';

/** A minimal valid baseline JPEG, 1 x 1 pixel. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function tinyJpeg(): Uint8Array {
  const binary = atob(TINY_JPEG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe('pageLayout', () => {
  it('uses A4 portrait for a portrait image', () => {
    const layout = pageLayout(3000, 4000);
    expect(layout.pageWidth).toBe(A4.width);
    expect(layout.pageHeight).toBe(A4.height);
  });

  it('uses A4 landscape for a landscape image', () => {
    const layout = pageLayout(4000, 3000);
    expect(layout.pageWidth).toBe(A4.height);
    expect(layout.pageHeight).toBe(A4.width);
  });

  it('treats a square image as portrait', () => {
    const layout = pageLayout(2000, 2000);
    expect(layout.pageWidth).toBe(A4.width);
    expect(layout.pageHeight).toBe(A4.height);
  });

  it('scales uniformly to fit inside the page and centres the result', () => {
    const imageWidth = 3000;
    const imageHeight = 4000;
    const layout = pageLayout(imageWidth, imageHeight);

    expect(layout.width).toBeLessThanOrEqual(layout.pageWidth + 1e-9);
    expect(layout.height).toBeLessThanOrEqual(layout.pageHeight + 1e-9);
    // Aspect ratio preserved.
    expect(layout.width / layout.height).toBeCloseTo(imageWidth / imageHeight, 12);
    // Centred: equal borders on both axes.
    expect(layout.x).toBeCloseTo(layout.pageWidth - (layout.x + layout.width), 9);
    expect(layout.y).toBeCloseTo(layout.pageHeight - (layout.y + layout.height), 9);
    // It touches at least one page edge, i.e. it is not scaled down further than needed.
    expect(Math.min(layout.x, layout.y)).toBeCloseTo(0, 9);
  });

  it('leaves borders on exactly one axis for a non-sqrt2 crop', () => {
    const layout = pageLayout(1000, 1200);
    expect(layout.x).toBeCloseTo(0, 9);
    expect(layout.width).toBeCloseTo(A4.width, 9);
    expect(layout.y).toBeGreaterThan(1);
    expect(layout.height).toBeLessThan(A4.height - 1);
  });

  it('leaves borders on exactly one axis for a landscape non-sqrt2 crop', () => {
    const layout = pageLayout(1200, 1000);
    expect(layout.y).toBeCloseTo(0, 9);
    expect(layout.height).toBeCloseTo(A4.width, 9);
    expect(layout.x).toBeGreaterThan(1);
  });

  it('leaves essentially no border for an exact 1:sqrt2 crop', () => {
    const layout = pageLayout(1000, 1000 * SQRT2);
    // A4 is 1:sqrt2 only up to its rounding to 2 decimal points.
    expect(layout.x).toBeCloseTo(0, 6);
    expect(layout.y).toBeLessThan(0.05);
    expect(layout.width).toBeCloseTo(A4.width, 6);
    expect(layout.height).toBeCloseTo(A4.height, 1);
  });
});

describe('buildPdf', () => {
  it('produces a one-page A4 portrait PDF with MobileScan metadata', async () => {
    const bytes = await buildPdf([{ jpeg: tinyJpeg(), width: 3000, height: 4000 }]);
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    // updateMetadata: false, otherwise loading rewrites Producer with pdf-lib's own.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(A4.width, 2);
    expect(size.height).toBeCloseTo(A4.height, 2);
    expect(doc.getTitle()).toBe('MobileScan');
    expect(doc.getProducer()).toBe('MobileScan');
    expect(doc.getCreator()).toBe('MobileScan');
  });

  it('produces a landscape page for a landscape crop', async () => {
    const bytes = await buildPdf([{ jpeg: tinyJpeg(), width: 4000, height: 3000 }]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(A4.height, 2);
    expect(size.height).toBeCloseTo(A4.width, 2);
  });
});

describe('buildPdf multi-page (v0.5)', () => {
  it('adds one page per image in order, each with its own orientation', async () => {
    const jpeg = tinyJpeg();
    const bytes = await buildPdf([
      { jpeg, width: 3000, height: 4000 },
      { jpeg, width: 2000, height: 2800 },
      { jpeg, width: 4000, height: 3000 },
    ]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    const sizes = doc.getPages().map((page) => page.getSize());
    expect(sizes[0]!.width).toBeCloseTo(A4.width, 2);
    expect(sizes[0]!.height).toBeCloseTo(A4.height, 2);
    expect(sizes[1]!.width).toBeCloseTo(A4.width, 2);
    expect(sizes[1]!.height).toBeCloseTo(A4.height, 2);
    expect(sizes[2]!.width).toBeCloseTo(A4.height, 2);
    expect(sizes[2]!.height).toBeCloseTo(A4.width, 2);
  });

  it('rejects an empty page list', async () => {
    await expect(buildPdf([])).rejects.toThrow('no pages');
  });
});

describe('pdfFileName', () => {
  it('formats local time as scan-YYYYMMDD-HHMMSS.pdf', () => {
    expect(pdfFileName(new Date(2026, 8, 22, 14, 5, 9))).toBe('scan-20260922-140509.pdf');
  });

  it('zero pads every field', () => {
    expect(pdfFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('scan-20260102-030405.pdf');
  });

  it('matches the expected shape for the current time', () => {
    expect(pdfFileName(new Date())).toMatch(/^scan-\d{8}-\d{6}\.pdf$/);
  });
});

describe('scanFileName', () => {
  it('uses the same stamp with another extension', () => {
    expect(scanFileName(new Date(2026, 8, 22, 14, 5, 9), 'jpg')).toBe('scan-20260922-140509.jpg');
  });
});
