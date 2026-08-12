import { describe, expect, it } from "vitest";
import {
  ARTEFACT_PARAMS,
  DEFAULTS,
  PRESETS,
  SHOW_MATCH,
  modifiedFromPreset,
  resolveConfig,
  STOCKS,
} from "../src/index.js";

/**
 * The show preset's fully resolved configuration, as shipped in the handoff.
 *
 * This is a golden vector, not a restatement of the implementation: it is the
 * config the reference engine produced, so anything that disagrees with it is
 * our bug. Every one of the 66 parameters is here on purpose — the fields that
 * go wrong are the ones nobody thought to check.
 */
const RESOLVED_HALF = {
  dof_enable: false,
  fstop: 2.8,
  focus_xy: [0.7, 0.55],
  focus_depth: null,
  dof_max_blur: 0.012,
  dof_levels: 16,
  bokeh_blades: 6,
  bokeh_rotation: 12,
  bokeh_fringe: 0.05,
  depth_near_is: "low",
  ca_lateral: 0.0015,
  distortion_k1: -0.0075,
  distortion_k2: 0.002,
  vignette: 0.15,
  vignette_mech: 0.05,
  glare_threshold: 0.8,
  glare_radius: 0.012,
  glare_intensity: 0.05,
  stock: "kodak_5217",
  exposure: 0.97,
  grain_enable: true,
  grain_scale: 0.5,
  grain_size: 0.5,
  grain_ref_longedge: 4096,
  halation_scale: 0.5,
  halation_radius: 0.01,
  halation_tint: [1, 0.45, 0.25],
  halation_color: 0.12,
  grain_chroma: 0.8,
  haze: 0,
  haze_color: [0.62, 0.67, 0.72],
  path_to_white: 0,
  wp_tonemap: 1,
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

describe("resolveConfig", () => {
  it("reproduces the shipped show config exactly", () => {
    const resolved = resolveConfig({ preset: "show-match", intensity: 1 });
    expect(resolved).toEqual(RESOLVED_HALF);
    expect(Object.keys(resolved)).toHaveLength(66);
  });

  it("reaches the full artefact column at intensity 2", () => {
    /*
     * The handoff ships both columns and the full one is exactly twice the
     * half. That is the property the slider depends on, so it is asserted
     * rather than assumed.
     */
    const full = resolveConfig({ preset: "show-match", intensity: 2 });
    expect(full.grain_scale).toBeCloseTo(1, 12);
    expect(full.ca_lateral).toBeCloseTo(0.003, 12);
    expect(full.vignette).toBeCloseTo(0.3, 12);
    expect(full.vignette_mech).toBeCloseTo(0.1, 12);
    expect(full.halation_scale).toBeCloseTo(1, 12);
    expect(full.halation_color).toBeCloseTo(0.24, 12);
    expect(full.glare_intensity).toBeCloseTo(0.1, 12);
    expect(full.distortion_k1).toBeCloseTo(-0.015, 12);
    expect(full.distortion_k2).toBeCloseTo(0.004, 12);
  });

  it("turns every camera artefact off at intensity 0, and nothing else", () => {
    /*
     * This is the correct response to footage that already has real
     * distortion, vignetting or grain — doubling them is the classic tell. So
     * 0 has to be an exact off switch, not merely a small number.
     */
    const off = resolveConfig({ preset: "show-match", intensity: 0 });
    for (const key of ARTEFACT_PARAMS) expect(off[key]).toBe(0);

    const authored = resolveConfig({ preset: "show-match", intensity: 1 });
    expect(off.stock).toBe(authored.stock);
    expect(off.wp_tonemap).toBe(authored.wp_tonemap);
    expect(off.exposure).toBe(authored.exposure);
  });

  it("never lets intensity touch the look", () => {
    const look: (keyof typeof DEFAULTS)[] = [
      "stock",
      "wp_tonemap",
      "wp",
      "wp_gain",
      "wp_gamma",
      "exposure",
      "grain_chroma",
      "grain_size",
      "grain_ref_longedge",
    ];
    const half = resolveConfig({ preset: "show-match", intensity: 1 });
    for (const intensity of [0, 0.5, 1.5, 2]) {
      const scaled = resolveConfig({ preset: "show-match", intensity });
      for (const key of look) expect(scaled[key]).toEqual(half[key]);
    }
  });

  it("lets the artist's overrides win over the preset", () => {
    const config = resolveConfig({
      preset: "show-match",
      intensity: 1,
      overrides: { grain_scale: 0.9, prompt_free: undefined } as never,
    });
    expect(config.grain_scale).toBe(0.9);
    // And the rest of the preset survives being overridden on one field.
    expect(config.stock).toBe("kodak_5217");
  });

  it("applies overrides after intensity, not before", () => {
    // Otherwise an artist setting grain by hand would find it silently scaled.
    const config = resolveConfig({
      preset: "show-match",
      intensity: 2,
      overrides: { grain_scale: 0.25 },
    });
    expect(config.grain_scale).toBe(0.25);
  });

  it("falls back to engine defaults with no preset", () => {
    expect(resolveConfig()).toEqual(DEFAULTS);
  });

  it("rejects an unknown preset and an unknown stock by name", () => {
    expect(() => resolveConfig({ preset: "nope" })).toThrow(/unknown film look preset/);
    expect(() => resolveConfig({ overrides: { stock: "nope" } })).toThrow(
      /unknown film stock/,
    );
  });

  it("rejects a negative intensity rather than inverting the artefacts", () => {
    expect(() => resolveConfig({ preset: "show-match", intensity: -1 })).toThrow(
      /non-negative/,
    );
  });
});

describe("the shipped presets", () => {
  it("all resolve, and name a stock that exists", () => {
    for (const preset of PRESETS) {
      const config = resolveConfig({ preset: preset.id });
      expect(STOCKS[config.stock]).toBeDefined();
    }
  });

  it("keeps clean optics genuinely clean", () => {
    const clean = resolveConfig({ preset: "clean-optics" });
    for (const key of ARTEFACT_PARAMS) expect(clean[key]).toBe(0);
    expect(clean.wp_tonemap).toBe(0);
    expect(clean.grain_enable).toBe(false);
    expect(clean.stock).toBe("clean");
  });

  it("carries no production codename", () => {
    /*
     * The material this came from belongs to an unannounced production and
     * this repository is published. The values are the point; the label is the
     * only part that carries risk.
     */
    const text = JSON.stringify(PRESETS).toLowerCase();
    expect(text).not.toContain("satoshi");
    expect(SHOW_MATCH.id).toBe("show-match");
  });
});

describe("modifiedFromPreset", () => {
  it("reports nothing when a config is its preset", () => {
    const config = resolveConfig({ preset: "show-match", intensity: 1 });
    expect(modifiedFromPreset(config, { preset: "show-match", intensity: 1 })).toEqual(
      [],
    );
  });

  it("names exactly what was touched", () => {
    const config = resolveConfig({
      preset: "show-match",
      intensity: 1,
      overrides: { sharpen: 0.4, temp: -0.1 },
    });
    const modified = modifiedFromPreset(config, {
      preset: "show-match",
      intensity: 1,
    });
    expect(modified.sort()).toEqual(["sharpen", "temp"]);
  });
});
