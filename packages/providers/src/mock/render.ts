import { decodePng, encodePng, resize, type RasterImage } from "@seed-ae/media";

/** Stable 32-bit hash so the same recipe always renders the same pixels. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MockRenderOptions {
  width: number;
  height: number;
  prompt: string;
  seed: number;
  /** Decoded reference frame, when the request carried one. */
  reference?: Buffer;
}

/**
 * Renders a deterministic stand-in image for a generation.
 *
 * When a reference frame is supplied it is used as the base and graded, so an
 * image-to-image result visibly descends from the captured AE frame — the
 * lineage in the demo is real, not asserted. With no reference it renders a
 * prompt-derived field.
 */
export function renderMockImage(options: MockRenderOptions): Buffer {
  const { width, height, prompt, seed } = options;
  const tint = hashString(`${prompt}:${seed}`);
  const rTint = ((tint >> 16) & 0xff) / 255;
  const gTint = ((tint >> 8) & 0xff) / 255;
  const bTint = (tint & 0xff) / 255;
  const random = mulberry32(tint);
  const grain = Array.from({ length: 64 }, () => random());

  const base = options.reference ? decodeAndFit(options.reference, width, height) : undefined;
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const v = y / height;
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const i = (y * width + x) * 4;

      // Radial falloff gives the result a lit, rendered feel rather than a flat ramp.
      const dx = u - 0.5;
      const dy = v - 0.5;
      const falloff = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.4);
      const swirl =
        0.5 +
        0.5 *
          Math.sin(
            (u * 6 + v * 4) * Math.PI + (tint % 360) * 0.017 + Math.cos(v * 9) * 1.5,
          );
      const speckle = grain[(x + y) % grain.length] as number;

      if (base) {
        const b = (y * width + x) * 4;
        pixels[i] = clamp((base.rgba[b] as number) * (0.55 + rTint * 0.75) + swirl * 46 * falloff);
        pixels[i + 1] = clamp(
          (base.rgba[b + 1] as number) * (0.55 + gTint * 0.75) + swirl * 30 * falloff,
        );
        pixels[i + 2] = clamp(
          (base.rgba[b + 2] as number) * (0.55 + bTint * 0.75) + swirl * 60 * falloff,
        );
        pixels[i + 3] = base.rgba[b + 3] as number;
      } else {
        pixels[i] = clamp(255 * (rTint * 0.5 + swirl * 0.5) * (0.35 + falloff * 0.9));
        pixels[i + 1] = clamp(255 * (gTint * 0.45 + (1 - swirl) * 0.55) * (0.3 + falloff));
        pixels[i + 2] = clamp(255 * (bTint * 0.6 + v * 0.4) * (0.4 + falloff * 0.8));
        pixels[i + 3] = 255;
      }

      // A touch of stable grain so flat regions do not band.
      pixels[i] = clamp((pixels[i] as number) + (speckle - 0.5) * 8);
    }
  }

  return encodePng(width, height, pixels);
}

function decodeAndFit(
  reference: Buffer,
  width: number,
  height: number,
): RasterImage | undefined {
  const decoded = decodePng(reference);
  if (!decoded) return undefined;
  return decoded.width === width && decoded.height === height
    ? decoded
    : resize(decoded, width, height);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
