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
 * contain. That is not perversity: a restoration is defined by its omissions.
 * A stated duration turns it into a re-cut, a stated ratio reframes it, and a
 * clip handed over as a first frame becomes a shot that animates away from
 * itself. Each of those is a one-line change away at all times, and each would
 * look like a working feature until an editor noticed the shot had moved.
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
 * presigned URL that comes back is never fetched: the doubles record the
 * request and do not resolve it.
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
 * A stand-in for the measured lane that records what it was asked for.
 *
 * Declares itself the way Topaz does — one clip, no images, no seed, no sizes
 * — so the capability check it passes here is the same one the real adapter
 * has to pass.
 */
class RecordingUpscaler implements GenerationProvider {
  readonly id = "topaz-upscale";
  readonly seen: VideoGenerationRequest[] = [];

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Recording Upscaler",
      models: ["fal-ai/topaz/upscale/video"],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      maxImageReferences: 0,
      stableImageReferences: 0,
      addressing: ["hosted-url"],
      nativeGrouping: false,
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      supportsNegativePrompt: false,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: true,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      generatesAudio: false,
      outputFormats: [],
      seed: false,
      sizes: [],
      aspectRatios: [],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    this.seen.push(request);
    return { providerJobId: `up_${this.seen.length}`, state: { status: "queued" } };
  }

  async getJob(): Promise<ProviderJobState> {
    return { status: "running" };
  }
}

/** The generated lane, declared the way Seedance is: takes a clip, has sizes. */
class RecordingSeedance implements GenerationProvider {
  readonly id = "seedance-test";
  readonly seen: VideoGenerationRequest[] = [];

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
      videoReferences: true,
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
  upscaler: RecordingUpscaler;
  seedance: RecordingSeedance;
  clipId: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const upscaler = new RecordingUpscaler();
  const seedance = new RecordingSeedance();
  const registry = new ProviderRegistry()
    .register(new MockImageProvider({ latencyMs: 0, sizes: ["64x64"] }))
    .register(upscaler)
    .register(seedance);

  const bucket = await stubBucket();
  const service = await startTestService({ registry, env: hosting(bucket.endpoint) });

  const clipId = await adoptClip(service, "newsreel 1936.mp4");

  return {
    service,
    upscaler,
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
  it("says what each lane can promise, per treatment", async () => {
    const { service, close } = await harness();
    try {
      const response = await service.call("/v1/restore/presets");
      expect(response.status).toBe(200);
      const { presets } = await readJson(response);

      const colourise = presets.find((p: { treatment: string }) => p.treatment === "colourise");
      // Colour has to be invented, so there is no measured lane to offer.
      expect(colourise.lanes.map((l: { lane: string }) => l.lane)).toEqual(["generated"]);

      const detail = presets.find((p: { treatment: string }) => p.treatment === "detail");
      expect(detail.lanes.map((l: { lane: string }) => l.lane)).toEqual([
        "measured",
        "generated",
      ]);
      // The measured lane cannot read a note, and says so through takesNote
      // rather than accepting one and discarding it.
      expect(detail.lanes[0].takesNote).toBe(false);
      expect(detail.lanes[1].takesNote).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("restoring a clip", () => {
  it("sends no duration and no aspect, so the result follows the footage", async () => {
    const { service, seedance, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["colourise"],
        lanes: ["generated"],
      });
      expect(response.status).toBe(202);
      await seen(1, seedance);

      const request = seedance.seen[0];
      expect(request).toBeDefined();
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
    const { service, seedance, clipId, close } = await harness();
    try {
      await restore(service, {
        sourceAssetId: clipId,
        treatments: ["repair"],
        lanes: ["generated"],
      });
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
    const { service, seedance, clipId, close } = await harness();
    try {
      await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail"],
        lanes: ["generated"],
      });
      await seen(1, seedance);

      // Seedance's own default is the bottom of the ladder, which would make a
      // "restoration" that came back smaller than it went in.
      expect(seedance.seen[0]?.size).toBe("1080p");
    } finally {
      await close();
    }
  });

  it("runs one job per treatment per lane, and names them all", async () => {
    const { service, upscaler, seedance, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail", "clean"],
        lanes: ["measured", "generated"],
      });
      expect(response.status).toBe(202);

      const { started, skipped } = await readJson(response);
      expect(started).toHaveLength(4);
      expect(skipped).toHaveLength(0);
      await seen(2, upscaler);
      await seen(2, seedance);

      // Every pair is identified, which is what makes four progress bars a
      // comparison rather than a grid.
      expect(
        started
          .map(
            (entry: { treatment: string; lane: string }) =>
              `${entry.treatment}/${entry.lane}`,
          )
          .sort(),
      ).toEqual([
        "clean/generated",
        "clean/measured",
        "detail/generated",
        "detail/measured",
      ]);
    } finally {
      await close();
    }
  });

  it("skips the combinations that cannot exist rather than refusing the lot", async () => {
    const { service, upscaler, seedance, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail", "colourise"],
        lanes: ["measured", "generated"],
      });
      expect(response.status).toBe(202);

      const { started, skipped } = await readJson(response);
      /*
       * Asking for everything is one gesture in the panel, and colour cannot
       * be measured. Refusing the whole request over one empty cell of the
       * grid would make the obvious gesture the wrong one.
       */
      expect(started).toHaveLength(3);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].treatment).toBe("colourise");
      expect(skipped[0].lane).toBe("measured");
      expect(skipped[0].reason).toMatch(/invent/);

      await seen(1, upscaler);
      await seen(2, seedance);
    } finally {
      await close();
    }
  });

  it("refuses only when nothing at all could run, and says why", async () => {
    const { service, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["colourise"],
        lanes: ["measured"],
      });
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.error.message).toMatch(/invent/);
    } finally {
      await close();
    }
  });

  it("carries no prompt to the measured lane, and says so in the recipe", async () => {
    const { service, upscaler, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["clean"],
        lanes: ["measured"],
        note: "this note has nowhere to go",
        upscaleFactor: 4,
      });
      const { started } = await readJson(response);
      await seen(1, upscaler);

      // The adapter is handed the factor and the treatment, not words.
      expect(upscaler.seen[0]?.parameters?.seedRestore).toBe("clean");
      expect(upscaler.seen[0]?.parameters?.upscaleFactor).toBe(4);

      /*
       * The recipe still needs a prompt field — an empty one reads as a bug —
       * so it holds a sentence saying none was sent. It must not hold anything
       * that looks like an instruction, and it must not hold the note.
       */
      const generation = await service.call(
        `/v1/generations/${started[0].job.generation.id}`,
      );
      const record = await readJson(generation);
      expect(record.generation.prompt).toMatch(/No prompt is sent/);
      expect(record.generation.prompt).not.toContain("nowhere to go");
      expect(record.generation.parameters.seedRestoreNote).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("records the treatment, the lane and the source so a pass can be found again", async () => {
    const { service, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["colourise"],
        lanes: ["generated"],
        note: "Manchester, 1936",
      });
      const { started } = await readJson(response);

      const generation = await service.call(
        `/v1/generations/${started[0].job.generation.id}`,
      );
      const record = (await readJson(generation)).generation;

      expect(record.parameters.seedRestore).toBe("colourise");
      expect(record.parameters.seedRestoreLane).toBe("generated");
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
        lanes: ["measured"],
      });
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.error.message).toMatch(/work area/);
    } finally {
      await close();
    }
  });

  it("says which key is missing when a lane is not configured", async () => {
    // Only the generated lane exists here — no upscaler was registered, which
    // is what an install with no fal key looks like.
    const seedance = new RecordingSeedance();
    const bucket = await stubBucket();
    const service = await startTestService({
      registry: new ProviderRegistry()
        .register(new MockImageProvider({ latencyMs: 0, sizes: ["64x64"] }))
        .register(seedance),
      env: hosting(bucket.endpoint),
    });
    try {
      const clipId = await adoptClip(service, "reel.mp4");

      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail"],
        lanes: ["measured", "generated"],
      });
      expect(response.status).toBe(202);

      const { started, skipped } = await readJson(response);
      expect(started).toHaveLength(1);
      // Naming the key beats "provider not found": the artist can act on one.
      expect(skipped[0].reason).toMatch(/FAL_KEY/);
    } finally {
      await service.close();
      await bucket.close();
    }
  });
});

describe("what a clip costs against a provider's budget", () => {
  it("lets a video-reference provider take a clip while declaring no image references", async () => {
    /*
     * Topaz and Reframe both take exactly one clip and no images, so they
     * declare `maxImageReferences: 0`. Counting every input against that image
     * budget refused the clip before the adapter that wanted it ever ran —
     * true of Reframe from the day it was registered, and found here because
     * restoration is built entirely on video references.
     */
    const { service, upscaler, clipId, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        treatments: ["detail"],
        lanes: ["measured"],
      });
      expect(response.status).toBe(202);
      await seen(1, upscaler);
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
      const body = await readJson(response);
      expect(body.error.message).toMatch(/does not take a clip/);
    } finally {
      await service.close();
    }
  });
});

