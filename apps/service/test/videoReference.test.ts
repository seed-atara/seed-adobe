import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "@seed-ae/media";
import { describe, expect, it } from "vitest";
import { InputMaterializer } from "../src/generation/inputMaterializer.js";
import { readJson, startTestService } from "./helpers.js";

/**
 * Enough of an MP4 for the parts SEED actually reads: the ftyp brand it is
 * sniffed by, an mvhd carrying a duration, and an stsd sample entry carrying
 * the coded size. Real files have all this and several megabytes besides.
 */
function fakeMp4(width: number, height: number, seconds: number): Buffer {
  const ftyp = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from("ftyp", "ascii"),
    Buffer.from("isom", "ascii"),
  ]);

  const mvhd = Buffer.alloc(40);
  mvhd.write("mvhd", 0, "ascii");
  mvhd.writeUInt32BE(0, 4); // version 0
  mvhd.writeUInt32BE(1000, 16); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 20);

  const stsd = Buffer.alloc(60);
  stsd.write("stsd", 0, "ascii");
  // entry starts at +12: size(4) then the codec four-cc
  stsd.write("avc1", 12 + 4, "ascii");
  stsd.writeUInt16BE(width, 12 + 32);
  stsd.writeUInt16BE(height, 12 + 34);

  return Buffer.concat([ftyp, mvhd, stsd]);
}

function fakePng(width: number, height: number): Buffer {
  const rgba = new Uint8Array(width * height * 4).fill(200);
  return Buffer.from(encodePng(width, height, rgba));
}

describe("clips as references", () => {
  it("adopts a clip from anywhere on disk, reading its own size and length", async () => {
    const service = await startTestService();
    try {
      const outside = await mkdtemp(path.join(tmpdir(), "seed exports "));
      const source = path.join(outside, "hero plate.mp4");
      await writeFile(source, fakeMp4(1920, 1080, 4.5));

      const response = await service.call("/v1/assets/adopt", {
        method: "POST",
        body: JSON.stringify({ path: source }),
      });
      expect(response.status).toBe(201);

      const { asset } = await readJson(response);
      expect(asset.kind).toBe("video");
      expect(asset.mimeType).toBe("video/mp4");
      expect(asset.width).toBe(1920);
      expect(asset.height).toBe(1080);
      expect(asset.durationSeconds).toBeCloseTo(4.5, 3);
      expect(asset.source).toEqual({ type: "imported", originalPath: source });

      // Copied in, not referenced in place: the library owns its media.
      expect(asset.storageUri).not.toContain(outside);
      const stored = await service.call(`/v1/assets/${asset.id}/path`);
      const { path: storedPath } = await readJson(stored);
      expect(await readFile(storedPath)).toHaveLength(fakeMp4(1920, 1080, 4.5).length);

      // Adopting the same file twice is two assets, never one overwriting the
      // other's bytes.
      const again = await service.call("/v1/assets/adopt", {
        method: "POST",
        body: JSON.stringify({ path: source }),
      });
      const { asset: second } = await readJson(again);
      expect(second.id).not.toBe(asset.id);
      expect(second.storageUri).not.toBe(asset.storageUri);
    } finally {
      await service.close();
    }
  });

  it("refuses a file it has no use for, by what the bytes are", async () => {
    const service = await startTestService();
    try {
      const outside = await mkdtemp(path.join(tmpdir(), "seed exports "));
      const source = path.join(outside, "notes.mp4");
      await writeFile(source, "this is text pretending to be a clip");

      const response = await service.call("/v1/assets/adopt", {
        method: "POST",
        body: JSON.stringify({ path: source }),
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await readJson(response))).toMatch(/no use for/);
    } finally {
      await service.close();
    }
  });

  it("registers a rendered range with the poster the host wrote beside it", async () => {
    const service = await startTestService();
    try {
      const originals = service.deps.workspace.originalsDir;
      const clip = path.join(originals, "comp_f00024_range_001.mp4");
      const poster = path.join(originals, "comp_f00024_poster_001.png");
      await writeFile(clip, fakeMp4(1280, 720, 6));
      await writeFile(poster, fakePng(32, 18));

      const response = await service.call("/v1/ae/register-clip", {
        method: "POST",
        body: JSON.stringify({
          path: clip,
          posterPath: poster,
          context: { compName: "hero", fps: 24, workAreaStartSeconds: 1 },
          width: 1280,
          height: 720,
          durationSeconds: 6,
          fps: 24,
        }),
      });
      expect(response.status).toBe(201);

      const { asset } = await readJson(response);
      expect(asset.kind).toBe("video");
      expect(asset.durationSeconds).toBeCloseTo(6, 3);
      expect(asset.fps).toBe(24);
      expect(asset.source.captureFormat).toBe("mp4");
      expect(asset.source.context.compName).toBe("hero");
      // A clip nobody can recognise in the grid is a clip nobody picks.
      expect(asset.thumbnailUri).toBeDefined();
    } finally {
      await service.close();
    }
  });

  it("hosts a clip and leaves images inline", async () => {
    const service = await startTestService();
    try {
      const originals = service.deps.workspace.originalsDir;
      const clipPath = path.join(originals, "range.mp4");
      const framePath = path.join(originals, "frame.png");
      await writeFile(clipPath, fakeMp4(640, 360, 2));
      await writeFile(framePath, fakePng(8, 8));

      const clip = await readJson(
        await service.call("/v1/ae/register-clip", {
          method: "POST",
          body: JSON.stringify({ path: clipPath, context: {} }),
        }),
      );
      const frame = await readJson(
        await service.call("/v1/ae/register-capture", {
          method: "POST",
          body: JSON.stringify({ path: framePath, context: {} }),
        }),
      );

      const published: string[] = [];
      const materializer = new InputMaterializer(service.deps.workspace, {
        publish: async ({ filename }) => {
          published.push(filename);
          return { url: `https://bucket.example/${filename}?signed` };
        },
      });

      const inputs = await materializer.materializeAll(
        [frame.asset, clip.asset],
        "dataUrl",
        { hostVideo: true },
      );

      expect(inputs[0]?.kind).toBe("dataUrl");
      expect(inputs[1]?.kind).toBe("url");
      expect(inputs[1]?.value).toContain("https://bucket.example/");
      // Only the clip cost an upload.
      expect(published).toEqual(["range.mp4"]);
    } finally {
      await service.close();
    }
  });

  it("says what is missing when a clip needs hosting and none is configured", async () => {
    const service = await startTestService();
    try {
      const clipPath = path.join(service.deps.workspace.originalsDir, "range.mp4");
      await writeFile(clipPath, fakeMp4(640, 360, 2));
      const { asset } = await readJson(
        await service.call("/v1/ae/register-clip", {
          method: "POST",
          body: JSON.stringify({ path: clipPath, context: {} }),
        }),
      );

      const materializer = new InputMaterializer(service.deps.workspace);
      expect(materializer.canHost).toBe(false);
      await expect(
        materializer.materializeAll([asset], "dataUrl", { hostVideo: true }),
      ).rejects.toThrow(/SEED_R2_ENDPOINT/);
    } finally {
      await service.close();
    }
  });
});
