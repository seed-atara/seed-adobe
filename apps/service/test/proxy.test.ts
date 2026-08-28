import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureWorkspace,
  resolveWorkspace,
  type WorkspaceLayout,
} from "@seed-ae/storage";
import { ensureProxy, hasProxy, needsProxy, proxyPath } from "../src/media/proxy.js";

const run = promisify(execFile);

/**
 * The bundled binary, so this runs the same on every platform and in CI rather
 * than depending on whatever the machine happens to have on PATH.
 */
const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;

let root: string;
let workspace: WorkspaceLayout;
let master: string;

beforeAll(async () => {
  // A space in the path, like every real project folder.
  root = await mkdtemp(path.join(tmpdir(), "seed proxy "));
  workspace = await ensureWorkspace(resolveWorkspace(path.join(root, "Client Work")));

  /*
   * A real 4:4:4 master, not a stand-in. This is exactly what Seedance 2.5
   * returns at 1080p — H.264 High 4:4:4 Predictive, yuv444p10le — and it is
   * the thing no browser will open. Testing against an ordinary mp4 would
   * prove nothing, because an ordinary mp4 already plays.
   */
  master = path.join(root, "master 444.mov");
  await run(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=24:duration=2",
    "-c:v", "libx264", "-profile:v", "high444", "-pix_fmt", "yuv444p10le",
    master,
  ]);
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * What a file actually is, read from ffmpeg itself.
 *
 * Not ffprobe: `ffmpeg-static` ships only the one binary, and CI's macOS
 * runner has no ffprobe on PATH — which is exactly how this test passed here
 * and failed there. Asking the transcoder we already bundle keeps the check
 * honest on every machine.
 *
 * `ffmpeg -i` with no output writes the stream summary to stderr and exits
 * non-zero, so the rejection is the expected path rather than a failure.
 */
async function probe(file: string): Promise<{
  codec: string;
  pixelFormat: string;
  width: number;
}> {
  let stderr = "";
  try {
    stderr = (await run(ffmpeg, ["-hide_banner", "-i", file])).stderr;
  } catch (error) {
    stderr = (error as { stderr?: string }).stderr ?? "";
  }

  const line = stderr
    .split(/\r?\n/)
    .find((candidate) => /Stream #\d+:\d+.*Video:/.test(candidate));
  if (!line) throw new Error(`no video stream reported for ${file}:\n${stderr}`);

  return {
    codec: /Video:\s+([a-z0-9]+)/i.exec(line)?.[1] ?? "",
    pixelFormat: /\b(yuv[a-z0-9]+|gbr[a-z0-9]*|rgb[a-z0-9]*)\b/i.exec(line)?.[1] ?? "",
    width: Number(/\b(\d{2,5})x\d{2,5}\b/.exec(line)?.[1] ?? 0),
  };
}

describe("which clips need a proxy", () => {
  it("leaves alone what a browser already plays", () => {
    expect(needsProxy({ kind: "video", mimeType: "video/mp4" })).toBe(false);
    expect(needsProxy({ kind: "video", mimeType: "video/webm" })).toBe(false);
  });

  it("takes on quicktime, and anything it does not recognise", () => {
    expect(needsProxy({ kind: "video", mimeType: "video/quicktime" })).toBe(true);
    // An allowlist, deliberately: an unknown container is far more likely to be
    // unplayable than playable, and being wrong this way costs one encode
    // rather than a preview that silently never works.
    expect(needsProxy({ kind: "video", mimeType: "video/x-matroska" })).toBe(true);
  });

  it("ignores stills entirely", () => {
    expect(needsProxy({ kind: "image", mimeType: "image/png" })).toBe(false);
  });
});

describe("making the proxy", () => {
  it("turns a 4:4:4 master into something a browser can decode", async () => {
    const asset = { id: "asset-444", kind: "video" as const, mimeType: "video/quicktime" };

    const before = await probe(master);
    expect(before.pixelFormat).toBe("yuv444p10le");

    const result = await ensureProxy(workspace, asset, master, {
      env: { SEED_FFMPEG: ffmpeg },
    });

    expect(result?.encoded).toBe(true);
    expect(hasProxy(workspace, asset.id)).toBe(true);

    const after = await probe(result!.path);
    // The whole point: 4:2:0 is what Chromium can decode.
    expect(after.pixelFormat).toBe("yuv420p");
    expect(after.codec).toBe("h264");
    // Capped, never upscaled — a panel card never shows more than this.
    expect(after.width).toBeLessThanOrEqual(1280);
  }, 120_000);

  it("reuses a proxy that is already there rather than re-encoding", async () => {
    // Makes its own proxy rather than leaning on the test above: an ordering
    // dependency turns one failure into two and hides which was the real one.
    const asset = { id: "asset-reuse", kind: "video" as const, mimeType: "video/quicktime" };
    const first = await ensureProxy(workspace, asset, master, {
      env: { SEED_FFMPEG: ffmpeg },
    });
    expect(first?.encoded).toBe(true);

    const again = await ensureProxy(workspace, asset, master, {
      env: { SEED_FFMPEG: ffmpeg },
    });
    expect(again?.encoded).toBe(false);
    expect(again?.path).toBe(proxyPath(workspace, asset.id));
  }, 120_000);

  it("returns nothing rather than throwing when ffmpeg is absent", async () => {
    // A missing transcoder must never fail an ingest: the clip is already
    // generated and paid for, and the card falls back to its poster.
    const result = await ensureProxy(
      workspace,
      { id: "asset-no-ffmpeg", kind: "video", mimeType: "video/quicktime" },
      master,
      { env: { SEED_FFMPEG: path.join(root, "no-such-ffmpeg") } },
    );
    expect(result).toBeUndefined();
    expect(hasProxy(workspace, "asset-no-ffmpeg")).toBe(false);
  });

  it("returns nothing for a file ffmpeg cannot read, without throwing", async () => {
    const notVideo = path.join(root, "not a video.mov");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(notVideo, "this is not a container", "utf8");

    const result = await ensureProxy(
      workspace,
      { id: "asset-broken", kind: "video", mimeType: "video/quicktime" },
      notVideo,
      { env: { SEED_FFMPEG: ffmpeg } },
    );
    expect(result).toBeUndefined();
  }, 60_000);
});

describe("the preview route", () => {
  it("encodes a proxy on first request for a clip that predates the feature", async () => {
    // The case from the field: a library of 120 clips generated before proxies
    // existed. Nothing was written at ingest, so the only chance to make one is
    // when the panel asks to play it.
    const { startTestService } = await import("./helpers.js");
    const service = await startTestService();
    try {
      const registered = await service.call("/v1/assets/adopt", {
        method: "POST",
        body: JSON.stringify({ path: master }),
      });
      expect(registered.status).toBe(201);
      const { asset } = await registered.json();
      expect(asset.mimeType).toBe("video/quicktime");

      // Exactly what AssetVideo asks for.
      const preview = await service.call(`/v1/assets/${asset.id}/file?variant=preview`);
      expect(preview.status).toBe(200);
      // An mp4 the panel can decode, not the quicktime master.
      expect(preview.headers.get("content-type")).toBe("video/mp4");

      const bytes = Buffer.from(await preview.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);

      // And the master is untouched — asking for a preview must never be a
      // way to lose the deliverable.
      const original = await service.call(`/v1/assets/${asset.id}/file`);
      expect(original.headers.get("content-type")).toBe("video/quicktime");
    } finally {
      await service.close();
    }
  }, 180_000);
});
