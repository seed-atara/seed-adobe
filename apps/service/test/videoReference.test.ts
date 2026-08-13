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

  /**
   * A network outage is not a failed render.
   *
   * One refused poll used to be the job's outcome. The render was already
   * running and already paid for, so three finished clips were discarded by a
   * blip — recovered afterwards from the provider, which is proof they were
   * never lost, only abandoned.
   */
  it("rides out failed polls instead of discarding a running render", async () => {
    let polls = 0;
    const flakyProvider = {
      id: "flaky-video",
      async capabilities() {
        return {
          id: "flaky-video",
          displayName: "Flaky",
          models: ["flaky-v1"],
          operations: ["video.generate"],
          textToImage: false,
          imageToImage: false,
          maxImageReferences: 0,
          textToVideo: true,
          imageToVideo: false,
          videoReferences: false,
          startEndFrames: false,
          audioReferences: false,
          seed: false,
          sizes: [],
          aspectRatios: [],
          async: true,
        };
      },
      async generateVideo() {
        return { providerJobId: "flaky-1", state: { status: "queued" as const } };
      },
      async getJob() {
        polls += 1;
        // Three outages, then the render that was there all along.
        if (polls <= 3) throw new Error("getaddrinfo ENOTFOUND ark.example");
        return {
          status: "succeeded" as const,
          outputs: [{ mimeType: "image/png", base64: fakePng(4, 4).toString("base64") }],
        };
      },
    };

    const { ProviderRegistry } = await import("@seed-ae/providers");
    const service = await startTestService({
      registry: new ProviderRegistry().register(flakyProvider as never),
    });
    try {
      const { job } = await readJson(
        await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "flaky-video",
            operation: "video.generate",
            prompt: "a shot worth keeping",
          }),
        }),
      );
      await service.deps.generation.whenSettled(job.id);

      const detail = await readJson(await service.call(`/v1/jobs/${job.id}`));
      expect(detail.job.status).toBe("succeeded");
      expect(detail.outputs).toHaveLength(1);
      expect(polls).toBe(4);
    } finally {
      await service.close();
    }
  });

  /**
   * Waiting is for the errors that waiting fixes.
   *
   * A rejected credential is not an outage: twenty retries take ninety seconds
   * to reach the same answer, and "The API key status is not active" is one
   * only a person can act on.
   */
  it("gives up at once when the credential is refused", async () => {
    let polls = 0;
    const { SeedError } = await import("@seed-ae/domain");
    const deadKeyProvider = {
      id: "dead-key",
      async capabilities() {
        return {
          id: "dead-key",
          displayName: "Dead key",
          models: ["dead-v1"],
          operations: ["video.generate"],
          textToImage: false,
          imageToImage: false,
          maxImageReferences: 0,
          textToVideo: true,
          imageToVideo: false,
          videoReferences: false,
          startEndFrames: false,
          audioReferences: false,
          seed: false,
          sizes: [],
          aspectRatios: [],
          async: true,
        };
      },
      async generateVideo() {
        return { providerJobId: "dead-1", state: { status: "queued" as const } };
      },
      async getJob() {
        polls += 1;
        throw new SeedError(
          "unauthorized",
          "Seedance returned HTTP 401: The API key status is not active.",
        );
      },
    };

    const { ProviderRegistry } = await import("@seed-ae/providers");
    const service = await startTestService({
      registry: new ProviderRegistry().register(deadKeyProvider as never),
    });
    try {
      const { job } = await readJson(
        await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "dead-key",
            operation: "video.generate",
            prompt: "anything",
          }),
        }),
      );
      await service.deps.generation.whenSettled(job.id);

      const detail = await readJson(await service.call(`/v1/jobs/${job.id}`));
      expect(detail.job.status).toBe("failed");
      expect(detail.job.errorMessage).toMatch(/API key status is not active/);
      expect(polls).toBe(1);
    } finally {
      await service.close();
    }
  });

  /**
   * The decoder lives in the panel, so the poster arrives from there.
   *
   * Borrowing the source frame is wrong for exactly the generation this whole
   * feature exists for: a reskin's poster showed the thing that was reskinned.
   */
  it("takes a poster the panel extracted, and refuses one for a still", async () => {
    const service = await startTestService();
    try {
      const clipPath = path.join(service.deps.workspace.originalsDir, "range.mp4");
      await writeFile(clipPath, fakeMp4(640, 360, 5));
      const { asset } = await readJson(
        await service.call("/v1/ae/register-clip", {
          method: "POST",
          body: JSON.stringify({ path: clipPath, context: {} }),
        }),
      );
      expect(asset.thumbnailUri).toBeUndefined();

      const response = await service.call(`/v1/assets/${asset.id}/poster`, {
        method: "POST",
        body: JSON.stringify({ png: fakePng(64, 36).toString("base64") }),
      });
      expect(response.status).toBe(200);
      const { asset: withPoster } = await readJson(response);
      expect(withPoster.thumbnailUri).toBeDefined();

      // The bytes have to be a PNG the panel drew, not whatever was posted.
      const junk = await service.call(`/v1/assets/${asset.id}/poster`, {
        method: "POST",
        body: JSON.stringify({ png: Buffer.from("not a png").toString("base64") }),
      });
      expect(junk.status).toBe(400);

      // A still already is its own poster.
      const frame = await readJson(
        await service.call("/v1/assets", {
          method: "POST",
          body: JSON.stringify({
            kind: "image",
            filename: "frame.png",
            mimeType: "image/png",
            storageUri: "assets/originals/frame.png",
            source: { type: "imported" },
          }),
        }),
      );
      const refused = await service.call(`/v1/assets/${frame.asset.id}/poster`, {
        method: "POST",
        body: JSON.stringify({ png: fakePng(8, 8).toString("base64") }),
      });
      expect(refused.status).toBe(400);
    } finally {
      await service.close();
    }
  });

  /**
   * A recipe records what was asked for. Only the raw request records what was
   * sent, and the two differ exactly where debugging happens — which reference
   * form travelled, which parameters the adapter dropped. It was returned by
   * every adapter and stored by nobody until a live run needed the answer.
   */
  it("stores what the adapter actually put on the wire", async () => {
    const echoProvider = {
      id: "echo-image",
      async capabilities() {
        return {
          id: "echo-image",
          displayName: "Echo",
          models: ["echo-v1"],
          operations: ["image.generate"],
          textToImage: true,
          imageToImage: false,
          maxImageReferences: 0,
          textToVideo: false,
          imageToVideo: false,
          videoReferences: false,
          startEndFrames: false,
          audioReferences: false,
          seed: false,
          sizes: [],
          aspectRatios: [],
          async: false,
        };
      },
      async generateImage() {
        return {
          providerJobId: "echo-1",
          state: {
            status: "succeeded" as const,
            outputs: [{ mimeType: "image/png", base64: fakePng(4, 4).toString("base64") }],
          },
          // What an adapter normalizes to, credentials already stripped.
          rawRequest: { url: "https://ark.example/images", body: { model: "echo-v1" } },
        };
      },
      async getJob() {
        return { status: "succeeded" as const };
      },
    };

    const { ProviderRegistry } = await import("@seed-ae/providers");
    const service = await startTestService({
      registry: new ProviderRegistry().register(echoProvider as never),
    });
    try {
      const { job } = await readJson(
        await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "echo-image",
            operation: "image.generate",
            prompt: "anything",
          }),
        }),
      );
      await service.deps.generation.whenSettled(job.id);

      const detail = await readJson(await service.call(`/v1/jobs/${job.id}`));
      expect(detail.generation.rawRequest).toEqual({
        url: "https://ark.example/images",
        body: { model: "echo-v1" },
      });
    } finally {
      await service.close();
    }
  });

  /**
   * Asking for what the clip already is means following it.
   *
   * Ark reads a request carrying a clip as editing and then refuses a duration
   * and a ratio — "`ratio` must be `adaptive`. `duration` must be -1" — twenty
   * seconds into a running task. Typing the clip's own length next to a
   * 4-second clip is the most natural thing an artist does, and it must not be
   * the thing that fails.
   */
  it("drops a duration and a shape that only restate the clip", async () => {
    const seen: { duration?: number; ratio?: string }[] = [];
    const clipProvider = {
      id: "clip-taker",
      async capabilities() {
        return {
          id: "clip-taker",
          displayName: "Clip taker",
          models: ["clip-v1"],
          operations: ["video.generate"],
          textToImage: false,
          imageToImage: false,
          maxImageReferences: 4,
          textToVideo: true,
          imageToVideo: true,
          videoReferences: true,
          startEndFrames: true,
          audioReferences: false,
          seed: false,
          durationSecondsRange: [4, 30] as [number, number],
          sizes: [],
          aspectRatios: ["16:9", "9:16", "adaptive"],
          async: false,
        };
      },
      async generateVideo(request: {
        durationSeconds?: number;
        aspectRatio?: string;
      }) {
        seen.push({
          ...(request.durationSeconds !== undefined
            ? { duration: request.durationSeconds }
            : {}),
          ...(request.aspectRatio ? { ratio: request.aspectRatio } : {}),
        });
        return {
          providerJobId: "clip-1",
          state: { status: "failed" as const, error: { class: "provider_error", message: "stop here" } },
        };
      },
      async getJob() {
        return { status: "failed" as const };
      },
    };

    const { ProviderRegistry } = await import("@seed-ae/providers");
    const service = await startTestService({
      registry: new ProviderRegistry().register(clipProvider as never),
    });
    try {
      const clipPath = path.join(service.deps.workspace.originalsDir, "range.mp4");
      // 4.04s and 16:9, the shape and length of a real captured range.
      await writeFile(clipPath, fakeMp4(1920, 1080, 4.04));
      const { asset } = await readJson(
        await service.call("/v1/ae/register-clip", {
          method: "POST",
          body: JSON.stringify({ path: clipPath, context: {} }),
        }),
      );

      const start = async (body: Record<string, unknown>) => {
        const response = await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "clip-taker",
            operation: "video.generate",
            prompt: "the same move, recoloured",
            inputAssetIds: [asset.id],
            ...body,
          }),
        });
        const { job } = await readJson(response);
        await service.deps.generation.whenSettled(job.id);
      };

      // 4 next to a 4.04s clip, and 16:9 next to a 1920x1080 clip.
      await start({ durationSeconds: 4, aspectRatio: "16:9" });
      expect(seen[0]).toEqual({});

      // A length that is genuinely different is still the artist's to ask for.
      await start({ durationSeconds: 12, aspectRatio: "9:16" });
      expect(seen[1]).toEqual({ duration: 12, ratio: "9:16" });
    } finally {
      await service.close();
    }
  });
});
