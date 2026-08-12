import type { ArtefactParam, FilmLookConfig } from "./config.js";
import { DEFAULTS } from "./config.js";

/**
 * A preset is authored in two layers, and keeping them apart is the trick.
 *
 * `look` defines character — stock, tonemap, exposure — and is never diluted.
 * `intensity` holds the camera artefacts *as authored*, which the Intensity
 * control then scales. One slider gives "more or less camera" without ever
 * drifting off the look.
 */
export interface FilmLookPreset {
  id: string;
  label: string;
  description: string;
  /** Character. Fixed; the Intensity control must never touch these. */
  look: Partial<FilmLookConfig>;
  /** Camera artefacts at Intensity 1.0. */
  intensity: Partial<Record<ArtefactParam, number>>;
}

/*
 * NOTE ON NAMING. The handoff calls the reference preset by a production
 * codename, and the package it came from warns that the material belongs to an
 * unannounced production. This repository is published, so the preset carries a
 * neutral id and label here. Renaming it is a one-line change if and when the
 * production is public — the values are what matter and they are unchanged.
 */
export const SHOW_MATCH: FilmLookPreset = {
  id: "show-match",
  label: "Show match",
  description:
    "The delivered look of a feature trailer, matched against its master comp. " +
    "Ships at half camera; Intensity 2 is the full column.",
  look: {
    stock: "kodak_5217",
    wp_tonemap: 1,
    wp: 1.1,
    wp_gain: 1.2,
    wp_gamma: 0.937,
    grain_chroma: 0.8,
    grain_size: 0.5,
    grain_ref_longedge: 4096,
    exposure: 0.97,
    dof_enable: false,
  },
  intensity: {
    grain_scale: 0.5,
    ca_lateral: 0.0015,
    vignette: 0.15,
    vignette_mech: 0.05,
    halation_scale: 0.5,
    halation_color: 0.12,
    glare_intensity: 0.05,
    distortion_k1: -0.0075,
    distortion_k2: 0.002,
  },
};

/** The artefact values the engine defaults ship with, as an intensity layer. */
const DEFAULT_ARTEFACTS: Record<ArtefactParam, number> = {
  grain_scale: DEFAULTS.grain_scale,
  ca_lateral: DEFAULTS.ca_lateral,
  vignette: DEFAULTS.vignette,
  vignette_mech: DEFAULTS.vignette_mech,
  halation_scale: DEFAULTS.halation_scale,
  halation_color: DEFAULTS.halation_color,
  glare_intensity: DEFAULTS.glare_intensity,
  distortion_k1: DEFAULTS.distortion_k1,
  distortion_k2: DEFAULTS.distortion_k2,
};

export const PRESETS: readonly FilmLookPreset[] = [
  SHOW_MATCH,
  {
    id: "clean-optics",
    label: "Clean optics",
    description:
      "The honest base: no stock character, no tonemap, no artefacts. For a " +
      "grade alone, or for footage that already has real grain and distortion.",
    look: { stock: "clean", wp_tonemap: 0, tonemap: 0, grain_enable: false },
    intensity: {
      grain_scale: 0,
      ca_lateral: 0,
      vignette: 0,
      vignette_mech: 0,
      halation_scale: 0,
      halation_color: 0,
      glare_intensity: 0,
      distortion_k1: 0,
      distortion_k2: 0,
    },
  },
  {
    id: "tungsten-500t",
    label: "500T tungsten",
    description:
      "Warmer, grainier, shot-on-film-at-night. Not tied to any one show.",
    look: { stock: "vision3_500t" },
    intensity: DEFAULT_ARTEFACTS,
  },
  {
    id: "print-2383",
    label: "2383 print",
    description:
      "Theatrical print: deeper contrast, richer saturation, strong halation.",
    look: { stock: "kodak_2383" },
    intensity: DEFAULT_ARTEFACTS,
  },
];

export function findPreset(id: string): FilmLookPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
