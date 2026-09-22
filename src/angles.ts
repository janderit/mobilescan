/**
 * Angle helpers shared by the frame model and the affine transforms.
 *
 * Angle convention: `Frame.angle` is the rotation of the frame relative to the
 * image, in radians, positive = clockwise on screen (image coordinates are
 * y-down). Baking rotates the image by `-angle` so the frame ends up upright.
 * The "rotate 90° right" button therefore *subtracts* 90°: the image turns
 * clockwise when baked.
 */

/** Maximum fine skew either side of the nearest right angle. */
export const MAX_SKEW = (15 * Math.PI) / 180;
/** Fine rotation snaps to the nearest right angle within this. */
export const SNAP_SKEW = (0.5 * Math.PI) / 180;

const QUARTER = Math.PI / 2;
const EPSILON = 1e-9;

/** Normalises an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (Math.abs(a) < EPSILON) a = 0;
  return a;
}

/** The right angle nearest to `angle` (a multiple of 90°). */
export function baseAngle(angle: number): number {
  return Math.round(angle / QUARTER) * QUARTER;
}

/** True when `angle` is (numerically) an exact multiple of 90°. */
export function isRightAngle(angle: number): boolean {
  return Math.abs(angle - baseAngle(angle)) < EPSILON;
}

/**
 * Clamps a fine rotation to ±15° around `base` and snaps to `base` within ±0.5°.
 */
export function clampSkew(angle: number, base: number): number {
  const skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, angle - base));
  if (Math.abs(skew) <= SNAP_SKEW) return base;
  return base + skew;
}
