import { toLinear, toSrgb } from "./color.js";
import type { FilmLookConfig } from "./config.js";
import type { FloatImage } from "./image.js";
import { cloneImage } from "./image.js";
import { runPhaseA } from "./phaseA.js";
import { runPhaseB } from "./phaseB.js";
import { requireStock } from "./stocks.js";

export interface ApplyOptions {
  /**
   * Frame number, for grain determinism. Grain is stable within a frame so it
   * does not crawl under scrubbing, and different between frames so it does
   * not read as dirt on the lens.
   */
  frame?: number;
  /**
   * The image at the Phase A/B boundary, if it has already been computed for
   * this config. Phase A holds every expensive blur, so a grade change should
   * not pay for it twice.
   */
  checkpoint?: FloatImage;
}

export interface ApplyResult {
  image: FloatImage;
  /** The Phase A/B boundary, reusable while only Phase B parameters change. */
  checkpoint: FloatImage;
}

/**
 * The whole look, in the specified order.
 *
 * Input and output are both sRGB-encoded 0..1; the first half runs in
 * scene-linear. The order is the specification and this function is the only
 * place it exists — exposing the stages separately would let them be
 * rearranged, and the look would then break silently, in ways that read as
 * "the preset is wrong" rather than "the stack is wrong".
 *
 * The boundary between the phases is a natural checkpoint. Everything
 * expensive is in Phase A, so caching there makes live grading cost only the
 * display half.
 */
export function applyFilmLook(
  source: FloatImage,
  config: FilmLookConfig,
  options: ApplyOptions = {},
): ApplyResult {
  const stock = requireStock(config.stock);
  const frame = options.frame ?? 0;

  let checkpoint = options.checkpoint;
  if (!checkpoint) {
    const working = cloneImage(source);
    toLinear(working);
    const optical = runPhaseA(working, config, stock);
    toSrgb(optical);
    checkpoint = optical;
  }

  // Phase B mutates, so it must never be handed the cached checkpoint itself.
  const display = cloneImage(checkpoint);
  const image = runPhaseB(display, config, stock, frame);

  return { image, checkpoint };
}

/**
 * Whether a config change can reuse a checkpoint.
 *
 * Only Phase A parameters invalidate it. Getting this wrong in the safe
 * direction costs a re-render; getting it wrong in the other direction shows
 * the artist a stale image and lets them approve it.
 */
const PHASE_A_PARAMS: readonly (keyof FilmLookConfig)[] = [
  "exposure",
  "distortion_k1",
  "distortion_k2",
  "ca_lateral",
  "vignette",
  "vignette_mech",
  "diffusion",
  "diffusion_radius",
  "anamorphic",
  "bloom",
  "bloom_radius",
  "glare_threshold",
  "glare_radius",
  "glare_intensity",
  "halation_scale",
  "halation_radius",
  "halation_tint",
  "halation_color",
  "path_to_white",
  "tonemap",
  "wp_tonemap",
  "wp",
  "wp_gain",
  "wp_gamma",
  // The stock decides halation strength in Phase A as well as colour in B.
  "stock",
  // Depth-driven stages, for when they exist.
  "dof_enable",
  "fstop",
  "focus_xy",
  "focus_depth",
  "dof_max_blur",
  "haze",
  "haze_color",
];

export function checkpointStillValid(
  previous: FilmLookConfig,
  next: FilmLookConfig,
): boolean {
  return PHASE_A_PARAMS.every(
    (key) => JSON.stringify(previous[key]) === JSON.stringify(next[key]),
  );
}
