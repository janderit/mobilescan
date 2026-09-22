/**
 * 2D affine transforms and the point tuples the geometry works with.
 * No DOM access: plain number maths so it can be unit tested.
 */

import type { Point } from './model';
import { isRightAngle } from './angles';

/** Four points in corner order nw, ne, se, sw. */
export type Quad = [Point, Point, Point, Point];

/** Maps each point of a quad, keeping the 4-tuple type (no `as Quad` cast needed). */
export function mapQuad<T>(quad: Quad, fn: (p: Point, index: number) => T): [T, T, T, T] {
  return [fn(quad[0], 0), fn(quad[1], 1), fn(quad[2], 2), fn(quad[3], 3)];
}

/** The corners of an image of the given size in image coordinates: nw, ne, se, sw. */
export function imageCorners(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/** 2D affine transform: p -> (a*x + c*y + e, b*x + d*y + f). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function applyAffine(t: Affine, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

export function invertAffine(t: Affine): Affine {
  const det = t.a * t.d - t.b * t.c;
  const a = t.d / det;
  const b = -t.b / det;
  const c = -t.c / det;
  const d = t.a / det;
  return { a, b, c, d, e: -(a * t.e + c * t.f), f: -(b * t.e + d * t.f) };
}

/** Uniform scale factor of a rotation+scale affine transform. */
export function affineScale(t: Affine): number {
  return Math.hypot(t.a, t.b);
}

const QUARTER = Math.PI / 2;

/** cos/sin snapped to exact 0/±1 for multiples of 90°, so those rotations copy pixels exactly. */
function exactCosSin(angle: number): { c: number; s: number } {
  if (isRightAngle(angle)) {
    const k = ((Math.round(angle / QUARTER) % 4) + 4) % 4;
    return { c: [1, 0, -1, 0][k]!, s: [0, 1, 0, -1][k]! };
  }
  return { c: Math.cos(angle), s: Math.sin(angle) };
}

/** Rotation by `angle` about `pivot`, then translation by (tx, ty). */
export function rotationAbout(angle: number, pivot: Point, tx = 0, ty = 0): Affine {
  const { c, s } = exactCosSin(angle);
  return {
    a: c,
    b: s,
    c: 0 - s,
    d: c,
    e: pivot.x - c * pivot.x + s * pivot.y + tx,
    f: pivot.y - s * pivot.x - c * pivot.y + ty,
  };
}
