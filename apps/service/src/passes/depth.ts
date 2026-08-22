import { SeedError } from "@seed-ae/domain";
import type { RasterImage } from "@seed-ae/media";

/**
 * Depth, measured rather than asked for.
 *
 * Depth Anything V2 ships ONNX weights, and transformers.js runs them through
 * ONNX Runtime inside this process — no Python, no sidecar, CPU if there is no
 * GPU. That matters more than it sounds: it turns the normal map SEED derives
 * from a plausible drawing into an actual measurement, and it costs nothing
 * per frame once the weights are on disk.
 *
 * **Loaded lazily and never at startup.** The weights are a download on first
 * use, and a service that fetched fifty megabytes before answering /health
 * would be a service nobody could run offline. Anyone who never opens ROO
 * never pays for this.
 *
 * The model is configurable because the small variant is the sensible default
 * and not the only reasonable choice — `base` and `large` exist and are better
 * and slower.
 */

/** What transformers.js hands back from a depth pipeline. */
interface DepthResult {
  depth: { data: Uint8Array | Float32Array; width: number; height: number };
}

type DepthPipeline = (input: unknown) => Promise<DepthResult>;

let pipelinePromise: Promise<DepthPipeline> | undefined;

export const DEFAULT_DEPTH_MODEL = "onnx-community/depth-anything-v2-small";

/**
 * The pipeline, built once and reused.
 *
 * Cached on the promise rather than the result, so two requests arriving
 * together share one download instead of racing into two.
 */
async function depthPipeline(model: string): Promise<DepthPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      let transformers: typeof import("@huggingface/transformers");
      try {
        transformers = await import("@huggingface/transformers");
      } catch (cause) {
        throw new SeedError(
          "unsupported_capability",
          "local depth needs @huggingface/transformers, which is not installed",
          { cause },
        );
      }
      const built = await transformers.pipeline("depth-estimation", model);
      return built as unknown as DepthPipeline;
    })().catch((error: unknown) => {
      // A failed load must not poison every later attempt: a download can fail
      // once and succeed on a second try.
      pipelinePromise = undefined;
      throw error;
    });
  }
  return pipelinePromise;
}

/**
 * A depth map for a frame, as an ordinary greyscale image.
 *
 * The pixels go in as data rather than as a path, so the file is decoded once
 * by SEED's own decoder — which already handles the 16-bit PNGs After Effects
 * writes — instead of a second time by something else.
 *
 * Normalised to fill 0–255 across the frame's own range. Depth Anything is
 * relative rather than metric, so an absolute scale would be a fiction; what
 * matters downstream is the *shape* of the surface, which normalising
 * preserves and which normalsFromDepth is the consumer of.
 */
export async function estimateDepth(
  image: RasterImage,
  model = DEFAULT_DEPTH_MODEL,
): Promise<RasterImage> {
  const pipeline = await depthPipeline(model);

  const { RawImage } = await import("@huggingface/transformers");
  const input = new RawImage(
    new Uint8ClampedArray(image.rgba),
    image.width,
    image.height,
    4,
  );

  const result = await pipeline(input);
  const map = result?.depth;
  if (!map?.data || !map.width || !map.height) {
    throw new SeedError("provider_error", "the depth model returned nothing usable");
  }

  let low = Infinity;
  let high = -Infinity;
  for (const value of map.data) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high - low;

  const rgba = new Uint8Array(map.width * map.height * 4);
  for (let index = 0; index < map.width * map.height; index += 1) {
    const value = map.data[index] ?? 0;
    // A frame with no depth variation at all would divide by zero; mid grey is
    // the honest answer for "everything is the same distance away".
    const level = span > 1e-6 ? Math.round(((value - low) / span) * 255) : 128;
    const at = index * 4;
    rgba[at] = level;
    rgba[at + 1] = level;
    rgba[at + 2] = level;
    rgba[at + 3] = 255;
  }

  return { width: map.width, height: map.height, rgba };
}

/** Whether the weights are already loaded, for the panel to say so. */
export function depthReady(): boolean {
  return pipelinePromise !== undefined;
}
