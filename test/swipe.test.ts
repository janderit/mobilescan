import { describe, expect, it } from 'vitest';
import { SWIPE_MIN_DISTANCE, swipeDirection } from '../src/swipe';

describe('swipeDirection', () => {
  it('reads a long horizontal drag as a swipe', () => {
    expect(swipeDirection(-120, 10)).toBe('left');
    expect(swipeDirection(120, -10)).toBe('right');
  });

  it('ignores taps and short drags', () => {
    expect(swipeDirection(0, 0)).toBeNull();
    expect(swipeDirection(SWIPE_MIN_DISTANCE - 1, 0)).toBeNull();
    expect(swipeDirection(SWIPE_MIN_DISTANCE, 0)).toBe('right');
  });

  it('ignores drags that are mostly vertical', () => {
    expect(swipeDirection(60, 40)).toBeNull();
    expect(swipeDirection(-60, -100)).toBeNull();
    expect(swipeDirection(80, 40)).toBe('right');
  });
});
