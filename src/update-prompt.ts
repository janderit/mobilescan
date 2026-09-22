/**
 * The start page's update prompt: asks the `UpdateChecker` for a newer build
 * on request, throttled, and remembers the answer until the update is
 * applied. The shell decides when to check (start page shown or visible
 * again), re-renders on `onChange` and runs `apply` behind its busy overlay.
 */

import type { UpdateChecker } from './update';

/** Minimum time between two update checks, so returning to the start page repeatedly stays cheap. */
export const UPDATE_CHECK_INTERVAL_MS = 60_000;

export class UpdatePrompt {
  private updateAvailable = false;
  private checking = false;
  private lastCheck = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly updates: UpdateChecker | null,
    private readonly onChange: () => void,
  ) {}

  /** True with a checker; without one nothing can be checked or applied. */
  get enabled(): boolean {
    return this.updates !== null;
  }

  /** Whether the server has a build other than the running one. */
  get available(): boolean {
    return this.updateAvailable;
  }

  /**
   * Asks the server for a newer build, at most once a minute and only while
   * online (the checker treats offline and failures as "no update"). Once an
   * update is known, it stays known until it is applied.
   */
  check(): void {
    if (!this.updates || this.updateAvailable || this.checking) return;
    const now = Date.now();
    if (now - this.lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    this.checking = true;
    this.updates.check().then(
      (available) => {
        this.checking = false;
        if (!available) return;
        this.updateAvailable = true;
        this.onChange();
      },
      () => {
        this.checking = false;
      },
    );
  }

  /** Activates the new build; the page reloads on success, so this rejects or never resolves. */
  apply(): Promise<void> {
    if (!this.updates) return Promise.resolve();
    return this.updates.apply();
  }
}
