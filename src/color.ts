/**
 * Colour constants shared by the tone chain and the detection: the sRGB
 * luminance coefficients of the CSS `grayscale()` filter and the luminance of
 * one pixel. Pure maths, no DOM.
 */

/** sRGB luminance coefficients used by the CSS grayscale() filter. */
export const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

/** Luminance of an RGB triple, in the unit of its channels. */
export function luminance(r: number, g: number, b: number): number {
  return LUMA.r * r + LUMA.g * g + LUMA.b * b;
}
