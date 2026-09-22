/**
 * Cross-fade between the app's screens: the new screen fades in on top, the
 * old one stays underneath until the fade is over and is then hidden. Owns
 * the `entering`/`leaving` classes and the leave timers; the app tells it
 * which screen to show and learns through the hooks when a screen is entered
 * and when one has left the stage. DOM only, no app state.
 */

import { prefersReducedMotion } from './ui';

/** Cross-fade between screens; written to `--fade` on the app root so styles.css follows it. */
export const FADE_MS = 150;

export interface ScreenSwitcherHooks<S extends string> {
  /** A screen is about to fade in. */
  onEnter?(screen: S): void;
  /** A screen has faded out and is hidden. */
  onLeft?(screen: S): void;
}

export class ScreenSwitcher<S extends string> {
  private shownScreen: S;
  private readonly leaveTimers = new Map<S, ReturnType<typeof setTimeout>>();

  /** Hides every screen but `initial` and writes the fade duration to `root`. */
  constructor(
    root: HTMLElement,
    private readonly screens: Record<S, HTMLElement>,
    initial: S,
    private readonly hooks: ScreenSwitcherHooks<S> = {},
  ) {
    root.style.setProperty('--fade', `${FADE_MS}ms`);
    this.shownScreen = initial;
    for (const [name, screen] of Object.entries<HTMLElement>(screens)) {
      screen.hidden = name !== initial;
    }
  }

  /** The screen on top. */
  get shown(): S {
    return this.shownScreen;
  }

  /** Cross-fades to `to`; nothing happens when it is already shown. */
  show(to: S): void {
    const from = this.shownScreen;
    if (to === from) return;
    this.shownScreen = to;
    const fromEl = this.screens[from];
    const toEl = this.screens[to];
    const pending = this.leaveTimers.get(to);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.leaveTimers.delete(to);
    }
    toEl.hidden = false;
    this.hooks.onEnter?.(to);
    toEl.classList.remove('leaving');
    toEl.classList.add('entering');
    fromEl.classList.remove('entering');
    fromEl.classList.add('leaving');
    const delay = prefersReducedMotion() ? 0 : FADE_MS;
    const timer = setTimeout(() => {
      this.leaveTimers.delete(from);
      fromEl.classList.remove('leaving');
      fromEl.hidden = true;
      this.hooks.onLeft?.(from);
    }, delay);
    this.leaveTimers.set(from, timer);
  }

  /** Cancels pending leave timers. */
  dispose(): void {
    for (const timer of this.leaveTimers.values()) clearTimeout(timer);
    this.leaveTimers.clear();
  }
}
