import type { RasterImage } from "./png.js";

export interface AlphaBounds {
  /** Bounding box of pixels with any opacity; null when fully transparent. */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Fraction of the frame covered by that box, 0..1. */
  coverage: number;
}

/**
 * Finds the opaque region of an image.
 *
 * After Effects can hand back a frame that is only partly rendered — with a
 * Region of Interest set, everything outside it comes through fully
 * transparent. That looks like a corrupt file rather than a setting, so it is
 * worth detecting and saying out loud.
 */
export function alphaBounds(image: RasterImage): AlphaBounds {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if ((image.rgba[(y * image.width + x) * 4 + 3] as number) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return { box: null, coverage: 0 };

  const covered = (maxX - minX + 1) * (maxY - minY + 1);
  return {
    box: { minX, minY, maxX, maxY },
    coverage: covered / (image.width * image.height),
  };
}
