import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_TONE,
  TEMPERATURE_GAIN,
  TONE_KEYS,
  TONE_RANGES,
  applyToneToChannel,
  applyToneToPixel,
  applyTonePixels,
  clampTone,
  isNeutralTone,
  temperatureGains,
  temperatureMatrix,
  toneFilter,
  toneFraction,
  toneFromFraction,
  toneLookups,
  toneUsesShorthandOnly,
  type Tone,
} from '../src/tone';

const tone = (overrides: Partial<Tone> = {}): Tone => ({ ...NEUTRAL_TONE, ...overrides });

/**
 * Reference implementation of the Filter Effects chain (slope * v + intercept
 * per primitive, colour matrix, luminance), independent of the LUT path.
 * Rounding at exact half levels may differ by one between floating-point
 * orderings, as it does between browsers.
 */
function reference(r: number, g: number, b: number, t: Tone): [number, number, number] {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const step = (v: number, gain: number): number => {
    const b1 = clamp(t.brightness * (v / 255));
    const c1 = clamp(t.contrast * b1 + (-0.5 * t.contrast + 0.5));
    return clamp(gain * c1);
  };
  let cr = step(r, 1 + TEMPERATURE_GAIN * t.temperature);
  let cg = step(g, 1);
  let cb = step(b, 1 - TEMPERATURE_GAIN * t.temperature);
  if (t.grayscale) {
    const y = clamp(0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
    cr = y;
    cg = y;
    cb = y;
  }
  return [Math.round(cr * 255), Math.round(cg * 255), Math.round(cb * 255)];
}

function expectWithinOneLevel(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

describe('tone ranges', () => {
  it('neutral values sit inside their ranges', () => {
    expect(isNeutralTone(NEUTRAL_TONE)).toBe(true);
    for (const key of TONE_KEYS) {
      const range = TONE_RANGES[key];
      expect(range.min).toBeLessThan(range.neutral);
      expect(range.max).toBeGreaterThan(range.neutral);
      expect(NEUTRAL_TONE[key]).toBe(range.neutral);
    }
  });

  it('grayscale alone is not neutral', () => {
    expect(isNeutralTone(tone({ grayscale: true }))).toBe(false);
  });

  it('clamps into the range and snaps near-neutral values to neutral', () => {
    expect(clampTone('brightness', 3)).toBe(1.5);
    expect(clampTone('contrast', 0)).toBe(0.5);
    expect(clampTone('contrast', 1.004)).toBe(1);
    expect(clampTone('brightness', 0.7)).toBe(0.7);
    expect(clampTone('temperature', -2)).toBe(-1);
    expect(clampTone('temperature', 0.005)).toBe(0);
    expect(clampTone('brightness', Number.NaN)).toBe(1);
  });

  it('places the neutral tick in the middle for every value (piecewise-linear, v0.8)', () => {
    expect(toneFraction('brightness', 1)).toBeCloseTo(0.5, 12);
    expect(toneFraction('temperature', 0)).toBeCloseTo(0.5, 12);
    expect(toneFraction('contrast', 1)).toBeCloseTo(0.5, 12);
    expect(toneFraction('contrast', 0.5)).toBe(0);
    expect(toneFraction('contrast', 4)).toBe(1);
    expect(toneFraction('contrast', 2.5)).toBeCloseTo(0.75, 12);
    expect(toneFraction('contrast', 0.75)).toBeCloseTo(0.25, 12);
  });

  it('widens contrast to 0.5 .. 4.0', () => {
    expect(TONE_RANGES.contrast.max).toBe(4);
    expect(clampTone('contrast', 3.5)).toBe(3.5);
    expect(clampTone('contrast', 9)).toBe(4);
  });

  it('maps slider positions back to values, neutral at the centre and the ends at the range', () => {
    for (const key of TONE_KEYS) {
      const range = TONE_RANGES[key];
      expect(toneFromFraction(key, 0)).toBe(range.min);
      expect(toneFromFraction(key, 0.5)).toBe(range.neutral);
      expect(toneFromFraction(key, 1)).toBe(range.max);
      for (const f of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
        const value = toneFromFraction(key, f);
        expect(Math.abs(toneFraction(key, value) - f)).toBeLessThan(0.01);
      }
    }
    expect(toneFromFraction('contrast', 0.75)).toBeCloseTo(2.5, 6);
    expect(toneFromFraction('contrast', 0.25)).toBeCloseTo(0.75, 6);
  });
});

describe('toneFilter', () => {
  it('is empty for neutral values so the preview shows the raw image', () => {
    expect(toneFilter(NEUTRAL_TONE, 'temp')).toBe('');
  });

  it('lists brightness, contrast, temperature and grayscale in that order', () => {
    expect(toneFilter(tone({ brightness: 1.2, contrast: 0.8, temperature: 0.5, grayscale: true }), 'temp')).toBe(
      'brightness(1.2) contrast(0.8) url(#temp) grayscale(1)',
    );
  });

  it('omits neutral steps', () => {
    expect(toneFilter(tone({ contrast: 1.5 }), 'temp')).toBe('contrast(1.5)');
    expect(toneFilter(tone({ grayscale: true }), 'temp')).toBe('grayscale(1)');
  });

  it('only a non-neutral temperature needs the SVG filter', () => {
    expect(toneUsesShorthandOnly(tone({ brightness: 1.3, grayscale: true }))).toBe(true);
    expect(toneUsesShorthandOnly(tone({ temperature: 0.1 }))).toBe(false);
  });
});

describe('temperature', () => {
  it('warm raises red and lowers blue, cool the reverse, green untouched', () => {
    const warm = temperatureGains(1);
    expect(warm.r).toBeCloseTo(1 + TEMPERATURE_GAIN, 12);
    expect(warm.g).toBe(1);
    expect(warm.b).toBeCloseTo(1 - TEMPERATURE_GAIN, 12);
    const cool = temperatureGains(-1);
    expect(cool.r).toBeCloseTo(1 - TEMPERATURE_GAIN, 12);
    expect(cool.b).toBeCloseTo(1 + TEMPERATURE_GAIN, 12);
  });

  it('neutral gives the identity colour matrix', () => {
    expect(temperatureMatrix(0).split(/\s+/).map(Number)).toEqual([
      1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
    ]);
  });

  it('a yellow cast on white paper is reduced by cooling', () => {
    const [r, g, b] = applyToneToPixel(250, 240, 200, tone({ temperature: -0.6 }));
    expect(r).toBeLessThan(250);
    expect(g).toBe(240);
    expect(b).toBeGreaterThan(200);
  });
});

describe('applyToneToChannel', () => {
  it('is the identity at neutral', () => {
    for (let v = 0; v < 256; v += 1) expect(applyToneToChannel(v, NEUTRAL_TONE)).toBe(v);
  });

  it('brightness scales linearly and clamps', () => {
    expect(applyToneToChannel(100, tone({ brightness: 0.5 }))).toBe(50);
    expect(applyToneToChannel(200, tone({ brightness: 1.5 }))).toBe(255);
    expect(applyToneToChannel(0, tone({ brightness: 1.5 }))).toBe(0);
  });

  it('contrast pivots around mid grey', () => {
    const c2 = tone({ contrast: 2 });
    // 128/255 is just above mid grey, so doubling the distance adds one level.
    expect(applyToneToChannel(128, c2)).toBe(129);
    expect(applyToneToChannel(64, c2)).toBe(0);
    expect(applyToneToChannel(190, c2)).toBe(253);
    expect(applyToneToChannel(255, c2)).toBe(255);
    const c05 = tone({ contrast: 0.5 });
    expect(applyToneToChannel(0, c05)).toBe(64);
    expect(applyToneToChannel(255, c05)).toBe(191);
  });

  it('applies brightness before contrast', () => {
    // 200 -> brightness 0.5 -> 0.392 -> contrast 2 -> 0.284 -> 72.5 -> 73.
    // Contrast first would clamp: 200 -> 1.0 -> brightness 0.5 -> 0.5 -> 128.
    expect(applyToneToChannel(200, tone({ brightness: 0.5, contrast: 2 }))).toBe(73);
  });
});

describe('applyToneToPixel', () => {
  it('grayscale uses the sRGB luminance weights', () => {
    expect(applyToneToPixel(255, 0, 0, tone({ grayscale: true }))).toEqual([54, 54, 54]);
    expect(applyToneToPixel(0, 255, 0, tone({ grayscale: true }))).toEqual([182, 182, 182]);
    expect(applyToneToPixel(0, 0, 255, tone({ grayscale: true }))).toEqual([18, 18, 18]);
    expect(applyToneToPixel(200, 200, 200, tone({ grayscale: true }))).toEqual([200, 200, 200]);
  });
});

describe('applyTonePixels (fallback loop)', () => {
  const tones: Tone[] = [
    tone({ brightness: 0.5 }),
    tone({ brightness: 1.5 }),
    tone({ contrast: 0.5 }),
    tone({ contrast: 2 }),
    tone({ brightness: 1.3, contrast: 1.7 }),
    tone({ brightness: 0.6, contrast: 0.9 }),
    tone({ temperature: 1 }),
    tone({ temperature: -0.7, contrast: 1.4 }),
    tone({ grayscale: true }),
    tone({ brightness: 1.2, contrast: 1.5, temperature: 0.4, grayscale: true }),
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

  it('matches the filter chain per pixel and leaves alpha alone', () => {
    for (const t of tones) {
      const before = smallImage();
      const data = smallImage();
      applyTonePixels(data, t);
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = reference(before[i]!, before[i + 1]!, before[i + 2]!, t);
        expectWithinOneLevel(data[i]!, r);
        expectWithinOneLevel(data[i + 1]!, g);
        expectWithinOneLevel(data[i + 2]!, b);
        expect(data[i + 3]).toBe(before[i + 3]);
      }
    }
  });

  it('grayscale output has equal channels', () => {
    const data = smallImage();
    applyTonePixels(data, tone({ grayscale: true, temperature: 0.5 }));
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i + 1]).toBe(data[i]);
      expect(data[i + 2]).toBe(data[i]);
    }
  });

  it('neutral values leave the pixels bit-identical', () => {
    const before = smallImage();
    const data = smallImage();
    applyTonePixels(data, tone());
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('shared lookup tables give the same result as fresh ones', () => {
    const t = tones[7]!;
    const luts = toneLookups(t);
    const a = smallImage();
    const b = smallImage();
    applyTonePixels(a, t, luts);
    applyTonePixels(b, t);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
