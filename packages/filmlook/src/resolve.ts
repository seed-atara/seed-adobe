import type { FilmLookConfig } from "./config.js";
import { ARTEFACT_PARAMS, DEFAULTS } from "./config.js";
import { findPreset, type FilmLookPreset } from "./presets.js";
import { requireStock } from "./stocks.js";

export interface ResolveOptions {
  /** Preset id, or a preset object. Omitted means engine defaults alone. */
  preset?: string | FilmLookPreset;
  /**
   * How much camera. 1.0 is the preset as authored, 0 turns every artefact
   * off, 2.0 is twice as much. Scales only the artefact parameters.
   */
  intensity?: number;
  /** The artist's own changes. These win over everything. */
  overrides?: Partial<FilmLookConfig>;
}

/**
 * Builds a complete config: `defaults <- look <- intensity <- overrides`.
 *
 * Later layers win, and the result is always complete — every parameter has a
 * shipped value and none may be undefined at render time, so no stage has to
 * carry a fallback for a missing control.
 *
 * Intensity is applied as a multiplier on the preset's authored artefact
 * values rather than as its own set of numbers. That keeps "1.0 = what the
 * preset says" true for every preset, including ones whose authored level is
 * the engine default, and makes 0 an exact off switch — which matters, because
 * turning the artefacts off as a group is the correct response to footage that
 * already has real distortion, vignetting or grain.
 */
export function resolveConfig(options: ResolveOptions = {}): FilmLookConfig {
  const preset =
    typeof options.preset === "string"
      ? requirePreset(options.preset)
      : options.preset;

  const intensity = options.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity < 0) {
    throw new Error(`intensity must be a non-negative number, got ${intensity}`);
  }

  const resolved: FilmLookConfig = { ...DEFAULTS, ...(preset?.look ?? {}) };

  /*
   * The artefact layer. A preset without one leaves the defaults in place,
   * which are themselves an authored level, so they scale on the same terms.
   */
  const authored = preset?.intensity;
  for (const key of ARTEFACT_PARAMS) {
    const base = authored?.[key] ?? DEFAULTS[key];
    const scaled = base * intensity;
    /*
     * Normalise negative zero. The barrel distortion coefficients are
     * negative, so scaling them to nothing yields -0, which is arithmetically
     * harmless but compares unequal to 0 under Object.is — enough to make a
     * config that is off look "modified from preset", and enough to flip the
     * sign of anything that later divides by it.
     */
    (resolved[key] as number) = scaled === 0 ? 0 : scaled;
  }

  Object.assign(resolved, options.overrides ?? {});

  // Fail here rather than three stages into a render.
  requireStock(resolved.stock);
  return resolved;
}

function requirePreset(id: string): FilmLookPreset {
  const preset = findPreset(id);
  if (!preset) throw new Error(`unknown film look preset "${id}"`);
  return preset;
}

/**
 * Which parameters a config differs from its preset on.
 *
 * The UI needs to show a modified-from-preset state, and an artist deciding
 * whether to trust a look wants to know what has been touched since it was
 * loaded — not to compare sixty-six numbers by eye.
 */
export function modifiedFromPreset(
  config: FilmLookConfig,
  options: ResolveOptions = {},
): (keyof FilmLookConfig)[] {
  const base = resolveConfig(options);
  return (Object.keys(base) as (keyof FilmLookConfig)[]).filter(
    (key) => JSON.stringify(config[key]) !== JSON.stringify(base[key]),
  );
}
