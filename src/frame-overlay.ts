/**
 * The SVG frame overlay shared by the camera view and the crop/rotate view:
 * a full-size `<svg>` over the stage with the shade (everything outside the
 * frame quadrilateral dimmed, an even-odd path with a hole) and, optionally,
 * the dashed outline polygon of the same quadrilateral. The owner hands in
 * the corners in CSS pixels of the stage; the camera view lets the overlay
 * draw both, the crop/rotate view draws its own outline (with the handles,
 * in frame-local coordinates) inside a group it appends. DOM: owns its
 * elements, no pointer events (`pointer-events` is none in the stylesheet).
 */

import type { Point } from './model';
import { svgEl } from './ui';

export interface FrameOverlayOptions {
  /** Class of the `<svg>` (`camera-frame`, `edit-overlay`). */
  svgClass: string;
  /** Class of the shade path (`camera-shade`, `edit-shade`). */
  shadeClass: string;
  /** Class of the outline polygon; without one the overlay draws no outline. */
  outlineClass?: string;
}

/** One CSS-pixel coordinate as the attributes carry it (a tenth of a pixel is invisible). */
const px = (value: number): string => value.toFixed(1);

export class FrameOverlay {
  readonly element: SVGSVGElement;

  private readonly shade: SVGPathElement;
  private readonly outline: SVGPolygonElement | null;
  /** The viewBox size, which the shade's outer rectangle covers. */
  private width = 0;
  private height = 0;

  constructor(options: FrameOverlayOptions) {
    this.element = svgEl('svg', { class: options.svgClass, 'aria-hidden': 'true' });
    this.shade = svgEl('path', { class: options.shadeClass, 'fill-rule': 'evenodd' });
    this.element.append(this.shade);
    this.outline = options.outlineClass ? svgEl('polygon', { class: options.outlineClass }) : null;
    if (this.outline) this.element.append(this.outline);
  }

  /** Further children drawn over the shade (and the outline). */
  append(...nodes: SVGElement[]): void {
    this.element.append(...nodes);
  }

  /** Matches the viewBox to the stage size in CSS pixels. */
  setViewBox(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.element.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  /** Shows or hides the whole overlay (the `hidden` attribute, which the stylesheet honours). */
  set visible(visible: boolean) {
    if (visible) this.element.removeAttribute('hidden');
    else this.element.setAttribute('hidden', '');
  }

  /** Draws the shade with a hole at the quadrilateral and the outline along it, from CSS-pixel corners. */
  render(corners: readonly Point[]): void {
    const outer = `M0 0H${this.width}V${this.height}H0Z`;
    const hole = corners.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)} ${px(p.y)}`).join('') + 'Z';
    this.shade.setAttribute('d', outer + hole);
    this.outline?.setAttribute('points', corners.map((p) => `${px(p.x)},${px(p.y)}`).join(' '));
  }
}
