/**
 * Brightness/contrast maths (v0.3). Pure functions, no DOM.
 *
 * The preview is the CSS filter `brightness(b) contrast(c)`; the bake uses the
 * same filter on a 2D context where available. The per-channel formula here
 * mirrors the Filter Effects spec so the pixel-loop fallback matches the
 * preview: brightness is a linear transfer with slope b, contrast a linear
 * transfer with slope c and intercept 0.5 * (1 - c). Each step clamps to
 * [0, 1] as a filter primitive does. Filters operate in sRGB; alpha is untouched.
 */

export interface Tone {
  /** 0.5 .. 1.5, neutral 1 */
  brightness: number;
  /** 0.5 .. 2.0, neutral 1 */
  contrast: number;
}

export type ToneKey = keyof Tone;

export interface ToneRange {
  min: number;
  max: number;
  neutral: number;
  step: number;
}

export const TONE_RANGES: Record<ToneKey, ToneRange> = {
  brightness: { min: 0.5, max: 1.5, neutral: 1, step: 0.01 },
  contrast: { min: 0.5, max: 2, neutral: 1, step: 0.01 },
};

export const NEUTRAL_TONE: Readonly<Tone> = Object.freeze({ brightness: 1, contrast: 1 });

export function isNeutralTone(tone: Tone): boolean {
  return tone.brightness === 1 && tone.contrast === 1;
}

/** Clamps a value into its range and snaps values within one step of neutral to neutral. */
export function clampTone(key: ToneKey, value: number): number {
  const range = TONE_RANGES[key];
  if (!Number.isFinite(value)) return range.neutral;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return Math.abs(clamped - range.neutral) < range.step / 2 ? range.neutral : clamped;
}

/** Position of a value in its range as a fraction 0..1 (for the slider tick and fill). */
export function toneFraction(key: ToneKey, value: number): number {
  const range = TONE_RANGES[key];
  return (value - range.min) / (range.max - range.min);
}

/** The CSS filter for the preview and the canvas bake; empty string when neutral. */
export function toneFilter(tone: Tone): string {
  if (isNeutralTone(tone)) return '';
  return `brightness(${tone.brightness}) contrast(${tone.contrast})`;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Applies the filter formula to one colour channel given as 0..255, returning
 * the rounded result 0..255. Brightness first, then contrast, as in the
 * filter list `brightness(b) contrast(c)`.
 */
export function applyToneToChannel(value: number, tone: Tone): number {
  const v0 = value / 255;
  const v1 = clamp01(v0 * tone.brightness);
  const v2 = clamp01(v1 * tone.contrast + 0.5 * (1 - tone.contrast));
  return Math.round(v2 * 255);
}

/** Lookup table channel -> channel for a tone. */
export function toneLookup(tone: Tone): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) lut[i] = applyToneToChannel(i, tone);
  return lut;
}

/**
 * Applies the tone in place to RGBA pixel data (the fallback for contexts
 * without `filter`). Alpha is left alone. `lut` may be passed to reuse the
 * table across strips of a large image.
 */
export function applyTonePixels(data: Uint8ClampedArray, tone: Tone, lut = toneLookup(tone)): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]!]!;
    data[i + 1] = lut[data[i + 1]!]!;
    data[i + 2] = lut[data[i + 2]!]!;
  }
}
