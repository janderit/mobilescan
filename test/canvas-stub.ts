/**
 * jsdom has no canvas backend. These stubs give the app a 2D context that
 * accepts every call, a `toBlob` that produces a (real, tiny) JPEG and a
 * `createImageBitmap` that decodes nothing, so page parking, waking, baking
 * and PDF building can be driven end to end.
 */
import { vi } from 'vitest';

/** A minimal valid baseline JPEG, 1 x 1 pixel. */
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export function tinyJpeg(): Uint8Array<ArrayBuffer> {
  const binary = atob(TINY_JPEG_BASE64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface CanvasStub {
  /** Number of `toBlob` calls so far. */
  readonly encodeCount: number;
  restore(): void;
}

function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = {
    canvas,
    fillStyle: '#000',
    filter: 'none',
    strokeStyle: '#000',
    lineWidth: 1,
    drawImage: () => {},
    fillRect: () => {},
    clearRect: () => {},
    setTransform: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    setLineDash: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: () => {},
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Installs the stubs; call `restore()` in afterEach. */
export function stubCanvas(): CanvasStub {
  let encodeCount = 0;
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = fakeContext(this);
        contexts.set(this, ctx);
      }
      return ctx;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
      encodeCount += 1;
      const bytes = tinyJpeg();
      setTimeout(() => callback(new Blob([bytes], { type: 'image/jpeg' })), 0);
    });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1, height: 1, close: () => {} }));
  return {
    get encodeCount() {
      return encodeCount;
    },
    restore() {
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}
