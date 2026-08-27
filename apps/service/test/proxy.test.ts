import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** What ffprobe says a file actually is. */
async function probe(file: string): Promise<Record<string, string>> {
  const probeBin = ffmpeg.replace(/ffmpeg(\.exe)?$/, (m) =>
    m.startsWith("ffmpeg.exe") ? "ffprobe.exe" : "ffprobe",
  );
  const bin = existsSync(probeBin) ? probeBin : "ffprobe";
  const { stdout } = await run(bin, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width",
    "-of", "default=nw=1", file,
  ]);
  return Object.fromEntries(
    stdout.trim().split(/\r?\n/).map((line) => line.split("=") as [string, string]),
  );
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
    expect(before.pix_fmt).toBe("yuv444p10le");

    const result = await ensureProxy(workspace, asset, master, {
      env: { SEED_FFMPEG: ffmpeg },
    });

    expect(result?.encoded).toBe(true);
    expect(hasProxy(workspace, asset.id)).toBe(true);

    const after = await probe(result!.path);
    // The whole point: 4:2:0 is what Chromium can decode.
    expect(after.pix_fmt).toBe("yuv420p");
    expect(after.codec_name).toBe("h264");
    // Capped, never upscaled — a panel card never shows more than this.
    expect(Number(after.width)).toBeLessThanOrEqual(1280);
  }, 120_000);

  it("reuses a proxy that is already there rather than re-encoding", async () => {
    const asset = { id: "asset-444", kind: "video" as const, mimeType: "video/quicktime" };
    const again = await ensureProxy(workspace, asset, master, {
      env: { SEED_FFMPEG: ffmpeg },
    });
    expect(again?.encoded).toBe(false);
    expect(again?.path).toBe(proxyPath(workspace, asset.id));
  });

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
