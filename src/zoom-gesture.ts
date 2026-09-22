/**
 * The zoom gesture tracker shared by the captured stage, the crop/rotate
 * view and the brightness/contrast view: two tracked pointers for
 * the pinch, an optional one-finger pan while zoomed in, and the double tap.
 * Pointer Events only; the view forwards its pointer events and skips its
 * own handling when the tracker consumed one.
 *
 * During a gesture the tracker only sets a CSS transform on the wrapper
 * (relative to the zoom the canvas was last drawn with) and reports the
 * change; when the last finger lifts it resets the wrapper and asks the view
 * for a crisp redraw. The maths is in `zoom.ts`.
 */

import type { Point, Rect } from './geometry';
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_RADIUS,
  IDENTITY_ZOOM,
  TAP_SLOP,
  clampZoom,
  doubleTapZoom,
  isFittedZoom,
  panZoom,
  pinchZoom,
  relativeZoom,
  sameZoom,
  type ZoomState,
} from './zoom';

/** What the tracker needs to know about the view to clamp the zoom. */
export interface ZoomBounds {
  /** The content that must cover the stage, in fitted CSS pixels. */
  content: Rect;
  /** Largest useful scale (see `maxZoomScale`). */
  maxScale: number;
}

export interface ZoomGestureOptions {
  /** Receives the pointer events; its size is the stage size. */
  stage: HTMLElement;
  /** Gets the live CSS transform during a gesture. */
  wrapper: HTMLElement;
  /**
   * Whether one finger landing at `at` (stage CSS pixels) pans while zoomed
   * in. The captured and brightness/contrast views always pan; the crop/rotate
   * view pans in crop mode when the finger is clear of every handle, so the
   * handles keep priority. Also asked for the finger that remains after a
   * pinch.
   */
  oneFingerPan(at: Point): boolean;
  /** Current bounds; null while the view has nothing to show. */
  bounds(): ZoomBounds | null;
  /** The zoom takes over the pointers (pinch start, pan start, double tap): the view ends its own interaction. */
  onGestureStart(): void;
  /** The state changed during a gesture; the wrapper transform is already set. */
  onChange(): void;
  /** The gesture ended (or a double tap toggled): redraw crisply at `state`, then call `drawn()`. */
  onSettle(): void;
}

interface Tracked {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** False once a second finger joined: the lift is then never a tap. */
  solo: boolean;
}

type Mode = 'idle' | 'single' | 'pan' | 'pinch' | 'after-pinch';

export class ZoomGesture {
  /** The live zoom. */
  state: ZoomState = { ...IDENTITY_ZOOM };
  /** The zoom the stage canvas currently shows. */
  private drawnState: ZoomState = { ...IDENTITY_ZOOM };
  private readonly pointers = new Map<number, Tracked>();
  private mode: Mode = 'idle';
  private lastTap: { time: number; x: number; y: number } | null = null;

  constructor(private readonly options: ZoomGestureOptions) {}

  /** True while a pinch or pan holds the pointers. */
  get active(): boolean {
    return this.mode === 'pan' || this.mode === 'pinch' || this.mode === 'after-pinch';
  }

  get zoomed(): boolean {
    return !isFittedZoom(this.state);
  }

  /** Back to the fitted view, dropping any gesture in progress. Does not redraw. */
  reset(): void {
    this.state = { ...IDENTITY_ZOOM };
    this.drawnState = { ...IDENTITY_ZOOM };
    this.pointers.clear();
    this.mode = 'idle';
    this.lastTap = null;
    this.options.wrapper.style.transform = '';
  }

  /** The view has drawn its canvas at the current state. */
  drawn(): void {
    this.drawnState = { ...this.state };
    this.options.wrapper.style.transform = '';
  }

  /** Re-clamps after a layout change (stage size, fitted transform). Returns true when the state changed. */
  clamp(): boolean {
    const clamped = this.clamped(this.state);
    if (sameZoom(clamped, this.state)) return false;
    this.state = clamped;
    return true;
  }

  private clamped(z: ZoomState): ZoomState {
    const bounds = this.options.bounds();
    if (!bounds) return { ...IDENTITY_ZOOM };
    const { stage } = this.options;
    return clampZoom(z, bounds.content, stage.clientWidth, stage.clientHeight, bounds.maxScale);
  }

  private maxScale(): number {
    return this.options.bounds()?.maxScale ?? 1;
  }

  private stagePoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.options.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private capture(id: number): void {
    const { stage } = this.options;
    if (typeof stage.setPointerCapture !== 'function') return;
    try {
      stage.setPointerCapture(id);
    } catch {
      // The pointer is already gone; nothing to hold on to.
    }
  }

  private update(next: ZoomState): void {
    this.state = this.clamped(next);
    const live = relativeZoom(this.state, this.drawnState);
    this.options.wrapper.style.transform =
      sameZoom(live, IDENTITY_ZOOM) ? '' : `translate(${live.tx}px, ${live.ty}px) scale(${live.scale})`;
    this.options.onChange();
  }

  private settle(): void {
    this.mode = 'idle';
    if (sameZoom(this.state, this.drawnState)) {
      this.options.wrapper.style.transform = '';
      return;
    }
    this.options.onSettle();
  }

  // ---- pointer events, forwarded by the view -------------------------------

  /** Returns true when the zoom took the pointer; the view then ignores it. */
  pointerDown(event: PointerEvent): boolean {
    if (this.pointers.has(event.pointerId)) return this.active;
    if (this.pointers.size >= 2) return true; // a third finger does nothing
    const p = this.stagePoint(event);
    const tracked: Tracked = { id: event.pointerId, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false, solo: true };
    this.pointers.set(tracked.id, tracked);
    if (this.pointers.size === 2) {
      for (const other of this.pointers.values()) {
        other.solo = false;
        this.capture(other.id);
      }
      const wasActive = this.active;
      this.mode = 'pinch';
      if (!wasActive) this.options.onGestureStart();
      event.preventDefault();
      return true;
    }
    if (this.zoomed && this.options.oneFingerPan(p)) {
      this.mode = 'pan';
      this.capture(tracked.id);
      this.options.onGestureStart();
      event.preventDefault();
      return true;
    }
    this.mode = 'single';
    return false;
  }

  pointerMove(event: PointerEvent): boolean {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return false;
    const p = this.stagePoint(event);
    const previous = { x: tracked.x, y: tracked.y };
    tracked.x = p.x;
    tracked.y = p.y;
    if (Math.hypot(p.x - tracked.startX, p.y - tracked.startY) > TAP_SLOP) tracked.moved = true;
    switch (this.mode) {
      case 'pinch': {
        const [a, b] = [...this.pointers.values()] as [Tracked, Tracked];
        const from: [typeof previous, typeof previous] = [
          a.id === tracked.id ? previous : { x: a.x, y: a.y },
          b.id === tracked.id ? previous : { x: b.x, y: b.y },
        ];
        const to: [typeof previous, typeof previous] = [
          { x: a.x, y: a.y },
          { x: b.x, y: b.y },
        ];
        this.update(pinchZoom(this.state, from, to, this.maxScale()));
        event.preventDefault();
        return true;
      }
      case 'pan':
        this.update(panZoom(this.state, p.x - previous.x, p.y - previous.y));
        event.preventDefault();
        return true;
      case 'after-pinch':
        return true;
      default:
        return false;
    }
  }

  /** `pointerup` or `pointercancel`. */
  pointerEnd(event: PointerEvent): boolean {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return false;
    this.pointers.delete(event.pointerId);
    const p = this.stagePoint(event);
    tracked.x = p.x;
    tracked.y = p.y;
    if (Math.hypot(p.x - tracked.startX, p.y - tracked.startY) > TAP_SLOP) tracked.moved = true;
    const mode = this.mode;
    if (mode === 'pinch') {
      // The remaining finger pans, or waits until it lifts. It never starts a drag.
      const [remaining] = this.pointers.values();
      const pans = remaining !== undefined && this.zoomed && this.options.oneFingerPan({ x: remaining.x, y: remaining.y });
      this.mode = pans ? 'pan' : 'after-pinch';
      this.lastTap = null;
      return true;
    }
    const consumed = mode === 'pan' || mode === 'after-pinch';
    const tap = event.type !== 'pointercancel' && tracked.solo && !tracked.moved;
    if (tap && this.isDoubleTap(tracked, event)) {
      // The double tap: fitted <-> 3x at the tap. Only when there is room to zoom.
      const bounds = this.options.bounds();
      if (bounds && bounds.maxScale > 1) {
        if (!consumed) this.options.onGestureStart();
        this.update(doubleTapZoom(this.state, { x: tracked.x, y: tracked.y }, bounds.maxScale));
        this.settle();
        return true;
      }
    }
    if (!tap) this.lastTap = null;
    if (this.pointers.size === 0) this.settle();
    return consumed;
  }

  /** Records the tap and tells whether it completes a double tap. */
  private isDoubleTap(tracked: Tracked, event: PointerEvent): boolean {
    const now = event.timeStamp || Date.now();
    const last = this.lastTap;
    if (last && now - last.time <= DOUBLE_TAP_MS && Math.hypot(tracked.x - last.x, tracked.y - last.y) <= DOUBLE_TAP_RADIUS) {
      this.lastTap = null;
      return true;
    }
    this.lastTap = { time: now, x: tracked.x, y: tracked.y };
    return false;
  }
}
