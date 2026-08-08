import type { RasterImage } from "./png.js";

/**
 * Box-average downscale. Averaging (rather than nearest-neighbour) matters
 * because thumbnails of rendered frames are usually large reductions, where
 * point sampling aliases badly and makes a grid look broken.
 */
export function resize(image: RasterImage, width: number, height: number): RasterImage {
  if (width <= 0 || height <= 0) {
    throw new Error(`invalid target size ${width}x${height}`);
  }
  if (width === image.width && height === image.height) return image;

  const out = new Uint8Array(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * xRatio)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          r += image.rgba[i] as number;
          g += image.rgba[i + 1] as number;
          b += image.rgba[i + 2] as number;
          a += image.rgba[i + 3] as number;
          n += 1;
        }
      }

      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }

  return { width, height, rgba: out };
}

/** Scales to fit inside a box, preserving aspect ratio. Never upscales. */
export function fitWithin(
  image: RasterImage,
  maxWidth: number,
  maxHeight: number,
): RasterImage {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  if (scale === 1) return image;
  return resize(
    image,
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
}
