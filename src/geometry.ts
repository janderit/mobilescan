/**
 * Pure geometry for the capture frame (see intent/v0.1-mvp.md "Data model").
 * No DOM access: everything here is plain number maths so it can be unit tested.
 *
 * This module is the barrel: the maths lives in
 * - `angles.ts`: angle normalisation, right angles, skew clamping;
 * - `affine.ts`: `Point`/`Quad` tuples and 2D affine transforms;
 * - `homography.ts`: projective transforms (v0.7 shear);
 * - `frame.ts`: the frame model and its editing (crop, shear, rotation);
 * - `layout.ts`: screen transforms and the bake layouts (rotation, warp).
 */

import type { Point } from './model';

export type { Point };

export * from './angles';
export * from './affine';
export * from './homography';
export * from './frame';
export * from './layout';
