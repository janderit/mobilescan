/**
 * The live detection's tracker: hysteresis and smoothing over successive
 * detection runs, so that a document counts as found only after agreeing
 * runs and survives single misses. Pure state, no DOM.
 */

import { mapQuad, type Quad } from './geometry';

/** Agreeing runs in a row before a document counts as found. */
export const HITS_TO_FIND = 3;
/** Misses in a row before a found document is lost. */
export const MISSES_TO_LOSE = 2;
/**
 * A run agrees with the tracked outline when no corner is further from it
 * than this fraction of the frame width. 3 % is about 80 px on a 2700 px
 * frame: a hand held still passes, a hand moving over the page does not.
 * A tighter tolerance lets hand tremor between runs keep the outline from
 * ever locking.
 */
export const AGREE_FRACTION = 0.03;
/** Weight of the newest run in the smoothed corners. */
export const SMOOTHING = 0.5;

export interface TrackerState {
  /** True while a document counts as found. */
  found: boolean;
  /** The smoothed corners (nw, ne, se, sw) while found, else null. */
  corners: Quad | null;
}

/**
 * Hysteresis and smoothing over successive detection runs: a hit that agrees
 * with the previous run counts towards `HITS_TO_FIND`; a run without a hit,
 * or a hit that disagrees, counts towards `MISSES_TO_LOSE`. The corners
 * reported while found are smoothed exponentially and reset on loss.
 */
export class DetectionTracker {
  private previous: Quad | null = null;
  private hits = 0;
  private misses = 0;
  private found = false;
  private smoothed: Quad | null = null;

  /** `tolerance` in the corners' pixel unit; `AGREE_FRACTION` of the frame width. */
  constructor(private readonly tolerance: number) {}

  /** Feeds one run: the detected frame's corners, or null for no document. */
  push(quad: Quad | null): TrackerState {
    // Compared with the smoothed outline while found (steadier than a single
    // run), else with the last hit; a miss keeps the last hit, so a hit after
    // a single miss can still agree with it.
    const reference = this.smoothed ?? this.previous;
    const agrees = quad !== null && reference !== null && quadsAgree(quad, reference, this.tolerance);
    if (quad !== null) this.previous = quad;
    this.hits = quad === null ? 0 : agrees ? this.hits + 1 : 1;
    if (agrees) {
      this.misses = 0;
      if (this.hits >= HITS_TO_FIND) this.found = true;
    } else {
      this.misses += 1;
      if (this.misses >= MISSES_TO_LOSE) {
        this.found = false;
        this.smoothed = null;
      }
    }
    if (this.found && quad !== null && agrees) {
      this.smoothed = this.smoothed ? lerpQuad(this.smoothed, quad, SMOOTHING) : quad;
    }
    return this.state();
  }

  state(): TrackerState {
    return { found: this.found, corners: this.found ? this.smoothed : null };
  }

  reset(): void {
    this.previous = null;
    this.hits = 0;
    this.misses = 0;
    this.found = false;
    this.smoothed = null;
  }
}

/** True when no corner of `a` is further than `tolerance` from the same corner of `b`. */
export function quadsAgree(a: Quad, b: Quad, tolerance: number): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y) > tolerance) return false;
  }
  return true;
}

function lerpQuad(from: Quad, to: Quad, t: number): Quad {
  return mapQuad(from, (p, i) => ({
    x: p.x + (to[i]!.x - p.x) * t,
    y: p.y + (to[i]!.y - p.y) * t,
  }));
}
