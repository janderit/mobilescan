// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scan } from '../src/scan';
import { newPage } from '../src/pages';
import { MAX_PAGES, type Page, type UprightFrame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';

const frame: UprightFrame = { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0 };

function page(): Page {
  const c = document.createElement('canvas');
  c.width = 3000;
  c.height = 4000;
  return newPage({ image: c, frame });
}

describe('scan', () => {
  let stub: CanvasStub;

  beforeEach(() => {
    stub = stubCanvas();
  });

  afterEach(() => {
    stub.restore();
  });

  it('starts empty and appends pages as current', () => {
    const scan = new Scan();
    expect(scan.count).toBe(0);
    expect(scan.currentPage()).toBeNull();
    expect(scan.currentCapture()).toBeNull();
    const a = page();
    const b = page();
    scan.add(a);
    scan.add(b);
    expect(scan.count).toBe(2);
    expect(scan.currentIndex).toBe(1);
    expect(scan.currentPage()).toBe(b);
    expect(scan.currentCapture()).toEqual({ image: b.image, frame });
    expect(scan.list).toEqual([a, b]);
  });

  it('removes the current page and shows the previous one', () => {
    const scan = new Scan();
    const pages = [page(), page(), page()];
    for (const p of pages) scan.add(p);
    const removed = pages[2]!;
    expect(scan.removeCurrent()).toBe(1);
    expect(scan.currentIndex).toBe(1);
    expect(scan.list).toEqual([pages[0], pages[1]]);
    expect(removed.image).toBeNull();
  });

  it('shows the next page when the first one is removed', () => {
    const scan = new Scan();
    const pages = [page(), page(), page()];
    for (const p of pages) scan.add(p);
    scan.switchTo(0);
    expect(scan.removeCurrent()).toBe(0);
    expect(scan.currentPage()).toBe(pages[1]);
    expect(scan.count).toBe(2);
  });

  it('parks and wakes pages, keeping one live canvas at most', async () => {
    const scan = new Scan();
    const a = page();
    scan.add(a);
    await scan.park(a);
    expect(scan.liveCanvasCount).toBe(0);
    expect(scan.currentCapture()).toBeNull();
    scan.add(page());
    expect(scan.liveCanvasCount).toBe(1);
    await scan.park(scan.currentPage()!);
    expect(scan.switchTo(0)).toBe(a);
    await scan.wake(a);
    expect(scan.liveCanvasCount).toBe(1);
    expect(a.image?.width).toBe(3000);
  });

  it('reports the soft limit and discards everything', () => {
    const scan = new Scan();
    for (let i = 0; i < MAX_PAGES; i += 1) scan.add(page());
    expect(scan.isFull).toBe(true);
    const pages = [...scan.list];
    scan.discard();
    expect(scan.count).toBe(0);
    expect(scan.currentIndex).toBe(0);
    expect(scan.isFull).toBe(false);
    expect(pages.every((p) => p.image === null && p.blob === null)).toBe(true);
  });
});
