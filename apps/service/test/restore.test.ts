import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng } from "@seed-ae/media";
import {
  MockImageProvider,
  MockVideoProvider,
  ProviderRegistry,
} from "@seed-ae/providers";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  VideoGenerationRequest,
} from "@seed-ae/providers";
import { describe, expect, it } from "vitest";
import { readJson, startTestService, type TestService } from "./helpers.js";

/**
 * Restoration, end to end through the service.
 *
 * Almost every assertion here is about something the request does *not*
 * contain. That is not perversity: a restoration runs on a generative model,
 * and it is defined by its omissions. A stated duration turns it into a
 * re-cut, a stated ratio reframes it, and a clip handed over as a first frame
 * becomes a shot that animates away from itself. Each of those is a one-line
 * change away at all times, and each would look like a working feature until
 * an editor noticed the shot had moved.
 */

/** Enough of an MP4 for the parts SEED reads: brand, duration, coded size. */
function fakeMp4(width: number, height: number, seconds: number): Buffer {
  const ftyp = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from("ftyp", "ascii"),
    Buffer.from("isom", "ascii"),
  ]);
  const mvhd = Buffer.alloc(40);
  mvhd.write("mvhd", 0, "ascii");
  mvhd.writeUInt32BE(0, 4);
  mvhd.writeUInt32BE(1000, 16);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 20);
  const stsd = Buffer.alloc(60);
  stsd.write("stsd", 0, "ascii");
  stsd.write("avc1", 12 + 4, "ascii");
  stsd.writeUInt16BE(width, 12 + 32);
  stsd.writeUInt16BE(height, 12 + 34);
  return Buffer.concat([ftyp, mvhd, stsd]);
}

/**
 * A bucket that accepts anything, so the real hosting path can run.
 *
 * A clip cannot travel inline to any provider — the materializer insists on a
 * fetchable URL for video and says which four settings are missing when there
 * is none. That is correct and worth keeping, so rather than weakening a
 * double to dodge it, these tests stand up somewhere for the upload to go. The
 * presigned URL that comes back is never fetched: the double records the
 * request and does not resolve it.
 */
async function stubBucket(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(req.method === "PUT" ? 200 : 404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** What a test service needs to host a clip at all. */
function hosting(endpoint: string): Record<string, string> {
  return {
    SEED_R2_ENDPOINT: endpoint,
    SEED_R2_BUCKET: "seed-test",
    SEED_R2_ACCESS_KEY_ID: "test-access-key",
    SEED_R2_SECRET_ACCESS_KEY: "test-secret-key",
  };
}

/**
 * Seedance, declared the way the real adapter declares itself, recording what
 * it was asked for.
 *
 * The id prefix matters: the route finds its provider by looking for one that
 * starts with `seedance`, because that is what `seedanceProviderId` builds and
 * a registry may hold several.
 */
class RecordingSeedance implements GenerationProvider {
  readonly id = "seedance-test";
  readonly seen: VideoGenerationRequest[] = [];

  constructor(private readonly videoReferences = true) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Recording Seedance",
      models: ["seedance-test-1"],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      maxImageReferences: 10,
      stableImageReferences: 4,
      addressing: ["hosted-url"],
      nativeGrouping: false,
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      supportsNegativePrompt: false,
      textToVideo: true,
      imageToVideo: true,
      videoReferences: this.videoReferences,
      startEndFrames: true,
      framesExcludeReferences: true,
      audioReferences: false,
      generatesAudio: false,
      outputFormats: [],
      seed: true,
      durationSecondsRange: [4, 30],
      sizes: ["480p", "720p", "1080p"],
      aspectRatios: ["16:9", "9:16"],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    this.seen.push(request);
    return { providerJobId: `sd_${this.seen.length}`, state: { status: "queued" } };
  }

  async getJob(): Promise<ProviderJobState> {
    return { status: "running" };
  }
}

interface Harness {
  service: TestService;
  seedance: RecordingSeedance;
  clipId: string;
  close: () => Promise<void>;
}

async function harness(
  options: { seedance?: RecordingSeedance } = {},
): Promise<Harness> {
  const seedance = options.seedance ?? new RecordingSeedance();
  const bucket = await stubBucket();
  const service = await startTestService({
    registry: new ProviderRegistry()
      .register(new MockImageProvider({ latencyMs: 0, sizes: ["64x64"] }))
      .register(seedance),
    env: hosting(bucket.endpoint),
  });

  const clipId = await adoptClip(service, "newsreel 1936.mp4");

  return {
    service,
    seedance,
    clipId,
    close: async () => {
      await service.close();
      await bucket.close();
    },
  };
}

/** A clip on disk, adopted into the library. */
async function adoptClip(service: TestService, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "seed archive "));
  const file = path.join(dir, name);
  await writeFile(file, fakeMp4(720, 576, 8));
  const adopted = await service.call("/v1/assets/adopt", {
    method: "POST",
    body: JSON.stringify({ path: file }),
  });
  return (await readJson(adopted)).asset.id as string;
}

function restore(service: TestService, body: unknown): Promise<Response> {
  return service.call("/v1/restore", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Waits for the background dispatch to reach the adapter.
 *
 * `/v1/restore` answers 202 as soon as the jobs are durable and calls the
 * provider afterwards — which is the point of a job queue, and the reason
 * asserting on the request body needs a moment to pass first.
 */
async function seen(count: number, of: { seen: unknown[] }): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (of.seen.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the provider was only asked ${of.seen.length} times, wanted ${count}`);
}

describe("the restoration catalogue", () => {
  it("hands over what each treatment can promise, not just its name", async () => {
    const { service, close } = await harness();
    try {
      const response = await service.call("/v1/restore/presets");
      expect(response.status).toBe(200);
      const { presets } = await readJson(response);

      expect(presets.map((p: { treatment: string }) => p.treatment)).toEqual([
        "detail",
        "clean",
        "repair",
        "colourise",
      ]);

      // The fidelity line is the sentence an editor reads before committing a
      // shot to a cut, so the service is its single author.
      const colourise = presets.find(
        (p: { treatment: string }) => p.treatment === "colourise",
      );
      expect(colourise.fidelity).toMatch(/invents colour/i);
    } finally {
      await close();
    }
  });
});

describe("restoring a clip", () => {
  it("sends no duration and no aspect, so the result follows the footage", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["colourise"],
      });
      expect(response.status).toBe(202);
      await seen(1, seedance);

      const request = seedance.seen[0];
      /*
       * The whole guarantee. Ark reads a reference clip with no stated
       * duration as an edit and sends `duration: -1`, which makes the output
       * follow the input exactly. State a duration and the same request
       * becomes a new shot of a chosen length; state a ratio and it reframes.
       */
      expect(request?.durationSeconds).toBeUndefined();
      expect(request?.aspectRatio).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("hands the clip over as a reference and never as a first frame", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      await restore(service, { sourceAssetId: clipId, treatments: ["repair"] });
      await seen(1, seedance);

      const request = seedance.seen[0];
      // A frame anchors the opening and lets the model animate away from it,
      // which is the one thing a restoration must never do.
      expect(request?.firstFrame).toBeUndefined();
      expect(request?.lastFrame).toBeUndefined();
      expect(request?.references?.[0]?.mimeType.startsWith("video/")).toBe(true);
    } finally {
      await close();
    }
  });

  it("upscales by asking for the best tier rather than the provider default", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      await restore(service, { sourceAssetId: clipId, treatments: ["detail"] });
      await seen(1, seedance);

      // Seedance's own default is the bottom of the ladder, which would make a
      // "restoration" that came back smaller than it went in.
      expect(seedance.seen[0]?.size).toBe("1080p");
    } finally {
      await close();
    }
  });

  it("runs one job per treatment, and names them all", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail", "clean", "repair", "colourise"],
      });
      expect(response.status).toBe(202);

      const { started } = await readJson(response);
      expect(started).toHaveLength(4);
      await seen(4, seedance);

      // Every pass is identified, which is what makes four progress bars a
      // comparison rather than a row.
      expect(
        started.map((entry: { treatment: string }) => entry.treatment),
      ).toEqual(["detail", "clean", "repair", "colourise"]);

      // Four different prompts, not one repeated — each treatment excludes the
      // others explicitly or the passes could not be compared.
      expect(new Set(seedance.seen.map((request) => request.prompt)).size).toBe(4);
    } finally {
      await close();
    }
  });

  it("records the treatment and the source so a pass can be found again", async () => {
    const { clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["colourise"],
        note: "Manchester, 1936",
      });
      const { started } = await readJson(response);

      const generation = await service.call(
        `/v1/generations/${started[0].job.generation.id}`,
      );
      const record = (await readJson(generation)).generation;

      expect(record.parameters.seedRestore).toBe("colourise");
      expect(record.parameters.seedRestoreSource).toBe(clipId);
      expect(record.parameters.seedRestoreNote).toBe("Manchester, 1936");
      // The note reaches the model framed as information, not as an order.
      expect(record.prompt).toContain("Manchester, 1936");
      expect(record.prompt).toContain("never as permission to change the shot");
      // And the restored clip descends from the footage it came from.
      expect(record.parentAssetId).toBe(clipId);
    } finally {
      await close();
    }
  });

  it("turns down a still, and points at the thing that would work", async () => {
    const { service, close } = await harness();
    try {
      const size = 32;
      const rgba = new Uint8Array(size * size * 4).fill(180);
      const dir = await mkdtemp(path.join(tmpdir(), "seed still "));
      const file = path.join(dir, "photo.png");
      await writeFile(file, encodePng(size, size, rgba));
      const adopted = await service.call("/v1/assets/adopt", {
        method: "POST",
        body: JSON.stringify({ path: file }),
      });
      const { asset } = await readJson(adopted);

      const response = await restore(service, {
        sourceAssetId: asset.id,
        treatments: ["detail"],
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error.message).toMatch(/work area/);
    } finally {
      await close();
    }
  });

  it("says which key is missing when there is no Seedance at all", async () => {
    const bucket = await stubBucket();
    const service = await startTestService({
      registry: new ProviderRegistry().register(
        new MockImageProvider({ latencyMs: 0, sizes: ["64x64"] }),
      ),
      env: hosting(bucket.endpoint),
    });
    try {
      const clipId = await adoptClip(service, "reel.mp4");
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail"],
      });
      expect(response.status).toBe(422);
      // Naming the key beats "provider not found": the artist can act on one.
      expect((await readJson(response)).error.message).toMatch(/ARK_API_KEY/);
    } finally {
      await service.close();
      await bucket.close();
    }
  });

  it("refuses before starting anything when the provider cannot take a clip", async () => {
    const { service, clipId, seedance, close } = await harness({
      seedance: new RecordingSeedance(false),
    });
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail", "clean"],
      });
      /*
       * Caught at the route rather than left to the generation service, which
       * would refuse each job separately and leave two failed renders in the
       * history for a request that was never going to work.
       */
      expect(response.status).toBe(422);
      expect((await readJson(response)).error.message).toMatch(/as a reference/);
      expect(seedance.seen).toHaveLength(0);

      const jobs = await readJson(await service.call("/v1/jobs"));
      expect(jobs.jobs).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe("what a clip costs against a provider's budget", () => {
  it("counts a clip against video references, not the image budget", async () => {
    /*
     * `maxImageReferences` is an *image* count. Counting every input against
     * it made a video-reference provider unusable: Reframe takes exactly one
     * clip and no images, so it declares zero — and a single clip was then
     * refused here, before the adapter that wanted it ever ran. True from the
     * day Reframe was registered, and found because restoration is built
     * entirely on video references.
     */
    const noImages = new (class extends RecordingSeedance {
      override async capabilities(): Promise<ProviderCapabilities> {
        return { ...(await super.capabilities()), maxImageReferences: 0 };
      }
    })();

    const { service, clipId, close } = await harness({ seedance: noImages });
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail"],
      });
      expect(response.status).toBe(202);
      await seen(1, noImages);
    } finally {
      await close();
    }
  });

  it("still refuses a clip to a provider that does not take one", async () => {
    const service = await startTestService({
      registry: new ProviderRegistry()
        .register(new MockImageProvider({ latencyMs: 0, sizes: ["64x64"] }))
        // videoReferences defaults to false, like most video models.
        .register(new MockVideoProvider({ latencyMs: 0 })),
    });
    try {
      const clipId = await adoptClip(service, "reel.mp4");
      const response = await service.call("/v1/generations", {
        method: "POST",
        body: JSON.stringify({
          providerId: "mock-video",
          operation: "video.generate",
          prompt: "a shot",
          inputAssetIds: [clipId],
          inputRoles: ["reference"],
        }),
      });
      expect(response.status).toBe(422);
      expect((await readJson(response)).error.message).toMatch(/does not take a clip/);
    } finally {
      await service.close();
    }
  });
});
