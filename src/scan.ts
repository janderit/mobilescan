/**
 * The scan in progress: the list of pages in capture order and which
 * one is on screen. Only the current page holds a full-resolution canvas; the
 * others are parked as JPEG blobs (`pages.ts`). Pure bookkeeping, no DOM: the
 * app shell decides when to show the busy overlay and how to report failures.
 */

import { MAX_PAGES, type Capture, type Page } from './model';
import { asCapture, parkPage, releasePage, wakePage } from './pages';

export class Scan {
  /** Pages in capture order; empty outside a scan. */
  private readonly pages: Page[] = [];
  /** Index of the page on screen. */
  private current = 0;

  /** Number of pages. */
  get count(): number {
    return this.pages.length;
  }

  /** Index of the page on screen. */
  get currentIndex(): number {
    return this.current;
  }

  /** Read-only view of the pages, for the share code and the tests. */
  get list(): readonly Page[] {
    return this.pages;
  }

  /** Pages holding a full-resolution canvas; must never exceed one. */
  get liveCanvasCount(): number {
    return this.pages.filter((page) => page.image !== null).length;
  }

  /** True at the soft page limit; [+] is disabled then. */
  get isFull(): boolean {
    return this.pages.length >= MAX_PAGES;
  }

  currentPage(): Page | null {
    return this.pages[this.current] ?? null;
  }

  /** The current page as a capture; null when it is parked or absent. */
  currentCapture(): Capture | null {
    const page = this.currentPage();
    return page?.image ? asCapture(page) : null;
  }

  /** Appends a page and makes it current. */
  add(page: Page): void {
    this.pages.push(page);
    this.current = this.pages.length - 1;
  }

  /**
   * Removes and releases the current page. The previous page becomes
   * current, or the next one if the first page was removed; returns its index.
   */
  removeCurrent(): number {
    const [removed] = this.pages.splice(this.current, 1);
    if (removed) releasePage(removed);
    this.current = Math.max(0, this.current - 1);
    return this.current;
  }

  /** Makes the page at `index` current without touching its canvas. */
  switchTo(index: number): Page | null {
    this.current = index;
    return this.currentPage();
  }

  /** Parks a page (encodes and releases its canvas); throws when encoding fails. */
  park(page: Page): Promise<void> {
    return parkPage(page);
  }

  /** Wakes a parked page into a canvas; throws when decoding fails. */
  wake(page: Page): Promise<void> {
    return wakePage(page);
  }

  /** Drops every page; nothing is retained. */
  discard(): void {
    for (const page of this.pages) releasePage(page);
    this.pages.length = 0;
    this.current = 0;
  }
}
