import { resize } from "./resize.js";
import type { RasterImage } from "./png.js";

/**
 * The matte: which pixels are kept and which are replaced.
 *
 * This is the control Beeble's SwitchX is built around — white is retained
 * from the source and relit, black is generated — and it is the right control,
 * because "switch the background but keep the performance" is a masking
 * question before it is a generation one.
 *
 * The difference here is where the matte comes from. A generative tool has to
 * infer it. SEED already computes depth for its passes, and a depth map is a
 * *measurement* of what is near the camera, so the automatic matte is derived
 * from the shot rather than guessed at — and when the artist has a real matte,
 * a rotoscoped one or a key, that is simply used instead.
 */

/**
 * Otsu's threshold: the split that best separates a histogram into two groups.
 *
 * Returns the **highest value belonging to the darker class**, which is the
 * conventional definition and the reason classification below is strict: with
 * two clusters at 40 and 230 it answers 40, and `>=` would then put the
 * background in the foreground and key the entire frame.
 *
 * Chosen over a fixed cut because "near" is relative. Depth models return a
 * normalised map, so the value that divides subject from background moves with
 * the shot — a fixed 0.5 puts a close-up entirely in the foreground and a wide
 * shot entirely in the background.
 */
export function otsuThreshold(values: Uint8Array | number[]): number {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < values.length; i += 1) {
    const bin = Math.max(0, Math.min(255, Math.round(values[i] as number)));
    histogram[bin] = (histogram[bin] as number) + 1;
  }

  const total = values.length;
  if (total === 0) return 128;

  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * (histogram[i] as number);

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 128;
  let bestVariance = -1;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t] as number;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * (histogram[t] as number);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) *
      (meanBackground - meanForeground);
    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

export interface MatteOptions {
  /** 0..255. Omitted means Otsu picks it from the frame. */
  threshold?: number;
  /** Softens the edge, in pixels. A hard matte cuts like scissors. */
  feather?: number;
  /**
   * Which end of the depth range is the subject.
   *
   * Depth Anything returns *inverse* depth, so nearer is brighter — but a map
   * that has been through a normalisation or an invert somewhere else will not
   * be, and silently keying the background is a confusing failure. Explicit.
   */
  nearIsBright?: boolean;
}

/** Luma of a pixel, which is what a single-channel pass carries. */
function grey(image: RasterImage, index: number): number {
  const at = index * 4;
  return (
    0.2126 * (image.rgba[at] as number) +
    0.7152 * (image.rgba[at + 1] as number) +
    0.0722 * (image.rgba[at + 2] as number)
  );
}

/**
 * A matte from a depth pass: white where the subject is.
 *
 * Returned as a greyscale image with alpha, so it can be written out, shown in
 * the panel, and handed to a compositor as an ordinary matte.
 */
export function matteFromDepth(
  depth: RasterImage,
  options: MatteOptions = {},
): RasterImage {
  const count = depth.width * depth.height;
  const values = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) values[i] = Math.round(grey(depth, i));

  const threshold = options.threshold ?? otsuThreshold(values);
  const nearIsBright = options.nearIsBright ?? true;

  const matte: RasterImage = {
    width: depth.width,
    height: depth.height,
    rgba: new Uint8Array(count * 4),
  };
  for (let i = 0; i < count; i += 1) {
    const value = values[i] as number;
    const inside = nearIsBright ? value > threshold : value <= threshold;
    const v = inside ? 255 : 0;
    const at = i * 4;
    matte.rgba[at] = v;
    matte.rgba[at + 1] = v;
    matte.rgba[at + 2] = v;
    matte.rgba[at + 3] = 255;
  }

  return options.feather && options.feather > 0
    ? featherMatte(matte, options.feather)
    : matte;
}

/**
 * Box-blurs a matte to soften its edge.
 *
 * Separable and run twice, which is a cheap approximation of a gaussian and
 * indistinguishable at the radii an edge needs.
 */
export function featherMatte(matte: RasterImage, radius: number): RasterImage {
  const r = Math.max(1, Math.round(radius));
  const { width, height } = matte;
  let current = new Float32Array(width * height);
  for (let i = 0; i < current.length; i += 1) current[i] = grey(matte, i);

  for (let pass = 0; pass < 2; pass += 1) {
    const horizontal = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let n = 0;
        for (let k = -r; k <= r; k += 1) {
          const sx = x + k;
          if (sx < 0 || sx >= width) continue;
          total += current[y * width + sx] as number;
          n += 1;
        }
        horizontal[y * width + x] = total / n;
      }
    }
    const vertical = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let n = 0;
        for (let k = -r; k <= r; k += 1) {
          const sy = y + k;
          if (sy < 0 || sy >= height) continue;
          total += horizontal[sy * width + x] as number;
          n += 1;
        }
        vertical[y * width + x] = total / n;
      }
    }
    current = vertical;
  }

  const out: RasterImage = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < current.length; i += 1) {
    const v = Math.max(0, Math.min(255, Math.round(current[i] as number)));
    const at = i * 4;
    out.rgba[at] = v;
    out.rgba[at + 1] = v;
    out.rgba[at + 2] = v;
    out.rgba[at + 3] = 255;
  }
  return out;
}

/** A matte covering the whole frame — everything is subject. */
export function fullMatte(width: number, height: number): RasterImage {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  return { width, height, rgba };
}

/** How much of the frame the matte keeps, 0..1. Reported, not assumed. */
export function matteCoverage(matte: RasterImage): number {
  const count = matte.width * matte.height;
  let total = 0;
  for (let i = 0; i < count; i += 1) total += grey(matte, i);
  return Number((total / (count * 255)).toFixed(4));
}

/**
 * Composites a foreground over a background through a matte.
 *
 * The background is resized to the foreground rather than the other way round:
 * the plate decides the format, and a reference image is a look, not a canvas.
 */
export function compositeOver(
  foreground: RasterImage,
  matte: RasterImage,
  background: RasterImage,
): RasterImage {
  const { width, height } = foreground;
  const bg =
    background.width === width && background.height === height
      ? background
      : resize(background, width, height);
  const mt =
    matte.width === width && matte.height === height
      ? matte
      : resize(matte, width, height);

  const out: RasterImage = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    const alpha = grey(mt, i) / 255;
    for (let c = 0; c < 3; c += 1) {
      out.rgba[at + c] = Math.round(
        (foreground.rgba[at + c] as number) * alpha +
          (bg.rgba[at + c] as number) * (1 - alpha),
      );
    }
    out.rgba[at + 3] = 255;
  }
  return out;
}

/**
 * Inverts a matte.
 *
 * "Keep the subject and switch the background" and "restyle the background and
 * leave the subject" are the same operation read from opposite ends, and an
 * artist expects both.
 */
export function invertMatte(matte: RasterImage): RasterImage {
  const out: RasterImage = {
    width: matte.width,
    height: matte.height,
    rgba: new Uint8Array(matte.rgba.length),
  };
  for (let i = 0; i < matte.width * matte.height; i += 1) {
    const at = i * 4;
    const v = 255 - Math.round(grey(matte, i));
    out.rgba[at] = v;
    out.rgba[at + 1] = v;
    out.rgba[at + 2] = v;
    out.rgba[at + 3] = 255;
  }
  return out;
}
