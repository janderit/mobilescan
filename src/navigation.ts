/**
 * Keeps the hardware back button and the swipe-back gesture inside the app.
 *
 * While the app is away from the start page, exactly one extra history entry
 * is kept on the stack. A `popstate` that removes it is turned into an
 * in-app back action; the app then re-arms the trap if it is still away from
 * the start page. Returning to the start page in-app pops the entry silently.
 */

export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  back(): void;
}

export class BackTrap {
  private armed = false;
  /** Number of pops the app itself requested and that must not count as user back. */
  private pendingSilentPops = 0;

  constructor(
    private readonly onBack: () => void,
    private readonly history: HistoryLike,
  ) {}

  /** Whether the extra entry is currently on the stack. */
  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Keeps the trap in sync with the app: armed while away from the start
   * page, disarmed on it. Call after every state change.
   */
  setActive(active: boolean): void {
    if (active && !this.armed) {
      this.history.pushState({ mobilescan: true }, '');
      this.armed = true;
    } else if (!active && this.armed) {
      this.armed = false;
      this.pendingSilentPops += 1;
      this.history.back();
    }
  }

  /** Handler for the window `popstate` event. */
  handlePop(): void {
    if (this.pendingSilentPops > 0) {
      this.pendingSilentPops -= 1;
      return;
    }
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.onBack();
  }
}
