/**
 * Brightness/contrast/temperature/grayscale maths (v0.3). Pure functions, no DOM.
 *
 * The preview is the CSS filter chain
 *   brightness(b) contrast(c) url(#temperature) grayscale(1)
 * where the temperature step is an SVG feColorMatrix; the bake uses the same
 * chain on a 2D context where possible. The per-pixel formula here mirrors
 * the Filter Effects spec so the pixel-loop fallback matches the preview:
 * brightness is a linear transfer with slope b, contrast a linear transfer
 * with slope c and intercept 0.5 * (1 - c), temperature a per-channel gain
 * (red up and blue down for warm, the reverse for cool), grayscale the sRGB
 * luminance matrix. Each step clamps to [0, 1] as a filter primitive does.
 * Filters operate in sRGB; alpha is untouched.
 */

export interface Tone {
  /** 0.5 .. 1.5, neutral 1 */
  brightness: number;
  /** 0.5 .. 2.0, neutral 1 */
  contrast: number;
  /** -1 (cool) .. 1 (warm), neutral 0 */
  temperature: number;
  /** drop all colour */
  grayscale: boolean;
}

/** The values the slider can drive. */
export type ToneKey = 'brightness' | 'contrast' | 'temperature';

export const TONE_KEYS: readonly ToneKey[] = ['brightness', 'contrast', 'temperature'];

export interface ToneRange {
  min: number;
  max: number;
  neutral: number;
  step: number;
}

export const TONE_RANGES: Record<ToneKey, ToneRange> = {
  brightness: { min: 0.5, max: 1.5, neutral: 1, step: 0.01 },
  contrast: { min: 0.5, max: 2, neutral: 1, step: 0.01 },
  temperature: { min: -1, max: 1, neutral: 0, step: 0.02 },
};

/** Channel gain at full warm/cool: red and blue move by this fraction in opposite directions. */
export const TEMPERATURE_GAIN = 0.2;

/** sRGB luminance coefficients used by the CSS grayscale() filter. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

export const NEUTRAL_TONE: Readonly<Tone> = Object.freeze({
  brightness: 1,
  contrast: 1,
  temperature: 0,
  grayscale: false,
});

export function isNeutralTone(tone: Tone): boolean {
  return (
    tone.brightness === 1 && tone.contrast === 1 && tone.temperature === 0 && !tone.grayscale
  );
}

/** Clamps a value into its range and snaps values within half a step of neutral to neutral. */
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

/** Per-channel gains of the temperature step. */
export function temperatureGains(temperature: number): { r: number; g: number; b: number } {
  return {
    r: 1 + TEMPERATURE_GAIN * temperature,
    g: 1,
    b: 1 - TEMPERATURE_GAIN * temperature,
  };
}

/** The 4x5 feColorMatrix values of the temperature step, for the SVG filter in the preview. */
export function temperatureMatrix(temperature: number): string {
  const { r, g, b } = temperatureGains(temperature);
  return `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`;
}

/**
 * The CSS filter chain for the preview; empty string when neutral. The
 * temperature step references an SVG filter with the given id, which the
 * caller keeps in the document with `temperatureMatrix()` as its values.
 */
export function toneFilter(tone: Tone, temperatureFilterId?: string): string {
  const parts: string[] = [];
  if (tone.brightness !== 1) parts.push(`brightness(${tone.brightness})`);
  if (tone.contrast !== 1) parts.push(`contrast(${tone.contrast})`);
  if (tone.temperature !== 0 && temperatureFilterId) parts.push(`url(#${temperatureFilterId})`);
  if (tone.grayscale) parts.push('grayscale(1)');
  return parts.join(' ');
}

/** True when the whole chain can be expressed with CSS shorthand functions alone. */
export function toneUsesShorthandOnly(tone: Tone): boolean {
  return tone.temperature === 0;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Applies brightness, contrast and the temperature gain of one channel to a
 * value 0..255, returning the unrounded result 0..1.
 */
function channelTransfer(value: number, tone: Tone, gain: number): number {
  const v0 = value / 255;
  const v1 = clamp01(v0 * tone.brightness);
  const v2 = clamp01(v1 * tone.contrast + 0.5 * (1 - tone.contrast));
  return clamp01(v2 * gain);
}

/** Applies the per-channel steps (everything but grayscale) to one channel, rounded 0..255. */
export function applyToneToChannel(value: number, tone: Tone, channel: 'r' | 'g' | 'b' = 'g'): number {
  return Math.round(channelTransfer(value, tone, temperatureGains(tone.temperature)[channel]) * 255);
}

/** Applies the full chain to one pixel. */
export function applyToneToPixel(
  r: number,
  g: number,
  b: number,
  tone: Tone,
): [number, number, number] {
  const gains = temperatureGains(tone.temperature);
  let cr = channelTransfer(r, tone, gains.r);
  let cg = channelTransfer(g, tone, gains.g);
  let cb = channelTransfer(b, tone, gains.b);
  if (tone.grayscale) {
    const y = clamp01(LUMA.r * cr + LUMA.g * cg + LUMA.b * cb);
    cr = y;
    cg = y;
    cb = y;
  }
  return [Math.round(cr * 255), Math.round(cg * 255), Math.round(cb * 255)];
}

export interface ToneLookups {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

/** Lookup tables channel -> transferred value 0..1 for the per-channel steps. */
export function toneLookups(tone: Tone): ToneLookups {
  const gains = temperatureGains(tone.temperature);
  const make = (gain: number): Float32Array => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i += 1) lut[i] = channelTransfer(i, tone, gain);
    return lut;
  };
  return { r: make(gains.r), g: make(gains.g), b: make(gains.b) };
}

/**
 * Applies the tone in place to RGBA pixel data (the fallback for contexts
 * without `filter`). Alpha is left alone. `luts` may be passed to reuse the
 * tables across strips of a large image.
 */
export function applyTonePixels(data: Uint8ClampedArray, tone: Tone, luts = toneLookups(tone)): void {
  const { r: lr, g: lg, b: lb } = luts;
  if (tone.grayscale) {
    for (let i = 0; i < data.length; i += 4) {
      const y = LUMA.r * lr[data[i]!]! + LUMA.g * lg[data[i + 1]!]! + LUMA.b * lb[data[i + 2]!]!;
      const v = Math.round(clamp01(y) * 255);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.round(lr[data[i]!]! * 255);
      data[i + 1] = Math.round(lg[data[i + 1]!]! * 255);
      data[i + 2] = Math.round(lb[data[i + 2]!]! * 255);
    }
  }
}
