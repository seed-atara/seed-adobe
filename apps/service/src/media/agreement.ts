import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { SeedError } from "@seed-ae/domain";
import { ffmpegPath } from "./proxy.js";

const run = promisify(execFile);

/**
 * How far the picture moved — the number a supervisor is actually asking for.
 *
 * A transformed plate gets reviewed by wiping it against the original, and the
 * question is never "does this look like winter". It is "is this the same
 * shot". Those are different questions and only the second one can be
 * answered by a machine, which is lucky, because it is the one that gets work
 * rejected.
 *
 * ## Why displacement rather than similarity
 *
 * The obvious measure is how similar the two frames are, and it is the wrong
 * one. A correct summer-to-winter transformation is *supposed* to be
 * dissimilar: bare branches carry far more edge detail than full foliage,
 * snow erases ground texture entirely. Score that as error and the metric
 * punishes the model for doing the job, which makes it worse than useless —
 * it argues for the timid result over the correct one.
 *
 * So this measures something a legitimate change leaves alone: **where things
 * are**. A roof line, a wall, a horizon and a person's silhouette sit in the
 * same pixels whether it is July or January. Tile the frame, and for each tile
 * search for the offset that best aligns it with the plate. Content that has
 * not moved reports ~0 displacement no matter how completely its surfaces were
 * repainted. Content that drifted reports how far, in plate pixels, and where.
 *
 * ## Why tiles are skipped
 *
 * A tile with no structure cannot report displacement — flat sky correlates
 * equally well with itself at every offset, so the search returns whichever
 * noise peak happens to win. Those tiles are excluded rather than averaged in.
 *
 * This is the same mistake, in a different costume, as the flat-sky crop that
 * read +678% during the restoration work: a region with nothing in it will
 * happily produce a confident number, and that number will be about nothing.
 * The rule that came out of it — check that a region has something to say
 * before believing what it says — is enforced here in code rather than left
 * to whoever reads the output.
 */

/** One tile's verdict. */
export interface TileAgreement {
  /** Grid position, so the artist can be pointed at the region. */
  column: number;
  row: number;
  /** Where the tile's content sits in the result, relative to the plate. */
  dx: number;
  dy: number;
  /** How far it moved, in plate pixels. */
  distance: number;
  /** Peak normalized correlation, 0..1. Low means "and not very confidently". */
  confidence: number;
  /** True when the match sat on the search edge, so `distance` is a floor. */
  saturated?: boolean;
}

export interface PlateAgreement {
  /** Tiles that carried enough structure to be worth measuring. */
  measured: number;
  /** Tiles skipped for having nothing in them. Context for `measured`. */
  skipped: number;
  /**
   * Typical displacement in plate pixels — the median, not the mean, because
   * one badly drifted region should not be allowed to average away and one
   * mismeasured tile should not be allowed to dominate.
   */
  medianDistance: number;
  /** The worst region that was measured confidently. */
  worst?: TileAgreement;
  /** Share of measured tiles that stayed within `tolerance`, 0..1. */
  held: number;
  /**
   * Tiles whose best match sat on the edge of the search window.
   *
   * Their distances are floors, not values — the content moved at least that
   * far and possibly much further. Reported rather than silently included so
   * that "moved 96px" cannot be read as a measurement when it is a ceiling.
   */
  saturated: number;
  /** True when the worst region is one of those, so the verdict understates. */
  truncated: boolean;
  /** What counted as "did not move", in plate pixels. */
  tolerance: number;
  /** Per-tile detail, for a heat map or a table. */
  tiles: TileAgreement[];
}

export interface AgreementOptions {
  /** Grid across the frame. 8 gives 64 tiles, enough to localise a problem. */
  grid?: number;
  /**
   * How far to search, as a share of frame width.
   *
   * A tile whose best match sits on the edge of this window has not been
   * measured — it has been *clipped*, and the distance reported for it is a
   * floor rather than a value. Those tiles are counted in `saturated`, and
   * `truncated` says whether the overall verdict rests on any of them.
   *
   * The default was 4% and that was too small to be honest. The first real
   * pair measured a median 96.6px against a 2560px plate, which looked like a
   * number and was actually the search ceiling; widening the window moved it
   * to 143.6px, where it then stayed. Under-reporting drift is the one
   * direction this must not fail in, since the entire purpose is to catch
   * drift the eye has waved through.
   */
  searchFraction?: number;
  /**
   * What counts as held, as a share of frame width. 0.4% is about 8px on a
   * 1920 plate — under a pixel of drift once you account for the model
   * re-rendering every edge from scratch, and well inside what survives a
   * wipe.
   */
  toleranceFraction?: number;
  /**
   * The plate's real width, so displacement is reported in the pixels the
   * artist is looking at rather than in the working scale.
   *
   * Passed in rather than probed. The asset record already knows it, and an
   * earlier version shelled out to ffprobe to rediscover it — which added a
   * second binary to the dependency list, and a silent fallback to
   * working-scale numbers on any machine where ffprobe was not sitting beside
   * ffmpeg. A number that is sometimes in one unit and sometimes in another,
   * without saying which, is worse than no number.
   */
  plateWidth?: number;
  env?: NodeJS.ProcessEnv;
}

/** Working resolution. Small on purpose — this measures geometry, not detail. */
const WORK_WIDTH = 480;

/**
 * Below this peak correlation a tile is treated as having nothing to say.
 *
 * Not tuned against a dataset, and it should not be described as though it
 * were: it is a threshold that rejects flat sky and passes buildings on the
 * frames it has been run on. It is exposed through `skipped` so that a
 * measurement resting on six tiles out of sixty-four is visible as such
 * rather than quietly reported as a confident number.
 */
const MIN_CONFIDENCE = 0.35;

/** Below this gradient energy a tile is flat and gets no vote. */
const MIN_STRUCTURE = 1.5;

/**
 * Correlations within this of each other count as indistinguishable.
 *
 * Only used to decide ties in favour of the smaller displacement — see the
 * search loop for why that matters on periodic structure.
 */
const TIE = 0.02;

/**
 * Measure how far the content of `result` sits from the content of `plate`.
 *
 * Both are read at a common small size, so a 4K render and a 1080 plate
 * compare directly; distances are reported back in plate pixels.
 */
export async function plateAgreement(
  plate: string,
  result: string,
  options: AgreementOptions = {},
): Promise<PlateAgreement> {
  const grid = options.grid ?? 8;
  const searchFraction = options.searchFraction ?? 0.1;
  const toleranceFraction = options.toleranceFraction ?? 0.004;

  const scratch = await mkdtemp(nodePath.join(tmpdir(), "seed agreement "));
  const a = await grayPlane(plate, nodePath.join(scratch, "a.pgm"), options.env);
  /*
   * The result is forced onto the plate's exact working dimensions rather than
   * reduced on its own terms.
   *
   * An earlier version reduced both to a common width and refused if the
   * heights disagreed, on the assumption that they could not — the aspect is
   * never sent, so a render should come back shaped like its source. That
   * assumption is simply false, and the first real pair broke it: a 2560x1440
   * plate came back from Seedream at 5504x3040, which is 1.81:1 rather than
   * 16:9. Off by five working pixels, and the comparison refused to run at all.
   *
   * Forcing rather than letterboxing is deliberate. These two frames are being
   * compared *as framed*, and if a model quietly changed the shape of the
   * picture then the content near the edges really has moved relative to the
   * plate — which is exactly what this is supposed to report, rather than
   * hide behind a tidy fit.
   */
  const b = await grayPlane(result, nodePath.join(scratch, "b.pgm"), options.env, a);

  if (a.width !== b.width || a.height !== b.height) {
    throw new SeedError(
      "provider_error",
      `could not compare the plate to the result: reduced to ${a.width}x${a.height} ` +
        `and ${b.width}x${b.height}.`,
    );
  }

  const plateWidth = options.plateWidth ?? a.width;
  const scale = plateWidth / a.width;
  const search = Math.max(2, Math.round(a.width * searchFraction));
  const tolerance = Math.round(plateWidth * toleranceFraction);

  const ga = gradient(a);
  const gb = gradient(b);

  const tileW = Math.floor(a.width / grid);
  const tileH = Math.floor(a.height / grid);
  const tiles: TileAgreement[] = [];
  let skipped = 0;

  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const x0 = column * tileW;
      const y0 = row * tileH;

      // A tile with nothing in it cannot report where anything went.
      if (energy(ga, a.width, x0, y0, tileW, tileH) < MIN_STRUCTURE) {
        skipped++;
        continue;
      }

      const best = bestOffset(ga, gb, a.width, a.height, x0, y0, tileW, tileH, search);
      if (!best || best.confidence < MIN_CONFIDENCE) {
        skipped++;
        continue;
      }

      const dx = best.dx * scale;
      const dy = best.dy * scale;
      const saturated =
        Math.abs(best.dx) >= search || Math.abs(best.dy) >= search;
      tiles.push({
        column,
        row,
        dx: round(dx),
        dy: round(dy),
        distance: round(Math.hypot(dx, dy)),
        confidence: round(best.confidence, 3),
        ...(saturated ? { saturated: true } : {}),
      });
    }
  }

  const distances = tiles.map((tile) => tile.distance).sort((x, y) => x - y);
  const medianDistance = distances.length
    ? round(distances[Math.floor(distances.length / 2)]!)
    : 0;
  const held = tiles.length
    ? tiles.filter((tile) => tile.distance <= tolerance).length / tiles.length
    : 0;
  const worst = tiles.reduce<TileAgreement | undefined>(
    (found, tile) => (!found || tile.distance > found.distance ? tile : found),
    undefined,
  );

  return {
    measured: tiles.length,
    skipped,
    medianDistance,
    ...(worst ? { worst } : {}),
    held: round(held, 3),
    saturated: tiles.filter((tile) => tile.saturated).length,
    truncated: worst?.saturated === true,
    tolerance,
    tiles,
  };
}

/** A frame reduced to one gray plane at a common working width. */
interface Plane {
  width: number;
  height: number;
  data: Uint8Array;
}

async function grayPlane(
  source: string,
  destination: string,
  env?: NodeJS.ProcessEnv,
  /** When given, the exact dimensions to land on rather than deriving them. */
  match?: { width: number; height: number },
): Promise<Plane> {
  const ffmpeg = ffmpegPath(env);
  if (!ffmpeg) {
    throw new SeedError(
      "unsupported_capability",
      "comparing a render to its plate needs ffmpeg, and none was found. The " +
        "SEED companion ships one; a dev service uses SEED_FFMPEG or PATH.",
    );
  }

  try {
    await run(
      ffmpeg,
      [
        "-y",
        "-v",
        "error",
        "-i",
        source,
        "-frames:v",
        "1",
        /*
         * The plate sets the working size and the result is forced onto it,
         * because the tiles have to describe the same parts of the world or
         * they describe nothing. See the call site for why the result's own
         * shape cannot be trusted to agree.
         */
        "-vf",
        match
          ? `scale=${match.width}:${match.height},format=gray`
          : `scale=${WORK_WIDTH}:-2,format=gray`,
        destination,
      ],
      { windowsHide: true, maxBuffer: 1 << 26 },
    );
  } catch (cause) {
    throw new SeedError(
      "provider_error",
      `could not read ${nodePath.basename(source)} for comparison: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }

  return readPgm(await readFile(destination));
}

/** Minimal binary PGM (P5) reader — what ffmpeg's `gray` writes. */
export function readPgm(buffer: Buffer): { width: number; height: number; data: Uint8Array } {
  let index = 0;
  const tokens: string[] = [];
  const whitespace = (byte: number) => byte === 32 || byte === 10 || byte === 13 || byte === 9;

  while (tokens.length < 4) {
    while (index < buffer.length && whitespace(buffer[index]!)) index++;
    if (buffer[index] === 35) {
      while (index < buffer.length && buffer[index] !== 10) index++;
      continue;
    }
    const start = index;
    while (index < buffer.length && !whitespace(buffer[index]!)) index++;
    tokens.push(buffer.toString("ascii", start, index));
  }
  index++; // the single whitespace byte after maxval

  const width = Number.parseInt(tokens[1]!, 10);
  const height = Number.parseInt(tokens[2]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new SeedError("provider_error", "could not parse the reduced frame for comparison.");
  }
  return { width, height, data: new Uint8Array(buffer.subarray(index, index + width * height)) };
}

/**
 * Gradient magnitude.
 *
 * The search runs on edges rather than on brightness because brightness is
 * exactly what a legitimate change alters — a snow-covered roof and a slate
 * one have nothing in common tonally, while the line where the roof meets the
 * sky is in the same place in both.
 */
function gradient(plane: Plane): Float32Array {
  const { width, height, data } = plane;
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const gx = data[at + 1]! - data[at - 1]!;
      const gy = data[at + width]! - data[at - width]!;
      out[at] = Math.hypot(gx, gy);
    }
  }
  return out;
}

function energy(
  field: Float32Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) sum += field[y * width + x]!;
  }
  return sum / (w * h);
}

/**
 * The offset at which this tile of the plate best matches the result.
 *
 * Exhaustive over the search window, on normalized cross-correlation. Brute
 * force is the right choice here: the window is small, the tiles are small,
 * and a coarse-to-fine search would trade a few milliseconds nobody will
 * notice for the chance of locking onto the wrong local peak, which would
 * report a moved building as held.
 */
function bestOffset(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  search: number,
): { dx: number; dy: number; confidence: number } | undefined {
  const reference: number[] = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) reference.push(a[y * width + x]!);
  }
  const refMean = reference.reduce((sum, value) => sum + value, 0) / reference.length;
  let refVariance = 0;
  for (const value of reference) refVariance += (value - refMean) ** 2;
  if (refVariance <= 0) return undefined;

  let best: { dx: number; dy: number; confidence: number } | undefined;

  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      if (x0 + dx < 0 || y0 + dy < 0 || x0 + dx + w > width || y0 + dy + h > height) continue;

      let sum = 0;
      for (let y = 0; y < h; y++) {
        const rowB = (y0 + y + dy) * width + dx;
        for (let x = 0; x < w; x++) sum += b[rowB + x0 + x]!;
      }
      const mean = sum / (w * h);

      let covariance = 0;
      let variance = 0;
      let at = 0;
      for (let y = 0; y < h; y++) {
        const rowB = (y0 + y + dy) * width + dx;
        for (let x = 0; x < w; x++) {
          const value = b[rowB + x0 + x]! - mean;
          covariance += (reference[at++]! - refMean) * value;
          variance += value * value;
        }
      }
      if (variance <= 0) continue;

      const confidence = covariance / Math.sqrt(refVariance * variance);
      if (!best) {
        best = { dx, dy, confidence };
        continue;
      }
      /*
       * Ties resolve towards "it did not move", and that is a correctness fix
       * rather than a preference.
       *
       * Plates are full of periodic structure — brick, fencing, railings,
       * repeated windows, tiled roofs — and a tile of it correlates exactly as
       * well one full period away as it does at zero. A plain `>` keeps
       * whichever offset the loop happened to reach first, which is the most
       * negative corner of the search window, so a wall that never moved gets
       * reported as having slid the width of the window. Caught by comparing a
       * frame against *itself* and getting 26% of tiles flagged as drifted.
       *
       * Where the evidence genuinely cannot distinguish two offsets, the
       * smaller one is the honest answer: this measurement exists to raise the
       * alarm when something moved, and an alarm that fires on masonry is one
       * an artist learns to ignore.
       */
      const better = confidence - best.confidence;
      if (better > TIE) {
        best = { dx, dy, confidence };
      } else if (better > -TIE && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy)) {
        best = { dx, dy, confidence };
      }
    }
  }

  return best;
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
