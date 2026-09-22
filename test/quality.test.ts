import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_LEVELS,
  DEFAULT_COMPRESSION,
  JPEG_QUALITY,
  jpegQuality,
} from '../src/quality';

describe('compression levels', () => {
  it('maps the three levels to the specified JPEG qualities', () => {
    expect(JPEG_QUALITY).toEqual({ small: 0.5, medium: 0.75, large: 0.92 });
    expect(jpegQuality('small')).toBe(0.5);
    expect(jpegQuality('medium')).toBe(0.75);
    expect(jpegQuality('large')).toBe(0.92);
  });

  it('lists the levels small to large, as the segmented control shows them', () => {
    expect(COMPRESSION_LEVELS).toEqual(['small', 'medium', 'large']);
    const qualities = COMPRESSION_LEVELS.map(jpegQuality);
    expect(qualities).toEqual([...qualities].sort((a, b) => a - b));
  });

  it('preselects medium', () => {
    expect(DEFAULT_COMPRESSION).toBe('medium');
    expect(COMPRESSION_LEVELS).toContain(DEFAULT_COMPRESSION);
  });
});
