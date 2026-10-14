/**
 * Recovering a real alpha channel from a clip generated on a flat backing.
 *
 * Seedance has no alpha. The way round it is to stand the artwork on a flat
 * colour, ask for that colour to be held, and take it out again afterwards —
 * which everyone does with a chroma keyer, and a chroma keyer is the wrong
 * tool for it.
 *
 * ## Why not a keyer
 *
 * A keyer asks "is this pixel the backing colour?" and nothing else. The
 * artwork here is a Mexican street: trees, cactus, awnings, guacamole. Those
 * pixels answer yes. Measured on one real frame of `seedance-2-0_b7a65f1b`,
 * at 312x416:
 *
 * ```
 * tolerance 40   keyer calls 33.9% background   fill calls 32.9%   1358 px
 * tolerance 60   keyer calls 34.2% background   fill calls 33.1%   1431 px
 * tolerance 80   keyer calls 34.4% background   fill calls 33.2%   1483 px
 * ```
 *
 * That last column is subject the keyer punches holes in — about 22,000
 * pixels per frame at full resolution — and it barely moves as the tolerance
 * tightens, because tuning is not the problem.
 *
 * This asks a different question: **is this pixel the backing colour AND
 * connected to the edge of the frame?** Green inside a figure is not
 * connected to anything, so it stays. That one extra condition is the whole
 * idea, and it is why the tolerance can be generous — 40 and 80 agree to
 * within 1% above, so there is nothing to tune per shot.
 *
 * ## Enclosed pockets, and how they are told apart from green props
 *
 * The first version of this stopped at the border fill, and the first real
 * frame showed why that is not enough: the gap under a cafe table, walled off
 * by the chairs and the figures, stayed solid green. Measured at ~23,500
 * pixels a frame — and almost none of it was the green props the border rule
 * was written to protect.
 *
 * So there is a second pass over the regions the border could not reach, and
 * it separates them on **two** grounds rather than one:
 *
 * - **Size.** A pocket of trapped backing is large. A green prop in flat
 *   illustration is small.
 * - **Exactness.** Trapped backing is the backing colour to within the
 *   encoder's noise — corner spread measures 2 on these clips. A green prop
 *   is a *different* green: guacamole is yellower, a tree is darker. So the
 *   pocket pass uses a tight tolerance where the border pass uses a generous
 *   one.
 *
 * A region has to fail both tests to be kept. What is left that still cannot
 * be decided is counted and reported, because the count is small, the mistake
 * is visible on screen, and a number lets somebody judge rather than trust.
 *
 * ## Soft edges
 *
 * The fill is binary and the artwork is not: generation and 4:2:0 encoding
 * both leave a one-or-two pixel ramp at every outline. So pixels bordering
 * the filled region get an alpha from how far they are from the backing, and
 * are un-premultiplied against it — which is also the despill. Pixels
 * nowhere near the boundary are left fully opaque no matter what colour they
 * are, which is the part a keyer gets wrong.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SeedError } from "@seed-ae/domain";
import { ffmpegPath } from "./proxy.js";

const run = promisify(execFile);

export interface MatteOptions {
  /** Channel distance within which a pixel counts as the backing colour. */
  tolerance?: number;
  /** Width of the alpha ramp at the boundary, in channel distance. */
  softness?: number;
  /** Un-premultiply edge pixels against the backing. The despill. */
  despill?: boolean;
  /** Override the sampled backing, 0-255 per channel. */
  backing?: [number, number, number];
  /**
   * Channel distance for the enclosed-pocket pass. Tighter than `tolerance`
   * on purpose: trapped backing is the backing colour, a green prop is not.
   */
  pocketTolerance?: number;
  /**
   * Smallest enclosed region, as a fraction of the frame, that is treated as
   * trapped background rather than part of the picture.
   *
   * Small, because the colour test is what does the separating. Swept on a
   * real frame: 0.0008 left 16,096 pixels of green under a table, 0.00002
   * left 597 and took nothing it should have kept — the man in that shot is
   * wearing green shorts, and they never enter this pass at all because they
   * are not the backing colour to within `pocketTolerance`.
   */
  pocketMinArea?: number;
  env?: NodeJS.ProcessEnv;
}

export interface MatteReport {
  frames: number;
  width: number;
  height: number;
  fps: number;
  /** What the corners said the backing was, on the first frame. */
  backing: [number, number, number];
  /** Largest channel disagreement between the four corners. Flatness. */
  backingSpread: number;
  /** Fraction of pixels kept, averaged over the clip. */
  meanCoverage: number;
  /** Walled-off backing recovered by the pocket pass, summed over the clip. */
  pocketsRemoved: number;
  /**
   * Pixels that matched the backing, could not be reached, and were too small
   * or too far off-colour to be called trapped background — so they were
   * kept. Green props, mostly. Reported because this is the one judgement
   * call in the whole process.
   */
  keptMatches: number;
  output: string;
}

interface Dimensions {
  width: number;
  height: number;
  fps: number;
}

/**
 * Size and frame rate, read out of ffmpeg's own banner.
 *
 * Not ffprobe: `ffmpeg-static` ships one binary and it is not that one. The
 * same trick `displayReferred` uses — with no output specified ffmpeg prints
 * the stream description to stderr and exits non-zero, so the rejection is
 * the expected path rather than a failure.
 */
async function probe(ffmpeg: string, file: string): Promise<Dimensions> {
  let stderr = "";
  try {
    stderr = (await run(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true })).stderr;
  } catch (error) {
    stderr = (error as { stderr?: string }).stderr ?? "";
  }

  const size = /,\s(\d{2,5})x(\d{2,5})[,\s]/.exec(stderr);
  if (!size) {
    throw new SeedError("bad_request", `could not read the size of ${path.basename(file)}`);
  }

  // Absent rather than guessed at: a clip whose rate ffmpeg does not state
  // gets 24, which is this project's rate, and the report says what was used.
  const rate = /([\d.]+)\s+fps/.exec(stderr);
  const fps = rate ? Number(rate[1]) : 24;

  return {
    width: Number(size[1]),
    height: Number(size[2]),
    fps: fps > 0 ? fps : 24,
  };
}

/** Channel-max distance. The same measure the probe above used. */
function distance(
  rgb: Uint8Array,
  at: number,
  br: number,
  bg: number,
  bb: number,
): number {
  const dr = Math.abs(rgb[at]! - br);
  const dg = Math.abs(rgb[at + 1]! - bg);
  const db = Math.abs(rgb[at + 2]! - bb);
  return dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
}

/** Average of a square at a corner, which is where the backing is cleanest. */
function cornerAverage(
  rgb: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  size: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const at = (y * width + x) * 3;
      r += rgb[at]!;
      g += rgb[at + 1]!;
      b += rgb[at + 2]!;
    }
  }
  const n = size * size;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function sampleBacking(
  rgb: Uint8Array,
  width: number,
  height: number,
): { backing: [number, number, number]; spread: number } {
  const size = Math.max(4, Math.min(16, Math.floor(Math.min(width, height) / 40)));
  const corners = [
    cornerAverage(rgb, width, 0, 0, size),
    cornerAverage(rgb, width, width - size, 0, size),
    cornerAverage(rgb, width, 0, height - size, size),
    cornerAverage(rgb, width, width - size, height - size, size),
  ];

  let spread = 0;
  for (let channel = 0; channel < 3; channel++) {
    const values = corners.map((corner) => corner[channel]!);
    spread = Math.max(spread, Math.max(...values) - Math.min(...values));
  }

  const backing: [number, number, number] = [
    Math.round(corners.reduce((sum, corner) => sum + corner[0]!, 0) / 4),
    Math.round(corners.reduce((sum, corner) => sum + corner[1]!, 0) / 4),
    Math.round(corners.reduce((sum, corner) => sum + corner[2]!, 0) / 4),
  ];
  return { backing, spread };
}

/**
 * Marks every backing-coloured pixel reachable from the frame edge.
 *
 * Scanline fill rather than per-pixel flood: a run is claimed in one pass and
 * only its neighbours above and below are queued, which is the difference
 * between a frame taking tens of milliseconds and taking seconds at two
 * megapixels — and this runs on every frame of every clip.
 */
export function fillFromBorder(
  rgb: Uint8Array,
  width: number,
  height: number,
  backing: readonly [number, number, number],
  tolerance: number,
): Uint8Array {
  const [br, bg, bb] = backing;
  const mask = new Uint8Array(width * height);
  const stack: number[] = [];

  const isBacking = (x: number, y: number): boolean =>
    distance(rgb, (y * width + x) * 3, br, bg, bb) <= tolerance;

  for (let x = 0; x < width; x++) {
    if (isBacking(x, 0)) stack.push(x);
    if (isBacking(x, height - 1)) stack.push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    if (isBacking(0, y)) stack.push(y * width);
    if (isBacking(width - 1, y)) stack.push(y * width + width - 1);
  }

  while (stack.length > 0) {
    const seed = stack.pop()!;
    if (mask[seed]) continue;
    const y = Math.floor(seed / width);
    const row = y * width;

    let left = seed - row;
    while (left >= 0 && !mask[row + left] && isBacking(left, y)) left--;
    left++;
    let right = seed - row;
    while (right < width && !mask[row + right] && isBacking(right, y)) right++;
    right--;

    for (let x = left; x <= right; x++) {
      mask[row + x] = 1;
      if (y > 0 && !mask[row - width + x] && isBacking(x, y - 1)) stack.push(row - width + x);
      if (y < height - 1 && !mask[row + width + x] && isBacking(x, y + 1)) {
        stack.push(row + width + x);
      }
    }
  }

  return mask;
}

/**
 * Backing trapped behind the subject, found and added to the mask.
 *
 * Labels every still-unmasked run of backing-coloured pixels, then keeps
 * whichever components are both large enough and close enough in colour to be
 * trapped background rather than part of the picture. See the header for why
 * it takes two tests and not one.
 *
 * Returns how many pixels it claimed and how many it decided to leave.
 */
export function fillEnclosedPockets(
  rgb: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  backing: readonly [number, number, number],
  tolerance: number,
  minArea: number,
): { removed: number; kept: number } {
  const [br, bg, bb] = backing;
  const seen = new Uint8Array(width * height);
  const region: number[] = [];
  const stack: number[] = [];
  let removed = 0;
  let kept = 0;

  const isBacking = (index: number): boolean =>
    distance(rgb, index * 3, br, bg, bb) <= tolerance;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start] || !isBacking(start)) continue;

    region.length = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      region.push(index);
      const x = index % width;
      const y = (index / width) | 0;

      if (x > 0 && !seen[index - 1] && !mask[index - 1] && isBacking(index - 1)) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && !seen[index + 1] && !mask[index + 1] && isBacking(index + 1)) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && !seen[index - width] && !mask[index - width] && isBacking(index - width)) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && !seen[index + width] && !mask[index + width] && isBacking(index + width)) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }

    if (region.length >= minArea) {
      for (const index of region) mask[index] = 1;
      removed += region.length;
    } else {
      kept += region.length;
    }
  }

  return { removed, kept };
}

/**
 * One frame: RGB in, RGBA out, written into `out`.
 *
 * Returns how many pixels matched the backing without being reachable — the
 * number that separates this from a keyer, and the one place a mistake could
 * hide.
 */
export function matteFrame(
  rgb: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
  backing: readonly [number, number, number],
  tolerance: number,
  softness: number,
  despill: boolean,
  pocketTolerance = 16,
  pocketMinArea = 0.00002,
): { kept: number; pocketsRemoved: number; keptMatches: number } {
  const [br, bg, bb] = backing;
  const mask = fillFromBorder(rgb, width, height, backing, tolerance);
  /*
   * `pocketMinArea: 0` means zero, and that is a real setting rather than a
   * degenerate one.
   *
   * The size test exists to protect a small prop that happens to be near the
   * backing colour — guacamole against green, denim against blue. It costs
   * something: a floor of 16 pixels keeps every pocket smaller than that, and
   * on the GYG proscenium regions those were the gaps *between leaves*. 664,245
   * backing-coloured pixels survived across 240 frames, about 2,800 a frame in
   * a few hundred specks of under 16 pixels each, and chroma blue inside gold
   * foliage is the most visible error there is.
   *
   * When the operator has measured that nothing in the artwork is near the
   * backing — 138 levels at the closest across those four plates, against a
   * pocket tolerance of 100 — the size test has nothing left to protect and
   * only the exactness test should apply. Clamping an explicit 0 up to 16 took
   * away the ability to say so, so it no longer does.
   */
  const pockets = fillEnclosedPockets(
    rgb, mask, width, height, backing, pocketTolerance,
    pocketMinArea === 0 ? 1 : Math.max(16, Math.round(width * height * pocketMinArea)),
  );

  let kept = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const at = index * 3;
      const to = index * 4;

      if (mask[index]) {
        out[to] = 0;
        out[to + 1] = 0;
        out[to + 2] = 0;
        out[to + 3] = 0;
        continue;
      }

      const away = distance(rgb, at, br, bg, bb);

      /*
       * Only pixels touching the filled region get a soft alpha. A
       * backing-coloured pixel in the middle of the subject is opaque, which
       * is the whole difference from a keyer.
       */
      let onEdge = false;
      if (x > 0 && mask[index - 1]) onEdge = true;
      else if (x < width - 1 && mask[index + 1]) onEdge = true;
      else if (y > 0 && mask[index - width]) onEdge = true;
      else if (y < height - 1 && mask[index + width]) onEdge = true;

      let alpha = 255;
      if (onEdge && away < softness) {
        alpha = Math.round((away / softness) * 255);
        if (alpha < 0) alpha = 0;
      }

      if (alpha === 255 || !despill) {
        out[to] = rgb[at]!;
        out[to + 1] = rgb[at + 1]!;
        out[to + 2] = rgb[at + 2]!;
      } else if (alpha === 0) {
        out[to] = 0;
        out[to + 1] = 0;
        out[to + 2] = 0;
      } else {
        /*
         * Un-premultiply against the backing. An edge pixel is a blend of
         * subject and backing; recovering the subject's own colour is both
         * the correct maths and the despill, because what it removes is
         * exactly the backing's contribution.
         */
        const a = alpha / 255;
        const unmix = (value: number, base: number): number => {
          const recovered = (value - base * (1 - a)) / a;
          return recovered < 0 ? 0 : recovered > 255 ? 255 : Math.round(recovered);
        };
        out[to] = unmix(rgb[at]!, br);
        out[to + 1] = unmix(rgb[at + 1]!, bg);
        out[to + 2] = unmix(rgb[at + 2]!, bb);
      }

      out[to + 3] = alpha;
      if (alpha > 0) kept++;
    }
  }

  return { kept, pocketsRemoved: pockets.removed, keptMatches: pockets.kept };
}

/**
 * The whole clip, streamed.
 *
 * Two ffmpeg processes with this in between, rather than decoding to disk:
 * ten seconds of 1248x1664 is 1.5GB of raw frames, which is not a buffer to
 * hold in a service the panel is also talking to.
 *
 * ProRes 4444 out. After Effects reads it natively with its alpha, 10-bit,
 * no keying effects on the layer at all — which is the point of doing this
 * rather than shipping a green clip and a chain of three plugins.
 */
export async function matteClip(
  input: string,
  output: string,
  options: MatteOptions = {},
): Promise<MatteReport> {
  const ffmpeg = ffmpegPath(options.env);
  if (!ffmpeg) {
    throw new SeedError("unsupported_capability", "no ffmpeg available to read the clip");
  }

  const { width, height, fps } = await probe(ffmpeg, input);
  const tolerance = options.tolerance ?? 60;
  const softness = options.softness ?? Math.max(tolerance * 1.5, 80);
  const despill = options.despill !== false;
  const pocketTolerance = options.pocketTolerance ?? 16;
  const pocketMinArea = options.pocketMinArea ?? 0.00002;

  const frameBytes = width * height * 3;
  const outBytes = width * height * 4;

  const decode = spawn(ffmpeg, [
    "-v", "error", "-i", input, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { windowsHide: true });

  const encode = spawn(ffmpeg, [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${width}x${height}`, "-r", String(fps),
    "-i", "-",
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
    "-alpha_bits", "16",
    output,
  ], { windowsHide: true });

  const frame = Buffer.alloc(frameBytes);
  const rgba = Buffer.alloc(outBytes);
  let filled = 0;
  let frames = 0;
  let keptTotal = 0;
  let pocketsTotal = 0;
  let keptMatchesTotal = 0;
  let backing: [number, number, number] = options.backing ?? [0, 177, 64];
  let spread = 0;
  let sampled = options.backing !== undefined;

  const errors: string[] = [];
  encode.stderr.on("data", (chunk) => errors.push(String(chunk)));
  decode.stderr.on("data", (chunk) => errors.push(String(chunk)));

  await new Promise<void>((resolve, reject) => {
    const fail = (cause: unknown): void => {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };

    decode.on("error", fail);
    encode.on("error", fail);
    encode.stdin.on("error", () => {
      // The encoder closing early is reported by its exit code, which carries
      // the real reason; an EPIPE here would replace it with a worse message.
    });

    decode.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;

        if (filled !== frameBytes) continue;
        filled = 0;

        if (!sampled) {
          const seen = sampleBacking(frame, width, height);
          backing = seen.backing;
          spread = seen.spread;
          sampled = true;
        }

        const counted = matteFrame(
          frame, rgba, width, height, backing, tolerance, softness, despill,
          pocketTolerance, pocketMinArea,
        );
        keptTotal += counted.kept;
        pocketsTotal += counted.pocketsRemoved;
        keptMatchesTotal += counted.keptMatches;
        frames++;

        if (!encode.stdin.write(rgba)) {
          decode.stdout.pause();
          encode.stdin.once("drain", () => decode.stdout.resume());
        }
      }
    });

    decode.stdout.on("end", () => encode.stdin.end());
    decode.on("close", (code) => {
      if (code !== 0) fail(new Error(`reading the clip failed: ${errors.join("").slice(0, 400)}`));
    });
    encode.on("close", (code) => {
      if (code === 0) resolve();
      else fail(new Error(`writing the matte failed: ${errors.join("").slice(0, 400)}`));
    });
  });

  if (frames === 0) {
    throw new SeedError("bad_request", `${input} produced no frames`);
  }

  return {
    frames,
    width,
    height,
    fps,
    backing,
    backingSpread: spread,
    meanCoverage: Math.round((keptTotal / (frames * width * height)) * 1000) / 1000,
    pocketsRemoved: pocketsTotal,
    keptMatches: keptMatchesTotal,
    output,
  };
}
