/**
 * A preview a browser will actually play.
 *
 * Seedance's `mov` is the better master and the reason we default to it: 4:4:4
 * chroma, H.264 High 4:4:4 Predictive below 1080p and HEVC Rext yuv444p10le at
 * 1080p. After Effects opens both. No browser opens either, so the panel — which
 * is Chromium — showed an empty box where the clip should be.
 *
 * The answer is not to degrade the master. It is to keep the master and write a
 * small 4:2:0 H.264 companion beside it, purely for the panel. The proxy is
 * disposable: it is derived, it is never an asset, it never appears in lineage,
 * and deleting the whole folder costs nothing but a re-encode.
 *
 * Best effort throughout. No ffmpeg, or a clip it will not read, means the card
 * falls back to the poster exactly as it does today — a missing preview must
 * never fail an ingest for a clip that is already generated and paid for.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Asset } from "@seed-ae/domain";
import type { WorkspaceLayout } from "@seed-ae/storage";

const run = promisify(execFile);

/**
 * Containers a browser can be relied on to decode.
 *
 * An allowlist rather than a list of things to transcode: an unknown container
 * is far more likely to be unplayable than playable, and the cost of being
 * wrong in this direction is one unnecessary encode rather than a preview that
 * silently does not work.
 */
const BROWSER_SAFE = new Set(["video/mp4", "video/webm"]);

export function needsProxy(asset: Pick<Asset, "kind" | "mimeType">): boolean {
  return asset.kind === "video" && !BROWSER_SAFE.has(asset.mimeType);
}

/** Where a given asset's proxy lives, whether or not it exists yet. */
export function proxyPath(workspace: WorkspaceLayout, assetId: string): string {
  return path.join(workspace.proxiesDir, `${assetId}.mp4`);
}

export function hasProxy(workspace: WorkspaceLayout, assetId: string): boolean {
  return existsSync(proxyPath(workspace, assetId));
}

/**
 * Finds ffmpeg, in the order that puts the shipped copy first.
 *
 * `SEED_FFMPEG` is what the companion sets, pointing at the binary it carries —
 * an artist has no ffmpeg on PATH and should not need one. A developer's own
 * install is the fallback, which keeps this working from a checkout with no
 * extra setup.
 */
export function ffmpegPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.SEED_FFMPEG?.trim();
  if (configured && existsSync(configured)) return configured;
  // Resolved by name, so PATH does the work. `undefined` here would mean "no
  // proxies", which is a worse default than trying and failing once.
  return configured ? undefined : "ffmpeg";
}

export interface ProxyResult {
  path: string;
  /** False when a usable proxy was already on disk. */
  encoded: boolean;
}

/**
 * Writes the proxy, or reports why it could not.
 *
 * The encode is deliberately modest: 720p is more than a panel card ever
 * shows, and a preview that takes longer than the generation it previews is
 * not a preview.
 */
export async function ensureProxy(
  workspace: WorkspaceLayout,
  asset: Pick<Asset, "id" | "kind" | "mimeType">,
  sourcePath: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProxyResult | undefined> {
  if (!needsProxy(asset)) return undefined;

  const target = proxyPath(workspace, asset.id);
  if (existsSync(target)) return { path: target, encoded: false };

  const ffmpeg = ffmpegPath(options.env);
  if (!ffmpeg) return undefined;

  mkdirSync(workspace.proxiesDir, { recursive: true });

  try {
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-y",
        "-i",
        sourcePath,
        // 4:2:0 is the whole point — it is what a browser can decode.
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        // Never upscale: `-2` keeps the height even, which H.264 requires.
        "-vf",
        "scale='min(1280,iw)':-2",
        // Puts the index at the front so playback can start before the whole
        // file is read — the panel loads these over HTTP.
        "-movflags",
        "+faststart",
        "-an",
        target,
      ],
      { timeout: options.timeoutMs ?? 120_000, windowsHide: true },
    );
  } catch {
    // No ffmpeg, a codec it cannot read, or a timeout. All the same outcome for
    // the artist, and all recoverable: the card shows the poster instead.
    return undefined;
  }

  return existsSync(target) ? { path: target, encoded: true } : undefined;
}
