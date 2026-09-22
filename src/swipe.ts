/**
 * Horizontal swipe detection for the page navigation: a pointer drag
 * whose horizontal part dominates counts as a swipe; taps and vertical
 * gestures do not.
 */

/** Minimum horizontal travel in CSS pixels. */
export const SWIPE_MIN_DISTANCE = 48;

/** Horizontal travel must be at least this many times the vertical travel. */
export const SWIPE_MIN_RATIO = 2;

export type SwipeDirection = 'left' | 'right';

/** Direction of a drag from (dx, dy), or null when it is not a swipe. */
export function swipeDirection(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
  if (Math.abs(dx) < SWIPE_MIN_RATIO * Math.abs(dy)) return null;
  return dx < 0 ? 'left' : 'right';
}
