/**
 * The overlays above every screen: the busy spinner and the brief icon-only
 * error notice. `run` is the one place work goes behind the spinner: it shows
 * the overlay, waits for it to paint, runs the work, and on failure logs it
 * and shows the notice. `busy` is the single source of truth for "nothing may
 * be interrupted"; the app re-renders on every change through `onChange`.
 * DOM only, no app state.
 */

import * as icons from './icons';
import { afterPaint, el } from './ui';

/** How long the icon-only error notice stays on screen. */
export const NOTICE_MS = 2000;

export interface RunOptions {
  /**
   * Show the spinner while the work runs. Off for work that is not heavy
   * (nothing to wait for, no flicker).
   */
  overlay?: boolean;
  /**
   * Defer the work until the spinner has painted, otherwise it never appears
   * before synchronous pixel work. Off for work that yields on its own.
   */
  paint?: boolean;
}

export class Overlays {
  readonly busyElement: HTMLElement;
  readonly noticeElement: HTMLElement;

  private busyFlag = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: () => void) {
    this.busyElement = el('div', 'busy');
    this.busyElement.innerHTML = icons.spinner;
    this.busyElement.setAttribute('role', 'status');
    this.busyElement.setAttribute('aria-label', 'Bitte warten');
    this.busyElement.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    this.busyElement.hidden = true;

    this.noticeElement = el('div', 'notice');
    this.noticeElement.innerHTML = icons.warning;
    this.noticeElement.setAttribute('role', 'alert');
    this.noticeElement.setAttribute('aria-label', 'Fehler');
    this.noticeElement.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    this.noticeElement.hidden = true;
  }

  /** True while work runs behind the spinner. */
  get busy(): boolean {
    return this.busyFlag;
  }

  /** Shows the warning icon briefly over the current view. */
  showNotice(): void {
    this.noticeElement.hidden = false;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeElement.hidden = true;
      this.noticeTimer = null;
    }, NOTICE_MS);
  }

  /** Logs a failure under its label and shows the notice. */
  fail(logLabel: string, error: unknown): void {
    console.error(logLabel, error);
    this.showNotice();
  }

  /**
   * Runs `work`, by default behind the spinner and only once it has painted.
   * Resolves with the work's result, or `undefined` when it threw (logged
   * under `logLabel`, notice shown). The caller checks the outcome.
   */
  async run<T>(work: () => T | Promise<T>, logLabel: string, options: RunOptions = {}): Promise<T | undefined> {
    const { overlay = true, paint = true } = options;
    if (!overlay) {
      try {
        return await work();
      } catch (error) {
        this.fail(logLabel, error);
        return undefined;
      }
    }
    this.setBusy(true);
    if (paint) await afterPaint();
    try {
      return await work();
    } catch (error) {
      this.fail(logLabel, error);
      return undefined;
    } finally {
      this.setBusy(false);
    }
  }

  /** Clears the notice timer. */
  dispose(): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private setBusy(busy: boolean): void {
    this.busyFlag = busy;
    this.busyElement.hidden = !busy;
    this.onChange();
  }
}
