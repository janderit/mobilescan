/**
 * Data model shared by all versions (see intent/v0.1-mvp.md "Data model" and
 * intent/v0.5-multi-page.md "Document and pages").
 * Held in memory only; never persisted.
 */

/** Frame geometry in captured-image pixel coordinates. */
export interface Frame {
  /** centre */
  cx: number;
  cy: number;
  /** size along the frame's own axes */
  width: number;
  height: number;
  /** radians, 0 in v0.1 */
  angle: number;
  /**
   * v0.7: displacement of each corner (nw, ne, se, sw) from the rectangle
   * corner, in frame-local coordinates (the rectangle's own axes, before
   * rotation). Absent or all zero means the frame is the rectangle. Only the
   * pending frame of the crop/rotate view ever carries non-zero offsets; a
   * confirmed frame never does.
   */
  corners?: [Point, Point, Point, Point];
}

/** A point in image or frame-local pixels. */
export interface Point {
  x: number;
  y: number;
}

/** The unit the edit views and the share code operate on: a live image plus its frame. */
export interface Capture {
  /** full captured image, never cropped */
  image: HTMLCanvasElement;
  /** frame in image pixel coordinates */
  frame: Frame;
}

/**
 * One scanned page (v0.5). Exactly the current page holds a full-resolution
 * canvas in `image`; every other page is parked as a full-image JPEG in
 * `blob`. `width`/`height` are the full image size in pixels, needed for the
 * frame maths while the page is parked.
 */
export interface Page {
  image: HTMLCanvasElement | null;
  blob: Blob | null;
  width: number;
  height: number;
  frame: Frame;
  /** True after a bake changed the pixels since the page was last parked. */
  dirty: boolean;
}

/** The scan in progress: pages in capture order and the one on screen. */
export interface Document {
  pages: Page[];
  current: number;
}

/** Soft limit: [+] is disabled at this many pages (decision 2026-09-22). */
export const MAX_PAGES = 20;

/** Compression levels of the share sheet. */
export type CompressionLevel = 'small' | 'medium' | 'large';
