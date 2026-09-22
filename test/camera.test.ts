import { describe, expect, it } from 'vitest';
import { cameraErrorKind } from '../src/camera';

describe('cameraErrorKind', () => {
  it('maps permission errors to denied', () => {
    expect(cameraErrorKind(new DOMException('no', 'NotAllowedError'))).toBe('denied');
    expect(cameraErrorKind(new DOMException('no', 'PermissionDeniedError'))).toBe('denied');
  });

  it('maps security errors to insecure', () => {
    expect(cameraErrorKind(new DOMException('http', 'SecurityError'))).toBe('insecure');
  });

  it('maps everything else to unavailable', () => {
    expect(cameraErrorKind(new DOMException('none', 'NotFoundError'))).toBe('unavailable');
    expect(cameraErrorKind(new DOMException('busy', 'NotReadableError'))).toBe('unavailable');
    expect(cameraErrorKind(new Error('x'))).toBe('unavailable');
    expect(cameraErrorKind('string')).toBe('unavailable');
  });
});
