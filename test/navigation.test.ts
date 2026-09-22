import { describe, expect, it, vi } from 'vitest';
import { BackTrap, type HistoryLike } from '../src/navigation';

function fakeHistory(): HistoryLike & { entries: number } {
  return {
    entries: 0,
    pushState() {
      this.entries += 1;
    },
    back() {
      this.entries -= 1;
    },
  };
}

describe('BackTrap', () => {
  it('pushes one entry when leaving the start page and pops it on return', () => {
    const history = fakeHistory();
    const trap = new BackTrap(() => {}, history);
    trap.setActive(true);
    trap.setActive(true);
    expect(history.entries).toBe(1);
    expect(trap.isArmed).toBe(true);
    trap.setActive(false);
    expect(history.entries).toBe(0);
    expect(trap.isArmed).toBe(false);
  });

  it('turns a user pop into an in-app back and lets the app re-arm', () => {
    const history = fakeHistory();
    const onBack = vi.fn(() => trap.setActive(true));
    const trap = new BackTrap(onBack, history);
    trap.setActive(true);
    history.entries -= 1; // the browser popped the entry
    trap.handlePop();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(history.entries).toBe(1);
    expect(trap.isArmed).toBe(true);
  });

  it('ignores the pop it requested itself', () => {
    const history = fakeHistory();
    const onBack = vi.fn();
    const trap = new BackTrap(onBack, history);
    trap.setActive(true);
    trap.setActive(false);
    trap.handlePop();
    expect(onBack).not.toHaveBeenCalled();
    expect(trap.isArmed).toBe(false);
  });

  it('ignores pops while disarmed', () => {
    const history = fakeHistory();
    const onBack = vi.fn();
    const trap = new BackTrap(onBack, history);
    trap.handlePop();
    expect(onBack).not.toHaveBeenCalled();
  });
});
