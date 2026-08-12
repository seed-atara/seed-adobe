/**
 * The film look's parameter surface and its shipped defaults.
 *
 * Transcribed from the specification handoff. Two rules govern every value
 * here and both are easy to break by accident:
 *
 *   - **Spatial values are fractions of the image diagonal, never pixels.**
 *     That is what makes one preset hold at 1920x1080 and at 4096x2304. A
 *     radius written in pixels passes every visual check at the resolution it
 *     was authored on and fails silently everywhere else.
 *   - **`grain_size` is the sole exception** and is in pixels, with
 *     `grain_ref_longedge` deciding the resolution grain is generated at.
 *
 * Nothing is optional. Every parameter has a shipped value and none may be
 * undefined at render time, so a resolved config is always complete.
 */

/** A colour triple, in the order R, G, B. */
export type Rgb = readonly [number, number, number];

export interface FilmLookConfig {
  // --- Phase A: optics, in scene-linear -----------------------------------
  /** Needs a depth map. Off in the show preset; not implemented in P1. */
  dof_enable: boolean;
  fstop: number;
  focus_xy: Rgb | readonly [number, number];
  focus_depth: number | null;
  /** Max circle of confusion as a fraction of the diagonal, at f/1.4. */
  dof_max_blur: number;
  dof_levels: number;
  bokeh_blades: number;
  bokeh_rotation: number;
  /** Longitudinal CA — fringing in the bokeh, distinct from lateral CA. */
  bokeh_fringe: number;
  depth_near_is: "low" | "high";

  /** Lateral chromatic aberration. A camera artefact: do not stack it. */
  ca_lateral: number;
  /** Stylistic distortion. NOT the metrology lens model — see the lens spec. */
  distortion_k1: number;
  distortion_k2: number;
  /** cos^4 illumination falloff, in linear. Not crushed corners. */
  vignette: number;
  vignette_mech: number;

  glare_threshold: number;
  glare_radius: number;
  glare_intensity: number;

  stock: string;
  exposure: number;

  grain_enable: boolean;
  grain_scale: number;
  /** In PIXELS — the one spatial value that is not a fraction. Smaller = finer. */
  grain_size: number;
  /** Resolution grain is generated at. 0 = native; 4096 locks it to the look. */
  grain_ref_longedge: number;

  halation_scale: number;
  halation_radius: number;
  halation_tint: Rgb;
  /** Leaks green to push the halo from red toward orange. */
  halation_color: number;

  grain_chroma: number;
  haze: number;
  haze_color: Rgb;

  /** AgX-style highlight desaturation; a smooth path to white. */
  path_to_white: number;

  // The signature stage. Not interchangeable with a generic filmic curve.
  wp_tonemap: number;
  wp: number;
  wp_gain: number;
  wp_gamma: number;

  /** Weights grain toward shadows (1) versus peaking in mids (0). */
  grain_gate: number;

  // --- Phase B: the film and the grade, in display space ------------------
  /** Per-channel black/white point match. Powerful and easy to overdo. */
  auto_levels: number;
  contrast: number;
  contrast_pivot: number;
  saturation: number;
  lift: number;
  gain: number;
  cdl_slope: Rgb;
  cdl_offset: Rgb;
  cdl_power: Rgb;
  cdl_sat: number;
  temp: number;
  tint: number;
  bloom: number;
  bloom_radius: number;
  sharpen: number;
  clarity_radius: number;
  /** Blurs chroma only. The correct fix for AI colour speckle. */
  chroma_denoise: number;
  /** Tames upscaler rims. Must run BEFORE sharpen. */
  dehalo: number;
  diffusion: number;
  diffusion_radius: number;
  anamorphic: number;
  tonemap: number;
  split_tone: number;
  bleach: number;
  /** Negative softens, which is usually what an over-detailed AI frame needs. */
  clarity: number;
  fade: number;
  letterbox: boolean;
  aspect: number;
  /** Grain determinism. */
  seed: number;
}

/** Every control, with its shipped default. */
export const DEFAULTS: FilmLookConfig = {
  dof_enable: true,
  fstop: 2.8,
  focus_xy: [0.7, 0.55],
  focus_depth: null,
  dof_max_blur: 0.012,
  dof_levels: 16,
  bokeh_blades: 6,
  bokeh_rotation: 12,
  bokeh_fringe: 0.05,
  depth_near_is: "low",
  ca_lateral: 0.0018,
  distortion_k1: -0.015,
  distortion_k2: 0.004,
  vignette: 0.3,
  vignette_mech: 0.1,
  glare_threshold: 0.8,
  glare_radius: 0.012,
  glare_intensity: 0.1,
  stock: "vision3_500t",
  exposure: 1,
  grain_enable: true,
  grain_scale: 1,
  grain_size: 0.3,
  grain_ref_longedge: 0,
  halation_scale: 1,
  halation_radius: 0.01,
  halation_tint: [1, 0.45, 0.25],
  halation_color: 0,
  grain_chroma: 0.6,
  haze: 0,
  haze_color: [0.62, 0.67, 0.72],
  path_to_white: 0,
  wp_tonemap: 0,
  wp: 1.1,
  wp_gain: 1.2,
  wp_gamma: 0.937,
  grain_gate: 0,
  auto_levels: 0,
  contrast: 1,
  contrast_pivot: 0.5,
  saturation: 1,
  lift: 0,
  gain: 1,
  cdl_slope: [1, 1, 1],
  cdl_offset: [0, 0, 0],
  cdl_power: [1, 1, 1],
  cdl_sat: 1,
  temp: 0,
  tint: 0,
  bloom: 0,
  bloom_radius: 0.015,
  sharpen: 0,
  clarity_radius: 0.004,
  chroma_denoise: 0,
  dehalo: 0,
  diffusion: 0,
  diffusion_radius: 0.02,
  anamorphic: 0,
  tonemap: 0,
  split_tone: 0,
  bleach: 0,
  clarity: 0,
  fade: 0,
  letterbox: false,
  aspect: 2.39,
  seed: 7,
};

/**
 * The parameters an Intensity slider is allowed to scale.
 *
 * These are the *camera artefacts*. Scaling them gives an artist "more or less
 * camera" without ever drifting off the look — which is why the look layer
 * (tonemap, stock, exposure) must never appear in this list. Conflating the
 * two is how a preset stops being a preset.
 */
export const ARTEFACT_PARAMS = [
  "grain_scale",
  "ca_lateral",
  "vignette",
  "vignette_mech",
  "halation_scale",
  "halation_color",
  "glare_intensity",
  "distortion_k1",
  "distortion_k2",
] as const satisfies readonly (keyof FilmLookConfig)[];

export type ArtefactParam = (typeof ARTEFACT_PARAMS)[number];
