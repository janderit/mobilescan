import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_TONE,
  TONE_RANGES,
  applyToneToChannel,
  applyTonePixels,
  clampTone,
  isNeutralTone,
  toneFilter,
  toneFraction,
  toneLookup,
  type Tone,
} from '../src/tone';

/**
 * Reference implementation of the Filter Effects formula (slope * v + intercept
 * per primitive), independent of the LUT path. Rounding at exact half levels may
 * differ by one between floating-point orderings, as it does between browsers.
 */
function reference(value: number, tone: Tone): number {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const b = clamp(tone.brightness * (value / 255));
  const c = clamp(tone.contrast * b + (-0.5 * tone.contrast + 0.5));
  return Math.round(c * 255);
}

function expectWithinOneLevel(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

describe('tone ranges', () => {
  it('neutral is 1 for both values and inside the ranges', () => {
    expect(isNeutralTone(NEUTRAL_TONE)).toBe(true);
    for (const range of Object.values(TONE_RANGES)) {
      expect(range.neutral).toBe(1);
      expect(range.min).toBeLessThan(range.neutral);
      expect(range.max).toBeGreaterThan(range.neutral);
    }
  });

  it('clamps into the range and snaps near-neutral values to neutral', () => {
    expect(clampTone('brightness', 3)).toBe(1.5);
    expect(clampTone('contrast', 0)).toBe(0.5);
    expect(clampTone('contrast', 1.004)).toBe(1);
    expect(clampTone('brightness', 0.7)).toBe(0.7);
    expect(clampTone('brightness', Number.NaN)).toBe(1);
  });

  it('places the neutral tick at the middle for brightness and a third for contrast', () => {
    expect(toneFraction('brightness', 1)).toBeCloseTo(0.5, 12);
    expect(toneFraction('contrast', 1)).toBeCloseTo(1 / 3, 12);
    expect(toneFraction('contrast', 2)).toBe(1);
  });
});

describe('toneFilter', () => {
  it('is empty for neutral values so the preview shows the raw image', () => {
    expect(toneFilter(NEUTRAL_TONE)).toBe('');
  });

  it('lists brightness before contrast', () => {
    expect(toneFilter({ brightness: 1.2, contrast: 0.8 })).toBe('brightness(1.2) contrast(0.8)');
  });
});

describe('applyToneToChannel', () => {
  it('is the identity at neutral', () => {
    for (let v = 0; v < 256; v += 1) expect(applyToneToChannel(v, NEUTRAL_TONE)).toBe(v);
  });

  it('brightness scales linearly and clamps', () => {
    expect(applyToneToChannel(100, { brightness: 0.5, contrast: 1 })).toBe(50);
    expect(applyToneToChannel(200, { brightness: 1.5, contrast: 1 })).toBe(255);
    expect(applyToneToChannel(0, { brightness: 1.5, contrast: 1 })).toBe(0);
  });

  it('contrast pivots around mid grey', () => {
    const c2: Tone = { brightness: 1, contrast: 2 };
    // 128/255 is just above mid grey, so doubling the distance adds one level.
    expect(applyToneToChannel(128, c2)).toBe(129);
    expect(applyToneToChannel(64, c2)).toBe(0);
    expect(applyToneToChannel(190, c2)).toBe(253);
    expect(applyToneToChannel(255, c2)).toBe(255);
    const c05: Tone = { brightness: 1, contrast: 0.5 };
    expect(applyToneToChannel(0, c05)).toBe(64);
    expect(applyToneToChannel(255, c05)).toBe(191);
  });

  it('applies brightness before contrast', () => {
    // 200 -> brightness 0.5 -> 0.392 -> contrast 2 -> 0.284 -> 72.5 -> 73.
    // Contrast first would clamp: 200 -> 1.0 -> brightness 0.5 -> 0.5 -> 128.
    expect(applyToneToChannel(200, { brightness: 0.5, contrast: 2 })).toBe(73);
  });
});

describe('applyTonePixels (fallback loop)', () => {
  const tones: Tone[] = [
    { brightness: 0.5, contrast: 1 },
    { brightness: 1.5, contrast: 1 },
    { brightness: 1, contrast: 0.5 },
    { brightness: 1, contrast: 2 },
    { brightness: 1.3, contrast: 1.7 },
    { brightness: 0.6, contrast: 0.9 },
  ];

  function smallImage(): Uint8ClampedArray {
    // 8 x 4 RGBA gradient with varied alpha.
    const data = new Uint8ClampedArray(8 * 4 * 4);
    for (let i = 0; i < 32; i += 1) {
      data[i * 4] = i * 8;
      data[i * 4 + 1] = 255 - i * 8;
      data[i * 4 + 2] = (i * 37) % 256;
      data[i * 4 + 3] = i % 2 === 0 ? 255 : 100 + i;
    }
    return data;
  }

  it('matches the filter formula per channel and leaves alpha alone', () => {
    for (const tone of tones) {
      const before = smallImage();
      const data = smallImage();
      applyTonePixels(data, tone);
      for (let i = 0; i < data.length; i += 4) {
        expectWithinOneLevel(data[i]!, reference(before[i]!, tone));
        expectWithinOneLevel(data[i + 1]!, reference(before[i + 1]!, tone));
        expectWithinOneLevel(data[i + 2]!, reference(before[i + 2]!, tone));
        expect(data[i + 3]).toBe(before[i + 3]);
      }
    }
  });

  it('neutral values leave the pixels bit-identical', () => {
    const before = smallImage();
    const data = smallImage();
    applyTonePixels(data, { ...NEUTRAL_TONE });
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('a shared lookup table gives the same result as a fresh one', () => {
    const tone = tones[4]!;
    const lut = toneLookup(tone);
    const a = smallImage();
    const b = smallImage();
    applyTonePixels(a, tone, lut);
    applyTonePixels(b, tone);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
