/**
 * Float images and the sampling the chain needs.
 *
 * RGBA interleaved, one Float32 per channel. Alpha is carried through every
 * stage untouched: a region capture has a matte, and a look that flattened it
 * would make the region tool useless the moment anyone treated a crop.
 */
export interface FloatImage {
  width: number;
  height: number;
  /** RGBA, straight (not premultiplied), row-major. */
  data: Float32Array;
}

export function createImage(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 4) };
}

export function cloneImage(image: FloatImage): FloatImage {
  return {
    width: image.width,
    height: image.height,
    data: new Float32Array(image.data),
  };
}

/**
 * The image diagonal, in pixels.
 *
 * Every spatial radius in the specification is a fraction of this, which is
 * what makes one preset hold at 1920x1080 and at 4096x2304. It must be
 * computed from the buffer actually being rendered — including a reduced
 * preview resolution — rather than from any nominal format.
 */
export function diagonal(image: { width: number; height: number }): number {
  return Math.hypot(image.width, image.height);
}

/** Radius in pixels from a fraction-of-diagonal parameter. */
export function radiusPixels(
  image: { width: number; height: number },
  fraction: number,
): number {
  return Math.max(0, fraction) * diagonal(image);
}

/**
 * Bilinear sample at a pixel coordinate, clamped at the edges.
 *
 * Clamping rather than wrapping or blackening: a distortion gather reads
 * outside the frame near the corners, and black there produces a dark rim that
 * reads as a vignette nobody asked for.
 */
export function sampleBilinear(
  image: FloatImage,
  x: number,
  y: number,
  out: Float32Array,
  outOffset: number,
): void {
  const { width, height, data } = image;

  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);

  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c]! * (1 - fx) + data[i10 + c]! * fx;
    const bottom = data[i01 + c]! * (1 - fx) + data[i11 + c]! * fx;
    out[outOffset + c] = top * (1 - fy) + bottom * fy;
  }
}

/** Sample one channel, for the per-channel gathers a CA remap needs. */
export function sampleChannelBilinear(
  image: FloatImage,
  x: number,
  y: number,
  channel: number,
): number {
  const { width, height, data } = image;

  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);

  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const top =
    data[(y0 * width + x0) * 4 + channel]! * (1 - fx) +
    data[(y0 * width + x1) * 4 + channel]! * fx;
  const bottom =
    data[(y1 * width + x0) * 4 + channel]! * (1 - fx) +
    data[(y1 * width + x1) * 4 + channel]! * fx;
  return top * (1 - fy) + bottom * fy;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
