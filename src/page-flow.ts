/**
 * The pixel work of the scan's pages behind the busy overlay: parking the
 * page that leaves the screen, waking the page that arrives, and baking a
 * confirmed frame or tone into the current page. Decides on its own whether
 * a bake is heavy enough for the spinner. The outcome is read from the page
 * (`image` present or not), so a failed step leaves it untouched; the app
 * shell decides what to show afterwards. Talks to `Scan` and `Overlays`
 * only; no DOM of its own.
 */

import type { Frame, Page } from './model';
import type { Scan } from './scan';
import type { Overlays } from './overlays';
import { applyCapture, asCapture } from './pages';
import { bakeFrame, bakeTone, frameNeedsBake } from './bake';
import { hasCornerOffsets } from './geometry';
import { isNeutralTone, type Tone } from './tone';

export class PageFlow {
  constructor(
    private readonly scan: Scan,
    private readonly overlays: Overlays,
  ) {}

  /**
   * Parks the current page (encodes and releases its canvas) behind the
   * overlay. False when parking failed: the page keeps its canvas and stays.
   */
  async parkCurrent(): Promise<boolean> {
    const page = this.scan.currentPage();
    if (!page) return true;
    await this.overlays.run(() => this.scan.park(page), 'Seite konnte nicht abgelegt werden');
    return page.image === null;
  }

  /**
   * Wakes the current page behind the overlay if it is parked. False when it
   * cannot be decoded: the page is lost and the caller drops the scan rather
   * than showing a blank view.
   */
  async wakeCurrent(): Promise<boolean> {
    const page = this.scan.currentPage();
    if (!page) return true;
    if (!page.image) {
      await this.overlays.run(() => this.scan.wake(page), 'Seite konnte nicht geladen werden');
    }
    return page.image !== null;
  }

  /** Makes the page at `index` current and wakes it; see `wakeCurrent` for the result. */
  switchTo(index: number): Promise<boolean> {
    this.scan.switchTo(index);
    return this.wakeCurrent();
  }

  /**
   * Bakes a confirmed frame into `page`: rotation and displaced corners
   * resample the image behind the overlay, a plain crop only updates the
   * frame. A failed bake leaves image and frame untouched and is logged
   * under `logLabel`.
   */
  async bakeFrame(
    page: Page,
    frame: Frame,
    logLabel = hasCornerOffsets(frame) ? 'Entzerren fehlgeschlagen' : 'Drehen fehlgeschlagen',
  ): Promise<void> {
    if (!page.image) return;
    await this.overlays.run(
      () => {
        applyCapture(page, bakeFrame(asCapture(page), frame));
      },
      logLabel,
      { overlay: frameNeedsBake(frame) },
    );
  }

  /** Bakes confirmed tone values into `page`; neutral values leave it alone. */
  async bakeTone(page: Page, tone: Tone): Promise<void> {
    if (!page.image) return;
    await this.overlays.run(
      () => {
        applyCapture(page, bakeTone(asCapture(page), tone));
      },
      'Anpassen fehlgeschlagen',
      { overlay: !isNeutralTone(tone) },
    );
  }
}
