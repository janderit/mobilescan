// ---- homographies ------------------------------------------------------------

import type { Point } from './model';
import type { Quad } from './affine';

/**
 * A projective transform as a row-major 3x3 matrix: p -> (h0 x + h1 y + h2,
 * h3 x + h4 y + h5) / (h6 x + h7 y + h8).
 */
export type Homography = [number, number, number, number, number, number, number, number, number];

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Solves `a x = b` for a square system by Gaussian elimination with partial pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      throw new Error('singular system');
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const head = m[col]!;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = m[row]!;
      const factor = target[col]! / head[col]!;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) target[k] = target[k]! - factor * head[k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * The homography mapping four source points onto four destination points
 * (direct linear transform: eight equations, h8 fixed at 1).
 */
export function homographyFromPoints(src: Quad, dst: Quad): Homography {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(a, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** The inverse homography (adjugate; the scale is irrelevant for a projective map). */
export function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-18) {
    throw new Error('singular homography');
  }
  return [
    (e * j - f * i) / det,
    (c * i - b * j) / det,
    (b * f - c * e) / det,
    (f * g - d * j) / det,
    (a * j - c * g) / det,
    (c * d - a * f) / det,
    (d * i - e * g) / det,
    (b * g - a * i) / det,
    (a * e - b * d) / det,
  ];
}

/** `m * h` as a homography (apply `h` first, then `m`). */
export function multiplyHomography(m: Homography, h: Homography): Homography {
  const r: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      r.push(
        m[row * 3]! * h[col]! + m[row * 3 + 1]! * h[3 + col]! + m[row * 3 + 2]! * h[6 + col]!,
      );
    }
  }
  return r as Homography;
}
