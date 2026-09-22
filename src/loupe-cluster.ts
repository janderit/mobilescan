/**
 * Loupe cluster (v0.6): while a drag is in progress in the crop/rotate view,
 * round magnified views of the affected frame corners sit in the centre of
 * the stage. This class owns the `.loupe-cluster` element with its four
 * `.loupe` canvases and draws them; the pure geometry (corner selection,
 * cluster layout, suppression, the loupe's affine transform) lives in
 * `loupe.ts`.
 *
 * Zoom (v0.9): no loupes while the zoomed view is already as magnified as a
 * loupe would be. The caller passes the composed view scale and the loupe
 * scale in; both depend on its transforms.
 */

import type { Frame } from './model';
import { applyAffine, baseAngle, quadCorners, type Point, type Rect } from './geometry';
import { displayDpr, releaseCanvas } from './canvas';
import {
  CORNERS,
  LOUPE_DIAMETER,
  LOUPE_INNER,
  clusterBounds,
  loupeCorners,
  loupeSourceRect,
  loupeTransform,
  placeLoupes,
  type Corner,
  type DragKind,
  type LoupePlacement,
} from './loupe';

/** Loupe state of one drag: where the cluster goes, or nothing if suppressed. */
interface LoupeState {
  layout: LoupePlacement[];
  /** Set on the first pointermove; a tap without movement shows no loupe. */
  shown: boolean;
}

/** Frame line style inside a loupe, matching `.edit-frame` in the stylesheet. */
const FRAME_STROKE = '#facc15';
const FRAME_LINE_WIDTH = 3;
const FRAME_DASH = [10, 8];

export class LoupeCluster {
  readonly element: HTMLElement;

  private readonly loupes: Map<Corner, { element: HTMLElement; canvas: HTMLCanvasElement }>;
  private state: LoupeState | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'loupe-cluster';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.hidden = true;
    this.loupes = new Map();
    for (const corner of CORNERS) {
      const element = document.createElement('div');
      element.className = 'loupe';
      element.dataset.corner = corner;
      element.hidden = true;
      const canvas = document.createElement('canvas');
      element.append(canvas);
      this.element.append(element);
      this.loupes.set(corner, { element, canvas });
    }
  }

  /**
   * Decides at drag start which corners to magnify and where the cluster
   * goes. No loupes while the zoomed view is already as magnified as a
   * loupe would be (v0.9): `viewScale` is the composed view's CSS pixels per
   * image pixel, `loupeScale` the loupe's.
   */
  begin(
    kind: DragKind,
    stageWidth: number,
    stageHeight: number,
    startView: Point,
    viewScale: number,
    loupeScale: number,
  ): void {
    if (viewScale >= loupeScale - 1e-9) {
      this.state = null;
      return;
    }
    const layout = placeLoupes(loupeCorners(kind), stageWidth, stageHeight, startView);
    this.state = layout ? { layout, shown: false } : null;
  }

  /** Hides the cluster and forgets the placement. */
  hide(): void {
    this.state = null;
    this.element.hidden = true;
    for (const { element } of this.loupes.values()) element.hidden = true;
  }

  /**
   * Shows the cluster on the first move of a drag and redraws every visible
   * loupe: the source square around the frame corner at `scale` (CSS pixels
   * per image pixel) with the main view's base rotation, then the frame
   * polygon through the loupe transform.
   */
  render(image: HTMLCanvasElement, pending: Frame, scale: number): void {
    const state = this.state;
    if (!state) return;
    const dpr = displayDpr();
    if (!state.shown) {
      state.shown = true;
      const radius = LOUPE_DIAMETER / 2;
      for (const { corner, x, y } of state.layout) {
        const loupe = this.loupes.get(corner)!;
        loupe.element.style.left = `${x - radius}px`;
        loupe.element.style.top = `${y - radius}px`;
        loupe.element.hidden = false;
        const size = Math.round(LOUPE_INNER * dpr);
        if (loupe.canvas.width !== size || loupe.canvas.height !== size) {
          loupe.canvas.width = size;
          loupe.canvas.height = size;
        }
      }
      this.element.hidden = false;
    }
    const base = baseAngle(pending.angle);
    const corners = quadCorners(pending);
    const { width, height } = image;
    for (const { corner } of state.layout) {
      const centre = corners[CORNERS.indexOf(corner)]!;
      const ctx = this.loupes.get(corner)!.canvas.getContext('2d');
      if (!ctx) continue;
      const t = loupeTransform(centre, base, scale);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.setTransform(t.a * dpr, t.b * dpr, t.c * dpr, t.d * dpr, t.e * dpr, t.f * dpr);
      const src = loupeSourceRect(centre, scale, width, height);
      if (src) {
        ctx.drawImage(image, src.x, src.y, src.width, src.height, src.x, src.y, src.width, src.height);
      }
      // Frame lines: the whole frame polygon through the loupe transform, so
      // an edge that merely passes through the loupe is drawn too.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      corners.forEach((p, i) => {
        const q = applyAffine(t, p);
        if (i === 0) ctx.moveTo(q.x * dpr, q.y * dpr);
        else ctx.lineTo(q.x * dpr, q.y * dpr);
      });
      ctx.closePath();
      ctx.strokeStyle = FRAME_STROKE;
      ctx.lineWidth = FRAME_LINE_WIDTH * dpr;
      ctx.setLineDash(FRAME_DASH.map((d) => d * dpr));
      ctx.stroke();
    }
  }

  /** Hides the cluster and releases the loupe canvases' memory. */
  release(): void {
    this.hide();
    for (const { canvas } of this.loupes.values()) releaseCanvas(canvas);
  }

  /** Test hook: the CSS-pixel bounds of the visible cluster, or null. */
  get visibleBounds(): Rect | null {
    const state = this.state;
    if (!state || !state.shown) return null;
    return clusterBounds(state.layout);
  }
}
