// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareFile } from '../src/share';

const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shareFile', () => {
  it('downloads when the browser cannot share files', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    const createUrl = vi.fn(() => 'blob:test');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('scan.pdf');
      expect(this.href).toBe('blob:test');
    });

    await expect(shareFile(file)).resolves.toBe('shared');
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('reports a user abort of the share sheet', async () => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      configurable: true,
    });
    await expect(shareFile(file)).resolves.toBe('aborted');
  });

  it('rethrows other share failures', async () => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: () => Promise.reject(new TypeError('boom')),
      configurable: true,
    });
    await expect(shareFile(file)).rejects.toThrow('boom');
  });
});
