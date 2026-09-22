/**
 * Data model shared by all versions (see intent/v0.1-mvp.md "Data model" and
 * intent/v0.5-multi-page.md "Document and pages").
 * Held in memory only; never persisted.
 */

/** The rectangle part of a frame, in captured-image pixel coordinates. */
interface FrameRect {
  /** centre */
  cx: number;
  cy: number;
  /** size along the frame's own axes */
  width: number;
  height: number;
}

/**
 * Frame geometry in captured-image pixel coordinates: the general shape, which
 * may be rotated (`angle`) and sheared (`corners`). Only the pending frame of
 * the crop/rotate view, detection results and the intermediate results of the
 * frame editing helpers carry a rotation or corner offsets; a frame stored on a
 * page is an `UprightFrame`.
 */
export interface Frame extends FrameRect {
  /** radians, 0 in v0.1 */
  angle: number;
  /**
   * v0.7: displacement of each corner (nw, ne, se, sw) from the rectangle
   * corner, in frame-local coordinates (the rectangle's own axes, before
   * rotation). Absent or all zero means the frame is the rectangle. Only the
   * pending frame of the crop/rotate view ever carries non-zero offsets; a
   * confirmed frame never does.
   */
  corners?: [Point, Point, Point, Point] | undefined;
}

/**
 * A frame that is a plain axis-aligned rectangle of the image: angle 0 and no
 * corner offsets. This is the invariant of every frame stored on a `Page` (and
 * so of `Capture.frame`, the stages, the share code): every bake produces one,
 * `initialFrame` produces one, and a capture whose bake fails keeps the static
 * frame. Assignable to `Frame`, so the read-only geometry accepts both; the
 * reverse needs a bake (`bakeFrame`) or `uprightFrame` where angle 0 and no
 * offsets have been established.
 */
export interface UprightFrame extends FrameRect {
  angle: 0;
  corners?: undefined;
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
  /** frame in image pixel coordinates, always upright */
  frame: UprightFrame;
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
  /** always upright: angle 0, no corner offsets */
  frame: UprightFrame;
  /** True after a bake changed the pixels since the page was last parked. */
  dirty: boolean;
}

/** Soft limit: [+] is disabled at this many pages (decision 2026-09-22). */
export const MAX_PAGES = 20;

/** Compression levels of the share sheet. */
export type CompressionLevel = 'small' | 'medium' | 'large';
