import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCubeLut,
  resolveConfig,
  stagesLeftBehind,
  type FilmLookConfig,
} from "@seed-ae/filmlook";
import { SeedError } from "@seed-ae/domain";
import type { AppDeps } from "../app.js";
import { readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Writes a look as a `.cube`, so it can be a real effect on a real layer.
 *
 * The bake treats one still. This is the other half of the answer: an artist
 * grading a shot wants something they drag onto a layer, that plays live and
 * keyframes and renders with the comp — and for the tonal half of the chain a
 * LUT is exactly that, and exact.
 *
 * Written into the workspace rather than returned inline, because After
 * Effects loads a LUT from a path and the artist needs somewhere to point at.
 * Overwriting the same filename on purpose: this is a tool output, not an
 * asset, and a folder accumulating show-match-1.cube through -47.cube would be
 * worse than one that always holds the current answer.
 */
export function lookLutRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = ((await readJsonBody(req)) ?? {}) as {
      preset?: string;
      intensity?: number;
      size?: number;
      overrides?: Partial<FilmLookConfig>;
    };

    const preset = request.preset ?? "show-match";
    const intensity = request.intensity ?? 1;

    let config: FilmLookConfig;
    try {
      config = resolveConfig({
        preset,
        intensity,
        ...(request.overrides ? { overrides: request.overrides } : {}),
      });
    } catch (cause) {
      throw new SeedError(
        "bad_request",
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    const cube = buildCubeLut(config, {
      ...(request.size ? { size: request.size } : {}),
      title: `SEED ${preset} at intensity ${intensity}`,
    });

    const directory = path.join(deps.workspace.root, "luts");
    await mkdir(directory, { recursive: true });

    // Intensity in the name: two LUTs of the same look at different strengths
    // are different files, and picking the wrong one in AE is invisible.
    const filename = `seed_${preset}_${String(intensity).replace(".", "-")}.cube`;
    const file = path.join(directory, filename);
    await writeFile(file, cube, "utf8");

    deps.logger.info("look.lut_written", { preset, intensity, path: file });

    return json({
      path: file,
      filename,
      preset,
      intensity,
      /*
       * What the LUT cannot carry. Said out loud rather than left to be
       * discovered: an artist who applies this and wonders where the grain
       * went has been failed by the tool, not by the format.
       */
      missing: stagesLeftBehind(config),
    });
  };
}
