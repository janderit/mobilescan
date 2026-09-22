/**
 * Data model shared by all versions (see intent/v0.1-mvp.md "Data model").
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
}

export interface Capture {
  /** full captured image, never cropped */
  image: HTMLCanvasElement;
  /** frame in image pixel coordinates */
  frame: Frame;
}

/** Compression levels of the share sheet. */
export type CompressionLevel = 'small' | 'medium' | 'large';
