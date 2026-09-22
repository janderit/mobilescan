/**
 * Auto-detect: the glue between the canvas and the pure detection maths, and
 * the barrel over detect-edges.ts (working layouts, luminance, edge search),
 * detect-frame.ts (frame from corners, detection rules), detect-tracker.ts
 * (live hysteresis) and detect-tone.ts (paper levels and tone). Only this
 * file touches a canvas: `detectFrameIn` renders the working copy with
 * `sampleImage` and `DetectScratch` keeps a `WorkingCanvas` across runs.
 */

import type { Frame } from './model';
import { sampleImage, WorkingCanvas } from './canvas';
import { frameWorkingLayout } from './detect-edges';
import { detectFrame, detectFrameStrict, type DetectBuffers } from './detect-frame';

export * from './detect-edges';
export * from './detect-frame';
export * from './detect-tracker';
export * from './detect-tone';

/**
 * Buffers a caller may keep between detection runs so that a run allocates
 * neither a working canvas nor the luminance arrays (the live detection loop).
 * Create one with `createDetectScratch`, drop it with `releaseDetectScratch`.
 */
export interface DetectScratch extends DetectBuffers {
  canvas: WorkingCanvas;
}

export function createDetectScratch(): DetectScratch {
  return { canvas: new WorkingCanvas() };
}

export function releaseDetectScratch(scratch: DetectScratch): void {
  scratch.canvas.release();
  delete scratch.luminance;
}

/**
 * The whole pipeline on an image: renders the working copy of `frame`
 * (offsets ignored by the layout) from `image` and runs `rule` on it. The
 * wand's `detectFrame` by default; the live detection and the still after
 * the shutter pass `detectFrameStrict`. A caller that runs repeatedly hands
 * in a `scratch` so the working canvas and luminance arrays are reused.
 */
export function detectFrameIn(
  image: CanvasImageSource,
  frame: Frame,
  imageWidth: number,
  rule: typeof detectFrameStrict = detectFrame,
  scratch?: DetectScratch,
): Frame | null {
  const layout = frameWorkingLayout(frame);
  const working = sampleImage(image, layout.transform, layout.width, layout.height, scratch?.canvas);
  return rule(working, layout, frame, imageWidth, scratch);
}
