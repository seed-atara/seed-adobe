import type { FloatImage } from "./image.js";
import { cloneImage, createImage } from "./image.js";

/**
 * Separable blur.
 *
 * Three iterated box passes rather than a true Gaussian kernel. At the radii
 * this chain uses — bloom and glare run to a few percent of the diagonal,
 * which is a sigma in the tens of pixels — a tap-per-sample Gaussian costs
 * hundreds of multiplies per pixel per axis, while three boxes cost a constant
 * few regardless of radius and converge on a Gaussian by the central limit
 * theorem. The visible difference at these sigmas is nil; the difference in
 * render time is the whole feasibility of the thing.
 *
 * Box widths follow Kovesi's standard derivation for approximating a Gaussian
 * of a given sigma with n boxes.
 */
export function gaussianBlur(image: FloatImage, sigma: number): FloatImage {
  if (!(sigma > 0.3)) return cloneImage(image);

  const widths = boxSizesForGaussian(sigma, 3);
  let current = cloneImage(image);
  for (const width of widths) {
    current = boxBlurHorizontal(current, (width - 1) / 2);
    current = boxBlurVertical(current, (width - 1) / 2);
  }
  return current;
}

/** Horizontal-only blur, for the anamorphic streak. */
export function horizontalBlur(image: FloatImage, sigma: number): FloatImage {
  if (!(sigma > 0.3)) return cloneImage(image);
  const widths = boxSizesForGaussian(sigma, 3);
  let current = cloneImage(image);
  for (const width of widths) {
    current = boxBlurHorizontal(current, (width - 1) / 2);
  }
  return current;
}

function boxSizesForGaussian(sigma: number, n: number): number[] {
  const idealWidth = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(idealWidth);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;

  const mIdeal =
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);

  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes.filter((size) => size > 1);
}

/**
 * Running-sum box blur. Edges clamp, so a bright border does not bleed
 * darkness inward the way a zero-padded blur would.
 */
function boxBlurHorizontal(image: FloatImage, radius: number): FloatImage {
  const { width, height, data } = image;
  const out = createImage(width, height);
  const r = Math.max(1, Math.round(radius));
  const span = r * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const x = Math.min(Math.max(i, 0), width - 1);
        sum += data[(row + x) * 4 + c]!;
      }
      for (let x = 0; x < width; x++) {
        out.data[(row + x) * 4 + c] = sum / span;
        const leaving = Math.min(Math.max(x - r, 0), width - 1);
        const entering = Math.min(Math.max(x + r + 1, 0), width - 1);
        sum += data[(row + entering) * 4 + c]! - data[(row + leaving) * 4 + c]!;
      }
    }
  }
  return out;
}

function boxBlurVertical(image: FloatImage, radius: number): FloatImage {
  const { width, height, data } = image;
  const out = createImage(width, height);
  const r = Math.max(1, Math.round(radius));
  const span = r * 2 + 1;

  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) {
        const y = Math.min(Math.max(i, 0), height - 1);
        sum += data[(y * width + x) * 4 + c]!;
      }
      for (let y = 0; y < height; y++) {
        out.data[(y * width + x) * 4 + c] = sum / span;
        const leaving = Math.min(Math.max(y - r, 0), height - 1);
        const entering = Math.min(Math.max(y + r + 1, 0), height - 1);
        sum +=
          data[(entering * width + x) * 4 + c]! - data[(leaving * width + x) * 4 + c]!;
      }
    }
  }
  return out;
}
