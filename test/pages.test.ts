// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCapture, asCapture, newPage, parkPage, releasePage, wakePage } from '../src/pages';
import { stubCanvas, type CanvasStub } from './canvas-stub';
import type { Frame } from '../src/model';

const frame: Frame = { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0 };

function canvas(width = 3000, height = 4000): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

describe('page store', () => {
  let stub: CanvasStub;

  beforeEach(() => {
    stub = stubCanvas();
  });

  afterEach(() => {
    stub.restore();
  });

  it('parks a fresh page by encoding it once and releasing the canvas', async () => {
    const image = canvas();
    const page = newPage({ image, frame });
    expect(page.blob).toBeNull();
    await parkPage(page);
    expect(stub.encodeCount).toBe(1);
    expect(page.image).toBeNull();
    expect(page.blob).not.toBeNull();
    expect(image.width).toBe(0);
    expect(page.width).toBe(3000);
    expect(page.height).toBe(4000);
  });

  it('wakes into a canvas of the full size and keeps the blob', async () => {
    const page = newPage({ image: canvas(), frame });
    await parkPage(page);
    const blob = page.blob;
    await wakePage(page);
    expect(page.image?.width).toBe(3000);
    expect(page.image?.height).toBe(4000);
    expect(page.blob).toBe(blob);
  });

  it('does not re-encode an unchanged page on repeated parking', async () => {
    const page = newPage({ image: canvas(), frame });
    for (let i = 0; i < 10; i += 1) {
      await parkPage(page);
      await wakePage(page);
    }
    expect(stub.encodeCount).toBe(1);
  });

  it('re-encodes after a bake, but not after a crop', async () => {
    const page = newPage({ image: canvas(), frame });
    await parkPage(page);
    await wakePage(page);
    const cropped = { ...frame, width: 1000 };
    applyCapture(page, { image: page.image!, frame: cropped });
    expect(page.dirty).toBe(false);
    expect(page.frame).toEqual(cropped);
    await parkPage(page);
    expect(stub.encodeCount).toBe(1);

    await wakePage(page);
    const baked = canvas(4000, 3000);
    applyCapture(page, { image: baked, frame });
    expect(page.dirty).toBe(true);
    expect(page.width).toBe(4000);
    expect(page.height).toBe(3000);
    await parkPage(page);
    expect(stub.encodeCount).toBe(2);
    expect(page.dirty).toBe(false);
  });

  it('exposes a live page as a capture and refuses a parked one', async () => {
    const image = canvas();
    const page = newPage({ image, frame });
    expect(asCapture(page)).toEqual({ image, frame });
    await parkPage(page);
    expect(() => asCapture(page)).toThrow('parked');
  });

  it('releases both the canvas and the blob', async () => {
    const page = newPage({ image: canvas(), frame });
    await parkPage(page);
    await wakePage(page);
    releasePage(page);
    expect(page.image).toBeNull();
    expect(page.blob).toBeNull();
  });
});
