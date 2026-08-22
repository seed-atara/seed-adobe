import type { RasterImage } from "./png.js";

/**
 * Solving for the light that was there, and putting it on another shot.
 *
 * This is the thing Beeble structurally cannot do, and it is not because their
 * decomposition is worse — it is better. SwitchLight relights *one image* and
 * you supply the new illumination as an HDRI. It has no notion of a second
 * shot, because it has no library.
 *
 * SEED does. So instead of authoring a light rig to match a reference by eye,
 * the lighting is **measured off the reference** and applied. "Light this shot
 * the way that shot is lit" is the thing a compositor actually wants, and it
 * is a solvable problem rather than a creative one.
 *
 * The maths is ordinary least squares. Shading is a function of surface
 * direction alone, so it lives on a sphere, and second-order spherical
 * harmonics — nine coefficients per channel — capture essentially all of the
 * low-frequency lighting that matters for a face. Given the normals and the
 * albedo, the observed image is linear in those coefficients, so recovering
 * them is a 9x9 solve per channel and nothing more.
 *
 * What this does *not* do: hard shadows, occlusion, or anything with an edge.
 * Second-order SH cannot represent them and pretending otherwise would be
 * dishonest — it is the soft light that transfers, which is also the part that
 * makes two shots look like they were filmed together.
 */

/** Nine coefficients per channel: order-2 real spherical harmonics. */
export interface LightingSolution {
  /** [channel][coefficient], red green blue. */
  coefficients: [number[], number[], number[]];
  /** How well it fits, mean absolute error in 0–1 shading units. */
  residual: number;
  samples: number;
}

/** The nine order-2 real SH basis functions, evaluated for a unit normal. */
function basis(x: number, y: number, z: number): number[] {
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

function normalOf(normals: RasterImage, index: number): [number, number, number] {
  const at = index * 4;
  const x = ((normals.rgba[at] ?? 128) / 255) * 2 - 1;
  const y = ((normals.rgba[at + 1] ?? 128) / 255) * 2 - 1;
  const z = ((normals.rgba[at + 2] ?? 255) / 255) * 2 - 1;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length < 1e-6) return [0, 0, 1];
  return [x / length, y / length, z / length];
}

/** Gaussian elimination with partial pivoting. Nine unknowns; nothing exotic. */
function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index] as number]);

  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs((a[row] as number[])[column] as number) >
          Math.abs((a[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }
    const swap = a[column] as number[];
    a[column] = a[pivot] as number[];
    a[pivot] = swap;

    const head = (a[column] as number[])[column] as number;
    /*
     * A singular system means the normals do not cover enough of the sphere to
     * pin the lighting down — a flat card, for instance. Returning zeros there
     * is better than returning something enormous and wrong.
     */
    if (Math.abs(head) < 1e-9) return new Array(n).fill(0);

    for (let row = column + 1; row < n; row += 1) {
      const factor = ((a[row] as number[])[column] as number) / head;
      if (factor === 0) continue;
      for (let k = column; k <= n; k += 1) {
        (a[row] as number[])[k] =
          ((a[row] as number[])[k] as number) - factor * ((a[column] as number[])[k] as number);
      }
    }
  }

  const out = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = (a[row] as number[])[n] as number;
    for (let column = row + 1; column < n; column += 1) {
      sum -= ((a[row] as number[])[column] as number) * (out[column] as number);
    }
    out[row] = sum / ((a[row] as number[])[row] as number);
  }
  return out;
}

/**
 * The lighting in a shot, from the shot, its normals and its albedo.
 *
 * Pixels where the albedo is very dark are skipped. Shading is recovered by
 * dividing the image by the albedo, and dividing by nearly nothing amplifies
 * nothing into everything — the same explosion the frequency detailer guards
 * against, for the same reason.
 */
export function estimateLighting(
  image: RasterImage,
  normals: RasterImage,
  albedo: RasterImage,
  maxSamples = 60_000,
): LightingSolution {
  const total = image.width * image.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));

  // Normal equations: 9x9 per channel, accumulated in one pass.
  const ata: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const atb: number[][] = [new Array<number>(9).fill(0), new Array<number>(9).fill(0), new Array<number>(9).fill(0)];
  let samples = 0;

  const sampleAt = (source: RasterImage, x: number, y: number): number => {
    const sx = Math.min(source.width - 1, Math.floor((x / image.width) * source.width));
    const sy = Math.min(source.height - 1, Math.floor((y / image.height) * source.height));
    return (sy * source.width + sx) * 4;
  };

  for (let index = 0; index < total; index += stride) {
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    const at = index * 4;
    if ((image.rgba[at + 3] ?? 255) === 0) continue;

    const albedoAt = sampleAt(albedo, x, y);
    const luma =
      ((albedo.rgba[albedoAt] ?? 0) +
        (albedo.rgba[albedoAt + 1] ?? 0) +
        (albedo.rgba[albedoAt + 2] ?? 0)) /
      3;
    if (luma < 24) continue; // too dark to divide by

    const [nx, ny, nz] = normalOf(normals, Math.floor(sampleAt(normals, x, y) / 4));
    const y9 = basis(nx, ny, nz);

    for (let i = 0; i < 9; i += 1) {
      for (let j = 0; j < 9; j += 1) {
        (ata[i] as number[])[j] =
          ((ata[i] as number[])[j] as number) + (y9[i] as number) * (y9[j] as number);
      }
      for (let c = 0; c < 3; c += 1) {
        const observed = (image.rgba[at + c] ?? 0) / 255;
        const base = (albedo.rgba[albedoAt + c] ?? 0) / 255;
        const shading = base > 0.05 ? observed / base : 0;
        (atb[c] as number[])[i] =
          ((atb[c] as number[])[i] as number) + (y9[i] as number) * shading;
      }
    }
    samples += 1;
  }

  if (samples < 32) {
    return { coefficients: [[], [], []] as never, residual: 0, samples };
  }

  // A whisker of regularisation, so a shot whose normals barely vary produces
  // a gentle answer rather than a wild one.
  for (let i = 0; i < 9; i += 1) {
    (ata[i] as number[])[i] = ((ata[i] as number[])[i] as number) + samples * 1e-4;
  }

  const coefficients = [
    solve(ata, atb[0] as number[]),
    solve(ata, atb[1] as number[]),
    solve(ata, atb[2] as number[]),
  ] as [number[], number[], number[]];

  // What the fit failed to carry, measured back against the samples.
  let error = 0;
  let counted = 0;
  for (let index = 0; index < total; index += stride * 4) {
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    const at = index * 4;
    const albedoAt = sampleAt(albedo, x, y);
    const base = (albedo.rgba[albedoAt] ?? 0) / 255;
    if (base <= 0.1) continue;
    const [nx, ny, nz] = normalOf(normals, Math.floor(sampleAt(normals, x, y) / 4));
    const y9 = basis(nx, ny, nz);
    let predicted = 0;
    for (let i = 0; i < 9; i += 1) {
      predicted += (coefficients[0][i] as number) * (y9[i] as number);
    }
    error += Math.abs(predicted - (image.rgba[at] ?? 0) / 255 / base);
    counted += 1;
  }

  return {
    coefficients,
    residual: counted > 0 ? Number((error / counted).toFixed(4)) : 0,
    samples,
  };
}

/**
 * A shot lit by a solved lighting solution.
 *
 * `out = albedo * shading(normal)`, where the shading is the SH sum. This is
 * the transfer step: pass the coefficients from one shot and the albedo and
 * normals from another, and the second is lit like the first.
 *
 * `amount` blends against flat lighting, because a full transfer is rarely
 * what is wanted — it will impose the reference's key direction on a shot
 * whose subject is facing the other way.
 */
export function applyLighting(
  albedo: RasterImage,
  normals: RasterImage,
  lighting: LightingSolution,
  amount = 1,
): RasterImage {
  const { width, height } = albedo;
  const out = new Uint8Array(albedo.rgba.length);
  const strength = Math.max(0, Math.min(1, amount));
  const coefficients = lighting.coefficients;

  if (!coefficients[0] || coefficients[0].length !== 9) {
    return { width, height, rgba: new Uint8Array(albedo.rgba) };
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const nx2 = Math.min(normals.width - 1, Math.floor((x / width) * normals.width));
      const ny2 = Math.min(normals.height - 1, Math.floor((y / height) * normals.height));
      const [nx, ny, nz] = normalOf(normals, ny2 * normals.width + nx2);
      const y9 = basis(nx, ny, nz);

      for (let c = 0; c < 3; c += 1) {
        let shading = 0;
        for (let i = 0; i < 9; i += 1) {
          shading += ((coefficients[c] as number[])[i] as number) * (y9[i] as number);
        }
        // Negative shading is a light behind the surface; it is not a hole.
        shading = Math.max(0, shading);
        const blended = 1 + (shading - 1) * strength;
        const base = (albedo.rgba[at + c] ?? 0) / 255;
        out[at + c] = Math.max(0, Math.min(255, Math.round(base * blended * 255)));
      }
      out[at + 3] = albedo.rgba[at + 3] ?? 255;
    }
  }

  return { width, height, rgba: out };
}

/**
 * Two lighting solutions, averaged.
 *
 * Per-frame estimation flickers: the solve is exact for each frame and the
 * frames disagree slightly, which reads as the lamp trembling. Averaging
 * across a shot is what turns a per-frame solve into a shot-level one, and it
 * is the other thing a tool with a timeline can do that a tool with an image
 * cannot.
 */
export function averageLighting(solutions: LightingSolution[]): LightingSolution {
  const usable = solutions.filter((entry) => entry.coefficients[0]?.length === 9);
  if (usable.length === 0) {
    return { coefficients: [[], [], []] as never, residual: 0, samples: 0 };
  }

  const coefficients = [0, 1, 2].map((channel) => {
    const summed = new Array<number>(9).fill(0);
    for (const entry of usable) {
      for (let i = 0; i < 9; i += 1) {
        summed[i] =
          (summed[i] as number) + ((entry.coefficients[channel] as number[])[i] as number);
      }
    }
    return summed.map((value) => value / usable.length);
  }) as [number[], number[], number[]];

  return {
    coefficients,
    residual:
      usable.reduce((total, entry) => total + entry.residual, 0) / usable.length,
    samples: usable.reduce((total, entry) => total + entry.samples, 0),
  };
}
