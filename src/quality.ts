/**
 * Compression levels of the share sheet and their JPEG quality
 * (see intent/v0.1-mvp.md "Share sheet"). Nothing here is persisted.
 */

import type { CompressionLevel } from './model';

/** JPEG quality per compression level. */
export const JPEG_QUALITY: Record<CompressionLevel, number> = {
  small: 0.5,
  medium: 0.75,
  large: 0.92,
};

/** JPEG quality for a compression level. */
export function jpegQuality(level: CompressionLevel): number {
  return JPEG_QUALITY[level];
}

/** The levels in the order the segmented control shows them. */
export const COMPRESSION_LEVELS: readonly CompressionLevel[] = ['small', 'medium', 'large'];

/** Preselected level in the share sheet. */
export const DEFAULT_COMPRESSION: CompressionLevel = 'medium';
