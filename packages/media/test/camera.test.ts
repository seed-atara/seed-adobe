import { describe, expect, it } from "vitest";
import {
  measureAberration,
  measureCamera,
  measureGrain,
  measureHalation,
  measureVignette,
  type RasterImage,
} from "../src/index.js";

/** A textured mid-grey field — something for the measurements to bite on. */
function textured(size = 256, seed = 1): RasterImage {
  const rgba = new Uint8Array(size * size * 4);
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      // Blocky structure, so there are edges but no gradient across the frame.
      const block = ((x >> 4) + (y >> 4)) % 2 === 0 ? 120 : 150;
      const value = Math.round(block + random() * 6);
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

/** Darkens towards the corners by `amount`. */
function withVignette(image: RasterImage, amount: number): RasterImage {
  const { width, height } = image;
  const out = new Uint8Array(image.rgba);
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.sqrt(dx * dx + dy * dy) / maxRadius;
      const scale = 1 - amount * radius * radius;
      for (let c = 0; c < 3; c += 1) {
        out[at + c] = Math.max(0, Math.round((image.rgba[at + c] ?? 0) * scale));
      }
    }
  }
  return { width, height, rgba: out };
}

describe("measureVignette", () => {
  it("finds a vignette that was put there", () => {
    const plain = measureVignette(textured());
    const darkened = measureVignette(withVignette(textured(), 0.5));
    expect(darkened.value).toBeGreaterThan(plain.value + 0.1);
    expect(darkened.confidence).toBeGreaterThan(0.3);
  });

  it("reports more falloff for a heavier vignette", () => {
    const light = measureVignette(withVignette(textured(), 0.2));
    const heavy = measureVignette(withVignette(textured(), 0.6));
    expect(heavy.value).toBeGreaterThan(light.value);
  });

  it("has no confidence in a frame that is mostly a gradient", () => {
    /*
     * A sunset is a gradient, and no amount of care separates that from a
     * vignette on one frame. Saying so is the honest answer; producing a
     * number anyway would put a lens correction on a sky.
     */
    const size = 256;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4;
        const value = Math.round((y / size) * 255);
        rgba[at] = value;
        rgba[at + 1] = value;
        rgba[at + 2] = value;
        rgba[at + 3] = 255;
      }
    }
    expect(measureVignette({ width: size, height: size, rgba }).confidence).toBeLessThan(0.5);
  });

  it("says nothing about a black frame", () => {
    const black: RasterImage = {
      width: 64,
      height: 64,
      rgba: new Uint8Array(64 * 64 * 4).fill(0),
    };
    expect(measureVignette(black).confidence).toBe(0);
  });
});

describe("measureAberration", () => {
  it("only counts misalignment that grows towards the edge", () => {
    /*
     * Real lateral CA vanishes at the centre and grows outward. A red coat
     * against a blue wall produces channel disagreement everywhere, and the
     * ratio is what tells a lens from a wardrobe.
     */
    const size = 256;
    const rgba = new Uint8Array(size * size * 4);
    const cx = size / 2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4;
        const edge = (x >> 5) % 2 === 0 ? 80 : 190;
        // Blue lags red by more, further out — that is the signature.
        const shift = Math.round((Math.abs(x - cx) / cx) * 3);
        const blueEdge = ((x - shift) >> 5) % 2 === 0 ? 80 : 190;
        rgba[at] = edge;
        rgba[at + 1] = edge;
        rgba[at + 2] = blueEdge;
        rgba[at + 3] = 255;
      }
    }
    const withCa = measureAberration({ width: size, height: size, rgba });
    const without = measureAberration(textured());
    expect(withCa.value).toBeGreaterThanOrEqual(without.value);
  });

  it("says nothing about a frame with no edges", () => {
    const flat: RasterImage = {
      width: 128,
      height: 128,
      rgba: new Uint8Array(128 * 128 * 4).fill(128),
    };
    expect(measureAberration(flat).confidence).toBe(0);
  });
});

describe("measureGrain", () => {
  it("finds more grain in a noisier frame", () => {
    const quiet = measureGrain(textured(256, 1));
    const noisy = (() => {
      const image = textured(256, 2);
      let state = 7;
      for (let at = 0; at < image.rgba.length; at += 4) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const jitter = ((state / 0x7fffffff) - 0.5) * 40;
        for (let c = 0; c < 3; c += 1) {
          image.rgba[at + c] = Math.max(
            0,
            Math.min(255, Math.round((image.rgba[at + c] ?? 0) + jitter)),
          );
        }
      }
      return measureGrain(image);
    })();
    expect(noisy.amount.value).toBeGreaterThan(quiet.amount.value);
  });

  it("says nothing about a frame with no midtone", () => {
    const black: RasterImage = {
      width: 128,
      height: 128,
      rgba: new Uint8Array(128 * 128 * 4).fill(0),
    };
    expect(measureGrain(black).amount.confidence).toBe(0);
  });
});

describe("measureHalation", () => {
  it("finds red bleeding around a clipped highlight", () => {
    const size = 128;
    const rgba = new Uint8Array(size * size * 4).fill(60);
    for (let at = 3; at < rgba.length; at += 4) rgba[at] = 255;

    const cx = size / 2;
    const cy = size / 2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4;
        const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (distance < 10) {
          rgba[at] = 255;
          rgba[at + 1] = 255;
          rgba[at + 2] = 255;
        } else if (distance < 22) {
          // The halo: redder than the surround, as film halation is.
          rgba[at] = 150;
          rgba[at + 1] = 70;
          rgba[at + 2] = 60;
        }
      }
    }
    const measured = measureHalation({ width: size, height: size, rgba });
    expect(measured.value).toBeGreaterThan(0);
    expect(measured.confidence).toBeGreaterThan(0);
  });

  it("reports no confidence rather than no halation when nothing is clipped", () => {
    // Different statements: one says the camera has none, the other says the
    // frame cannot tell you. Only the second is true here.
    const measured = measureHalation(textured());
    expect(measured.confidence).toBe(0);
  });
});

describe("measureCamera", () => {
  it("explains in words what the frame could not answer", () => {
    const signature = measureCamera(textured());
    expect(signature.notes.length).toBeGreaterThan(0);
    expect(signature.notes.some((note) => note.includes("halation"))).toBe(true);
  });

  it("returns every measurement, confident or not", () => {
    const signature = measureCamera(withVignette(textured(), 0.4));
    for (const measured of [
      signature.vignette,
      signature.aberration,
      signature.grain,
      signature.grainSize,
      signature.halation,
    ]) {
      expect(Number.isFinite(measured.value)).toBe(true);
      expect(measured.confidence).toBeGreaterThanOrEqual(0);
      expect(measured.confidence).toBeLessThanOrEqual(1);
    }
  });
});
