import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeJpegPreview, encodePng, sniffMimeType } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// A genuine Seedream result, kept so the decoder is tested against real
// provider output rather than something we generated ourselves.
const FIXTURE = path.resolve(here, "../../../fixtures/media/seedream-result.jpg");

describe("decodeJpegPreview", () => {
  it("decodes a real Seedream JPEG at 1/8 scale", async () => {
    const bytes = await readFile(FIXTURE);
    expect(sniffMimeType(bytes)).toBe("image/jpeg");

    const preview = decodeJpegPreview(bytes);
    if (!preview) throw new Error("failed to decode the fixture");

    // Source is 2848x1600.
    expect(preview.width).toBe(Math.ceil(2848 / 8));
    expect(preview.height).toBe(Math.ceil(1600 / 8));
    expect(preview.rgba.length).toBe(preview.width * preview.height * 4);
    expect(Array.from(preview.rgba.subarray(3, 4))).toEqual([255]);
  });

  it("produces a plausible image rather than noise or flat grey", async () => {
    const preview = decodeJpegPreview(await readFile(FIXTURE));
    if (!preview) throw new Error("failed to decode");

    let min = 255;
    let max = 0;
    let total = 0;
    const count = preview.width * preview.height;
    for (let i = 0; i < count; i += 1) {
      const luma =
        0.299 * (preview.rgba[i * 4] as number) +
        0.587 * (preview.rgba[i * 4 + 1] as number) +
        0.114 * (preview.rgba[i * 4 + 2] as number);
      min = Math.min(min, luma);
      max = Math.max(max, luma);
      total += luma;
    }
    const mean = total / count;

    // The source is a dark night grade with a bright lower band: real range,
    // and a mean well below mid grey.
    expect(max - min).toBeGreaterThan(60);
    expect(mean).toBeGreaterThan(5);
    expect(mean).toBeLessThan(150);
  });

  it("returns undefined for non-JPEG and for a truncated file", async () => {
    expect(decodeJpegPreview(encodePng(4, 4, new Uint8Array(64)))).toBeUndefined();
    expect(decodeJpegPreview(Buffer.from("nope"))).toBeUndefined();
    const bytes = await readFile(FIXTURE);
    expect(decodeJpegPreview(bytes.subarray(0, 400))).toBeUndefined();
  });
});
