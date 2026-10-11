import { SeedError } from "@seed-ae/domain";
import { resolveStorageUri } from "@seed-ae/storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { z } from "zod";
import { matteClip } from "../media/floodMatte.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";
import { adoptFileIntoLibrary } from "./assets.js";

/**
 * Taking a generated clip off its backing and giving it a real alpha channel.
 *
 * The round trip this closes: artwork has alpha, Seedance does not, so the
 * artwork is stood on a flat colour, generated, and the colour taken out
 * again. The taking-out is normally a chroma keyer and three plugins on every
 * layer. This does it once, in the service, and hands After Effects a ProRes
 * 4444 that already has the alpha in it.
 *
 * See `media/floodMatte.ts` for why it is a connected-region fill rather than
 * a key, and what that is measured to be worth.
 */

const MatteSchema = z.object({
  sourceAssetId: z.string().min(1),
  /** Channel distance for the backing. Generous; it does not need tuning. */
  tolerance: z.number().min(1).max(200).optional(),
  /** Tighter, for telling trapped backing from a prop of a similar colour. */
  pocketTolerance: z.number().min(1).max(120).optional(),
  pocketMinArea: z.number().min(0).max(0.2).optional(),
  /** Un-premultiply edge pixels against the backing. On unless refused. */
  despill: z.boolean().optional(),
  /** Override the sampled backing colour, 0-255 per channel. */
  backing: z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]).optional(),
  project: z.string().min(1).optional(),
});

export function matteRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(MatteSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);

    if (source.kind !== "video") {
      throw new SeedError(
        "bad_request",
        `${source.filename} is ${source.kind}. This takes a backing colour out of a ` +
          `generated clip; a still does not need it.`,
      );
    }

    const input = resolveStorageUri(deps.workspace, source.storageUri);
    const scratch = await mkdtemp(nodePath.join(tmpdir(), "seed matte "));
    const base = source.filename.replace(/\.[^.]+$/, "");
    const output = nodePath.join(scratch, `${base}_alpha.mov`);

    const report = await matteClip(input, output, {
      ...(request.tolerance === undefined ? {} : { tolerance: request.tolerance }),
      ...(request.pocketTolerance === undefined ? {} : { pocketTolerance: request.pocketTolerance }),
      ...(request.pocketMinArea === undefined ? {} : { pocketMinArea: request.pocketMinArea }),
      ...(request.despill === undefined ? {} : { despill: request.despill }),
      ...(request.backing === undefined ? {} : { backing: request.backing }),
      env: process.env,
    });

    /*
     * A spread above a few channels means the backing was not flat — a
     * gradient, a shadow, or a shot where the subject reaches a corner. The
     * fill still ran and the result may be fine, but it is the one number
     * that predicts a bad matte, so it is said out loud rather than left in
     * a report nobody reads.
     */
    const warnings: string[] = [];
    if (report.backingSpread > 12) {
      warnings.push(
        `the four corners disagree by ${report.backingSpread} levels, so the ` +
          `backing is not flat — check the edges`,
      );
    }

    /*
     * `keptMatches` counts pixels that looked like the backing and were kept
     * anyway. A few is the module working: a green prop inside the subject,
     * protected by not being connected to the edge. A lot is the pocket pass
     * refusing to claim backing that genuinely is trapped, because the
     * backdrop has a tint gradient and the trapped part sits further from the
     * sampled colour than `pocketTolerance` allows.
     *
     * Measured on the four GYG elements, as a fraction of all pixels:
     * mariachi 0.0000018, party crew 0.000012, taco date 0.000052 — all
     * clean. The cafe tables came back at 0.00066, more than ten times the
     * worst good one, and the clip had blue left under both tables. The
     * threshold sits between them with room on each side, and raising
     * `pocketTolerance` to 60 fixed that clip without touching its green
     * trousers, which measure 150 levels from the backing.
     *
     * This is the number that spotted it. Before, it was in the report and
     * nobody read it.
     */
    const matchRate = report.keptMatches / (report.frames * report.width * report.height);
    if (matchRate > 0.0002) {
      warnings.push(
        `${report.keptMatches} backing-coloured pixels were kept rather than cut ` +
          `(${(matchRate * 100).toFixed(3)}% of the clip). That usually means backing ` +
          `trapped behind the subject was too far from the sampled colour to claim — ` +
          `try pocketTolerance 60, then check nothing green in the artwork went with it`,
      );
    }

    const asset = await adoptFileIntoLibrary(
      deps,
      output,
      request.project ?? source.project ?? undefined,
    );

    return json({
      asset,
      source: { id: source.id, filename: source.filename },
      report,
      ...(warnings.length ? { warnings } : {}),
    });
  };
}
