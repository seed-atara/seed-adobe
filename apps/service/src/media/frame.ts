import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SeedError } from "@seed-ae/domain";
import { ffmpegPath } from "./proxy.js";

const run = promisify(execFile);

/**
 * One frame out of a clip, as a PNG on disk.
 *
 * Exists for the key-frame route, and the reason it is worth a file of its own
 * is what that route is for. A video model asked to improve a degraded clip
 * re-renders it and cannot exceed what the source resolved — measured, and the
 * result was worse than the input. An *image* model given the same frame will
 * happily paint a real photograph of the same scene, because that is the job
 * image models are good at.
 *
 * So the frame has to come out before anything else can happen, and it has to
 * come out at the clip's native resolution: handing a downscaled still to
 * Seedream would cap the detail before the model ever ran.
 */
export async function extractFrame(
  video: string,
  destination: string,
  options: { atSeconds?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const ffmpeg = ffmpegPath(options.env);
  if (!ffmpeg) {
    throw new SeedError(
      "unsupported_capability",
      "pulling a frame out of a clip needs ffmpeg, and none was found. The " +
        "SEED companion ships one; a dev service uses SEED_FFMPEG or PATH.",
    );
  }

  const at = Math.max(options.atSeconds ?? 0, 0);
  try {
    /*
     * `-ss` before `-i` seeks on the container rather than decoding up to the
     * timestamp, which on a 4K clip is the difference between instant and
     * tens of seconds. It lands on the nearest keyframe rather than the exact
     * time, and for choosing a representative frame that is fine.
     *
     * No scale filter: native resolution, for the reason in the header.
     */
    await run(
      ffmpeg,
      ["-y", "-v", "error", "-ss", String(at), "-i", video, "-frames:v", "1", destination],
      { windowsHide: true, maxBuffer: 1 << 26 },
    );
  } catch (cause) {
    throw new SeedError(
      "provider_error",
      `could not read a frame from ${path.basename(video)}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }

  return destination;
}
