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

/** A still on disk, adopted into the library. */
async function adoptStill(service: TestService, name: string): Promise<string> {
  const size = 32;
  const rgba = new Uint8Array(size * size * 4).fill(180);
  const dir = await mkdtemp(path.join(tmpdir(), "seed still "));
  const file = path.join(dir, name);
  await writeFile(file, encodePng(size, size, rgba));
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
  it("hands over the look as editable text, not a hidden prompt", async () => {
    const { service, close } = await harness();
    try {
      const response = await service.call("/v1/restore/presets");
      expect(response.status).toBe(200);
      const { presets } = await readJson(response);

      expect(presets.map((p: { id: string }) => p.id)).toEqual([
        "detail",
        "sharp",
        "monochrome",
        "colourise",
        "clean",
      ]);

      /*
       * The look is served as editable *text*, not as a hidden prompt behind
       * an id. That is the whole difference between a control and a black box:
       * the panel drops this straight into a field the artist can rewrite.
       */
      const detail = presets.find((p: { id: string }) => p.id === "detail");
      expect(detail.look).toMatch(/35mm/);
      expect(detail.look.length).toBeGreaterThan(120);
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
        look: "shot on Kodachrome, fine grain, muted period colour",
        preset: "colourise",
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
      await restore(service, {
        sourceAssetId: clipId,
        look: "a pristine first-generation print, fine natural grain",
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

  it("always names a size, even when the provider mixes tiers with shapes", async () => {
    /*
     * Seedream offers "2K" and "4K" alongside explicit sizes like
     * "2160x3840". The old helper declined on a mixed list — right for the
     * Generate form, where picking a portrait size would be a creative
     * decision — and so no size was sent at all, and a "4K key frame" came
     * back as a 2848x1600 JPEG. A restoration already has a source frame, so
     * its shape is a fact and there is nothing to decline.
     */
    const mixed = new (class extends RecordingSeedance {
      override async capabilities(): Promise<ProviderCapabilities> {
        return {
          ...(await super.capabilities()),
          sizes: ["2K", "4K", "1920x1080", "2160x3840"],
        };
      }
    })();
    const { service, clipId, close } = await harness({ seedance: mixed });
    try {
      await restore(service, { sourceAssetId: clipId, look: "sharp, detailed" });
      await seen(1, mixed);
      expect(mixed.seen[0]?.size).toBe("4K");
    } finally {
      await close();
    }
  });

  it("upscales by asking for the best tier rather than the provider default", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      await restore(service, {
        sourceAssetId: clipId,
        look: "35mm colour negative, enormous surface detail",
      });
      await seen(1, seedance);

      // Seedance's own default is the bottom of the ladder, which would make a
      // "restoration" that came back smaller than it went in.
      expect(seedance.seen[0]?.size).toBe("1080p");
    } finally {
      await close();
    }
  });

  it("sends the artist's own words, not the preset they started from", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        // Started from a preset, then rewritten. What is on screen is what
        // gets sent, or the field is a decoration rather than a control.
        preset: "detail",
        look: "grainy 16mm reversal stock, blown highlights, heavy halation",
      });
      expect(response.status).toBe(202);
      await seen(1, seedance);

      const prompt = seedance.seen[0]?.prompt ?? "";
      expect(prompt).toContain("grainy 16mm reversal stock");
      expect(prompt).not.toContain("35mm colour negative");
    } finally {
      await close();
    }
  });

  it("carries the latitude setting into the prompt and the recipe", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        look: "35mm colour negative, enormous surface detail",
        freedom: 100,
      });
      const { started } = await readJson(response);
      await seen(1, seedance);

      // A slider wired to nothing is indistinguishable from one that works,
      // so the wording it selects is asserted rather than assumed.
      expect(seedance.seen[0]?.prompt).toContain("Reinterpret the surfaces");

      const generation = await service.call(
        `/v1/generations/${started[0].job.generation.id}`,
      );
      const record = (await readJson(generation)).generation;
      // Recorded, because a render that came back wrong is only debuggable if
      // the setting that produced it survived.
      expect(record.parameters.seedRestoreFreedom).toBe(100);
    } finally {
      await close();
    }
  });

  it("defaults the latitude to the middle when the panel sends none", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      await restore(service, { sourceAssetId: clipId, look: "sharp, detailed" });
      await seen(1, seedance);
      expect(seedance.seen[0]?.prompt).toContain("recognisably itself");
    } finally {
      await close();
    }
  });

  it("leads with the anchor and closes with the stability line", async () => {
    const { seedance, clipId, service, close } = await harness();
    try {
      await restore(service, {
        sourceAssetId: clipId,
        look: "fine-grained 35mm, enormous surface detail",
      });
      await seen(1, seedance);
      const prompt = seedance.seen[0]?.prompt ?? "";

      /*
       * The shape BytePlus document, and the shape the first version had
       * inverted: anchor, then what to make, then a short constraint tail.
       * The anchor also has to stay first for a reason that is not stylistic —
       * Ark classifies the task from the prompt, and only an edit may send
       * `duration: -1`.
       */
      expect(prompt.startsWith("Re-render this exact footage")).toBe(true);
      expect(prompt.indexOf("35mm")).toBeLessThan(prompt.indexOf("no flicker"));
      expect(prompt.trimEnd().endsWith("no invented objects or people.")).toBe(true);
    } finally {
      await close();
    }
  });

  it("records the look and the source so a render can be found again", async () => {
    const { clipId, service, close } = await harness();
    try {
      const response = await restore(service, {
        sourceAssetId: clipId,
        preset: "colourise",
        look: "period colour stock, muted, believable skin tones",
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
      // The look is kept verbatim, so a render can be repeated or adjusted
      // without reconstructing what was asked for from the prompt.
      expect(record.parameters.seedRestoreLook).toContain("period colour stock");
      // The note reaches the model framed as background, not as an order.
      expect(record.prompt).toContain("Manchester, 1936");
      expect(record.prompt).toContain("background for the render");
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
        look: "35mm, sharp, detailed",
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
        look: "35mm, sharp, detailed",
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
        look: "35mm, sharp, detailed",
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

describe("the key frame", () => {
  it("sends the still beside the clip as a reference, never as a first frame", async () => {
    /*
     * The whole architecture rests on this. `first_frame` is refused beside
     * reference media — "first/last frame content cannot be mixed with
     * reference media content" — and the clip must be reference media for its
     * motion to be read at all. Image and video references, however, combine
     * freely; verified 2026-08-11. So the sharp still is a reference too.
     */
    const { seedance, clipId, service, close } = await harness();
    try {
      const still = await adoptStill(service, "keyframe.png");
      await restore(service, {
        sourceAssetId: clipId,
        look: "modern digital cinema camera, fully resolved",
        keyframeAssetId: still,
      });
      await seen(1, seedance);

      const request = seedance.seen[0];
      expect(request?.firstFrame).toBeUndefined();
      expect(request?.lastFrame).toBeUndefined();
      expect(request?.references).toHaveLength(2);
      const kinds = (request?.references ?? []).map((r) =>
        r.mimeType.startsWith("video/") ? "video" : "image",
      );
      expect(kinds).toEqual(["video", "image"]);
    } finally {
      await close();
    }
  });

  it("records which still a render was aimed at", async () => {
    const { clipId, service, close } = await harness();
    try {
      const still = await adoptStill(service, "keyframe.png");
      const response = await restore(service, {
        sourceAssetId: clipId,
        look: "modern digital cinema camera",
        keyframeAssetId: still,
      });
      const { started } = await readJson(response);
      const generation = await service.call(
        `/v1/generations/${started[0].job.generation.id}`,
      );
      const record = (await readJson(generation)).generation;
      // Without this the two halves of a two-step feature cannot be paired up
      // again afterwards, and a good result cannot be repeated.
      expect(record.parameters.seedRestoreKeyframe).toBe(still);
    } finally {
      await close();
    }
  });

  it("turns down a still as the source, since a frame comes out of a clip", async () => {
    const { service, close } = await harness();
    try {
      const still = await adoptStill(service, "photo.png");
      const response = await service.call("/v1/restore/keyframe", {
        method: "POST",
        body: JSON.stringify({ sourceAssetId: still, look: "sharp and detailed" }),
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error.message).toMatch(/comes out of a clip/);
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
        look: "35mm, sharp, detailed",
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
