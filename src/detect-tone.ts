/**
 * Tone detection: a luminance histogram of the inner 90 % of the frame
 * region, the paper background (the mode above 0.4) and the print (the 1st
 * percentile) read from it, and the brightness and contrast that make the
 * tone filter chain map the background to white and the print to black.
 * Pure maths on `ImageData`; the tone view renders the working copy.
 */

import type { Frame } from './model';
import { luminance } from './color';
import { clampTone, type Tone } from './tone';
import { workingLayout, type WorkingLayout } from './detect-edges';

/** Longer side of the working image for tone detection, in pixels. */
export const TONE_LONG_SIDE = 500;
/** Fraction of the frame region measured for the tone (the outer 10 % often holds table or shadow). */
export const TONE_INNER = 0.9;
/** The paper background is the histogram mode above this luminance. */
const BACKGROUND_MIN = 0.4;
/** The mode is refined as the mean of the bins within this distance. */
const BACKGROUND_HALF_WIDTH = 8;
/** The print is the luminance at this fraction of the cumulative histogram. */
const TEXT_PERCENTILE = 0.01;
/** Below this background-to-print distance the page counts as blank ... */
const MIN_INK_CONTRAST = 0.2;
/** ... and the print is assumed this far below the background. */
const ASSUMED_INK_DISTANCE = 0.5;

/** Working layout for tone detection: the inner 90 % of the frame, longer side 500 px. */
export function toneWorkingLayout(frame: Frame, longSide = TONE_LONG_SIDE): WorkingLayout {
  const inner: Frame = { ...frame, width: frame.width * TONE_INNER, height: frame.height * TONE_INNER };
  return workingLayout(inner, longSide, 0);
}

/** 256-bin luminance histogram of the opaque pixels. */
export function luminanceHistogram(image: ImageData): Uint32Array {
  const histogram = new Uint32Array(256);
  const { data } = image;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3]! !== 255) continue;
    const y = Math.round(luminance(data[p]!, data[p + 1]!, data[p + 2]!));
    const bin = Math.min(255, Math.max(0, y));
    histogram[bin] = histogram[bin]! + 1;
  }
  return histogram;
}

/** Background and print luminance (0..1) read from a histogram; null when it is empty. */
export function paperLevels(histogram: Uint32Array): { background: number; text: number } | null {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i]!;
  if (total === 0) return null;
  // Background: the mode above 0.4 (the whole range when nothing is that bright).
  let from = Math.ceil(BACKGROUND_MIN * 255);
  let mode = -1;
  let modeCount = 0;
  for (let i = from; i < 256; i += 1) {
    if (histogram[i]! > modeCount) {
      modeCount = histogram[i]!;
      mode = i;
    }
  }
  if (mode < 0) {
    from = 0;
    for (let i = 0; i < 256; i += 1) {
      if (histogram[i]! > modeCount) {
        modeCount = histogram[i]!;
        mode = i;
      }
    }
  }
  let weighted = 0;
  let count = 0;
  for (let i = Math.max(from, mode - BACKGROUND_HALF_WIDTH); i <= Math.min(255, mode + BACKGROUND_HALF_WIDTH); i += 1) {
    weighted += i * histogram[i]!;
    count += histogram[i]!;
  }
  const background = (count > 0 ? weighted / count : mode) / 255;
  // Print: the 1st percentile of the cumulative histogram.
  let cumulative = 0;
  let percentile = 0;
  for (let i = 0; i < 256; i += 1) {
    cumulative += histogram[i]!;
    if (cumulative >= TEXT_PERCENTILE * total) {
      percentile = i;
      break;
    }
  }
  let text = percentile / 255;
  if (background - text < MIN_INK_CONTRAST) text = Math.max(0, background - ASSUMED_INK_DISTANCE);
  return { background, text };
}

/**
 * Brightness and contrast that map `background` to white and `text` to black
 * through the tone chain `out = c * (b * in) + 0.5 * (1 - c)`, clamped to
 * the slider ranges; grayscale on, temperature neutral.
 */
export function toneForLevels(background: number, text: number): Tone {
  const sum = background + text;
  const difference = background - text;
  const brightness = sum > 0 ? 1 / sum : 1;
  const contrast = difference > 0 ? sum / difference : 1;
  return {
    brightness: clampTone('brightness', brightness),
    contrast: clampTone('contrast', contrast),
    temperature: 0,
    grayscale: true,
  };
}

/** The whole tone detection on the working copy of the frame region; null when nothing was measurable. */
export function detectTone(working: ImageData): Tone | null {
  const levels = paperLevels(luminanceHistogram(working));
  return levels ? toneForLevels(levels.background, levels.text) : null;
}
