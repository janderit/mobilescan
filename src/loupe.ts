/**
 * Loupe geometry (v0.6, see intent/v0.6-loupes.md): which frame corners a
 * drag magnifies, where the loupes sit on the stage, and the affine transform
 * that maps image pixels into one loupe. Pure maths, no DOM, so it can be
 * unit tested against the main view's transform.
 */

import { rotationAbout, type Affine, type Handle, type Point, type Rect } from './geometry';

/** Outer diameter of a loupe in CSS pixels, border included. */
export const LOUPE_DIAMETER = 96;
/** Dark border width in CSS pixels (a 1 px white ring sits outside it). */
export const LOUPE_BORDER = 3;
/** Diameter of the magnified content, i.e. the canvas inside the border. */
export const LOUPE_INNER = LOUPE_DIAMETER - 2 * LOUPE_BORDER;
/** Gap between loupes of one cluster in CSS pixels. */
export const LOUPE_GAP = 12;
/** Magnification relative to the main view's scale. */
export const LOUPE_MAGNIFICATION = 3;
/** One image pixel is never stretched beyond this many device pixels. */
export const LOUPE_MAX_DEVICE_PIXELS = 2;
/** The cluster keeps at least this distance from the drag's start point. */
export const LOUPE_SUPPRESS_MARGIN = 24;

export type Corner = 'nw' | 'ne' | 'se' | 'sw';

/** Corner order of `frameCorners` and of the 2x2 grid. */
export const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

/** What a drag in the crop/rotate view affects. */
export type DragKind = 'move' | 'rotate' | Handle;

/**
 * The corners a drag magnifies: a corner handle its own corner, an edge
 * handle the edge's two corners, body drag and rotation all four.
 */
export function loupeCorners(kind: DragKind): Corner[] {
  switch (kind) {
    case 'nw':
    case 'ne':
    case 'se':
    case 'sw':
      return [kind];
    case 'n':
      return ['nw', 'ne'];
    case 's':
      return ['sw', 'se'];
    case 'e':
      return ['ne', 'se'];
    case 'w':
      return ['nw', 'sw'];
    default:
      return [...CORNERS];
  }
}

/** A loupe's corner and the CSS-pixel centre of its circle on the stage. */
export interface LoupePlacement {
  corner: Corner;
  x: number;
  y: number;
}

const isTop = (corner: Corner): boolean => corner === 'nw' || corner === 'ne';
const isLeft = (corner: Corner): boolean => corner === 'nw' || corner === 'sw';

/**
 * Places a cluster in the centre of a stage of the given size: one loupe
 * centred, two side by side (both top or both bottom corners) or stacked
 * (both left or both right), four in a 2x2 grid in corner order.
 */
export function loupeLayout(corners: readonly Corner[], viewWidth: number, viewHeight: number): LoupePlacement[] {
  const cx = viewWidth / 2;
  const cy = viewHeight / 2;
  const step = (LOUPE_DIAMETER + LOUPE_GAP) / 2;
  if (corners.length === 1) {
    return [{ corner: corners[0]!, x: cx, y: cy }];
  }
  if (corners.length === 2) {
    const [a, b] = corners as [Corner, Corner];
    const horizontal = isTop(a) === isTop(b);
    return [a, b].map((corner) =>
      horizontal
        ? { corner, x: cx + (isLeft(corner) ? -step : step), y: cy }
        : { corner, x: cx, y: cy + (isTop(corner) ? -step : step) },
    );
  }
  return corners.map((corner) => ({
    corner,
    x: cx + (isLeft(corner) ? -step : step),
    y: cy + (isTop(corner) ? -step : step),
  }));
}

/** Bounding box of a cluster's loupes in CSS pixels. */
export function clusterBounds(layout: readonly LoupePlacement[]): Rect {
  const r = LOUPE_DIAMETER / 2;
  const xs = layout.map((l) => l.x);
  const ys = layout.map((l) => l.y);
  const x = Math.min(...xs) - r;
  const y = Math.min(...ys) - r;
  return { x, y, width: Math.max(...xs) + r - x, height: Math.max(...ys) + r - y };
}

/** True when a drag starting at `start` (CSS px) would sit under the cluster. */
export function loupesSuppressed(layout: readonly LoupePlacement[], start: Point): boolean {
  if (layout.length === 0) return true;
  const b = clusterBounds(layout);
  const m = LOUPE_SUPPRESS_MARGIN;
  return start.x > b.x - m && start.x < b.x + b.width + m && start.y > b.y - m && start.y < b.y + b.height + m;
}

/**
 * Places the cluster for a drag that starts at `start` (CSS px): centred on
 * the stage when the finger is clear of it, otherwise shifted away from the
 * finger (vertically first, then horizontally, towards the side with more
 * room) so that a loupe never sits under the finger. Returns null only when
 * no placement clears the finger, e.g. on a stage smaller than the cluster.
 */
export function placeLoupes(
  corners: readonly Corner[],
  viewWidth: number,
  viewHeight: number,
  start: Point,
): LoupePlacement[] | null {
  const centred = loupeLayout(corners, viewWidth, viewHeight);
  if (!loupesSuppressed(centred, start)) return centred;
  const b = clusterBounds(centred);
  const m = LOUPE_SUPPRESS_MARGIN;
  const shifted = (dx: number, dy: number): LoupePlacement[] =>
    centred.map((l) => ({ corner: l.corner, x: l.x + dx, y: l.y + dy }));
  // Vertical candidates: cluster bottom just above the finger, or top just below it.
  const above = start.y - m - (b.y + b.height);
  const below = start.y + m - b.y;
  const vertical: number[] = start.y > viewHeight / 2 ? [above, below] : [below, above];
  for (const dy of vertical) {
    if (b.y + dy >= 0 && b.y + b.height + dy <= viewHeight) return shifted(0, dy);
  }
  const left = start.x - m - (b.x + b.width);
  const right = start.x + m - b.x;
  const horizontal: number[] = start.x > viewWidth / 2 ? [left, right] : [right, left];
  for (const dx of horizontal) {
    if (b.x + dx >= 0 && b.x + b.width + dx <= viewWidth) return shifted(dx, 0);
  }
  return null;
}

/**
 * CSS pixels per image pixel inside a loupe: three times the view scale,
 * capped so one image pixel covers at most two device pixels.
 */
export function loupeScale(viewScale: number, devicePixelRatio: number): number {
  return Math.min(LOUPE_MAGNIFICATION * viewScale, LOUPE_MAX_DEVICE_PIXELS / devicePixelRatio);
}

/**
 * Image point -> CSS pixel inside the loupe's content canvas (origin at its
 * top-left corner): the image turned by `-base` like the main view, scaled by
 * `scale`, with `corner` at the canvas centre.
 */
export function loupeTransform(corner: Point, base: number, scale: number): Affine {
  const rotate = rotationAbout(-base, corner);
  const half = LOUPE_INNER / 2;
  return {
    a: rotate.a * scale,
    b: rotate.b * scale,
    c: rotate.c * scale,
    d: rotate.d * scale,
    e: (rotate.e - corner.x) * scale + half,
    f: (rotate.f - corner.y) * scale + half,
  };
}

/**
 * The square of image pixels a loupe needs, clipped to the image: the
 * content circle around the corner plus a small margin. Its size does not
 * depend on the capture size, only on the magnification.
 */
export function loupeSourceRect(corner: Point, scale: number, imageWidth: number, imageHeight: number): Rect | null {
  const radius = LOUPE_INNER / 2 / scale + 2;
  const x0 = Math.max(0, Math.floor(corner.x - radius));
  const y0 = Math.max(0, Math.floor(corner.y - radius));
  const x1 = Math.min(imageWidth, Math.ceil(corner.x + radius));
  const y1 = Math.min(imageHeight, Math.ceil(corner.y + radius));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
