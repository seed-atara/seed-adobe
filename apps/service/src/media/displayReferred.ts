/**
 * Turning a scene-referred capture into pixels a screen can show.
 *
 * `CompItem.saveFrameToPng` writes the frame in the project's **working**
 * space with no display transform. In a colour-managed project that is
 * scene-referred data — ACEScg is linear with AP1 primaries — and everything
 * downstream reads it as sRGB: the panel, the artist, and the model. A perfect
 * frame arrives looking near-black, and the plate sent to Seedream is
 * near-black too, which quietly ruins every generation made from it.
 *
 * Measured on a real 1920x1080 ACEScg capture: mean level 9 of 255, alpha 255
 * across the whole frame, 57% of pixels non-zero. After this conversion, mean
 * 48 and no clipped channels.
 *
 * **This does not belong in the host script.** The first attempt set
 * `app.project.workingSpace = ""` around the capture and put it back
 * afterwards; it does not round-trip — After Effects rejects an OCIO space
 * name as an ICC profile and leaves the project unmanaged — and it did not
 * lighten the frame either. Here the conversion is measurable without opening
 * After Effects, and a wrong answer costs a re-capture rather than the
 * artist's project settings.
 *
 * What this is NOT: the ACES view transform. There is no RRT and no tone map,
 * so this is not what the artist sees through an ODT. It is an honest
 * colorimetric conversion — correct primaries, correct transfer function — and
 * the right basis for a plate. A look belongs in the grade, not in the
 * capture.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ffmpegPath } from "./proxy.js";

const run = promisify(execFile);

/** Linear RGB -> sRGB, the real piecewise curve rather than a 2.2 guess. */
function encode(value: number): number {
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

type Matrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** ACEScg (AP1, D60) -> sRGB/Rec.709 (D65), Bradford-adapted. */
const AP1_TO_SRGB: Matrix = [
  [1.70505, -0.62179, -0.08326],
  [-0.13026, 1.14080, -0.01055],
  [-0.024, -0.12897, 1.15297],
];

/** ACES2065-1 (AP0, D60) -> sRGB/Rec.709 (D65), Bradford-adapted. */
const AP0_TO_SRGB: Matrix = [
  [2.52169, -1.13413, -0.38756],
  [-0.27648, 1.37272, -0.09624],
  [-0.01538, -0.15298, 1.16835],
];

/**
 * Which working spaces we know how to convert, and how.
 *
 * An allowlist, and deliberately a short one. A space we do not recognise is
 * left exactly as captured: guessing a transform produces a picture that looks
 * plausible and is wrong, which is worse than one that is visibly too dark and
 * prompts a question. ACEScct and other log encodings are absent on purpose —
 * they need a curve, not a matrix, and inventing one here would be exactly
 * that failure.
 */
const KNOWN: ReadonlyArray<{ match: RegExp; matrix: Matrix; label: string }> = [
  { match: /aces\s*2065|ap0/i, matrix: AP0_TO_SRGB, label: "ACES2065-1" },
  { match: /acescg|ap1/i, matrix: AP1_TO_SRGB, label: "ACEScg" },
  { match: /^linear|linear\s*(rec\.?\s*709|srgb|bt\.?709)/i, matrix: IDENTITY, label: "linear Rec.709" },
];

export interface ConversionPlan {
  matrix: Matrix;
  label: string;
}

/**
 * Whether a capture in this working space needs converting, and how.
 *
 * `undefined` means leave it alone — either it is already display-referred, or
 * it is something we do not claim to understand.
 */
export function planFor(workingSpace: string | undefined): ConversionPlan | undefined {
  const space = workingSpace?.trim();
  if (!space) return undefined;
  // A display-referred space is already correct; converting would double the
  // transfer function and blow out the midtones.
  if (/^s\s*rgb|rec\.?\s*709|display\s*p3|adobe\s*rgb/i.test(space) && !/linear/i.test(space)) {
    return undefined;
  }
  for (const entry of KNOWN) {
    if (entry.match.test(space)) return { matrix: entry.matrix, label: entry.label };
  }
  return undefined;
}

export interface ConversionResult {
  converted: boolean;
  /** Present when converted: which space we came from. */
  from?: string;
  /** Why nothing happened, when nothing happened. */
  reason?: string;
  meanLevel?: number;
}

/**
 * Rewrites the capture in place as 8-bit display-referred sRGB.
 *
 * In place because the file is not an asset yet — it is a temporary the host
 * just wrote, on its way to being registered. Nothing immutable is being
 * altered, and keeping a linear original nobody can view has no value.
 */
export async function toDisplayReferred(
  file: string,
  workingSpace: string | undefined,
  options: { env?: NodeJS.ProcessEnv; width?: number; height?: number } = {},
): Promise<ConversionResult> {
  const plan = planFor(workingSpace);
  if (!plan) {
    return { converted: false, reason: `nothing to do for ${workingSpace || "an unmanaged project"}` };
  }

  const ffmpeg = ffmpegPath(options.env);
  if (!ffmpeg) return { converted: false, reason: "no ffmpeg available" };

  let width = options.width;
  let height = options.height;
  let raw: Buffer;
  try {
    if (!width || !height) {
      const probed = await dimensions(ffmpeg, file);
      width = probed.width;
      height = probed.height;
    }
    const decoded = await run(
      ffmpeg,
      ["-v", "error", "-i", file, "-pix_fmt", "rgba64le", "-f", "rawvideo", "-"],
      { maxBuffer: 1 << 30, encoding: "buffer", windowsHide: true },
    );
    raw = decoded.stdout as unknown as Buffer;
  } catch (cause) {
    return {
      converted: false,
      reason: `could not read the capture: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const source = new Uint16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const pixels = width * height;
  if (source.length < pixels * 4) {
    return { converted: false, reason: "the decoded frame was shorter than its own dimensions" };
  }

  const out = Buffer.alloc(pixels * 3);
  const [mr, mg, mb] = plan.matrix;
  let total = 0;
  for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
    const r = source[i]! / 65535;
    const g = source[i + 1]! / 65535;
    const b = source[i + 2]! / 65535;
    const values = [
      encode(mr[0] * r + mr[1] * g + mr[2] * b),
      encode(mg[0] * r + mg[1] * g + mg[2] * b),
      encode(mb[0] * r + mb[1] * g + mb[2] * b),
    ];
    for (let c = 0; c < 3; c++) {
      const byte = Math.round(values[c]! * 255);
      out[o + c] = byte;
      total += byte;
    }
  }

  // Written beside the target and renamed, so a failure part-way cannot leave
  // a half-converted frame where the capture used to be.
  const staging = `${file}.${process.pid}.raw`;
  const encoded = `${file}.${process.pid}.png`;
  try {
    await writeFile(staging, out);
    await run(
      ffmpeg,
      ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
       "-s", `${width}x${height}`, "-i", staging, encoded],
      { windowsHide: true },
    );
    await writeFile(file, await readFile(encoded));
  } catch (cause) {
    return {
      converted: false,
      reason: `could not write the converted frame: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  } finally {
    await unlink(staging).catch(() => {});
    await unlink(encoded).catch(() => {});
  }

  return {
    converted: true,
    from: plan.label,
    meanLevel: Number((total / out.length).toFixed(1)),
  };
}

async function dimensions(
  ffmpeg: string,
  file: string,
): Promise<{ width: number; height: number }> {
  // ffmpeg reports the stream on stderr and exits non-zero with no output
  // specified, so the rejection is the expected path. ffprobe is not used:
  // `ffmpeg-static` ships only the one binary. See proxy.test.ts.
  let stderr = "";
  try {
    stderr = (await run(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true })).stderr;
  } catch (error) {
    stderr = (error as { stderr?: string }).stderr ?? "";
  }
  const match = /,\s(\d{2,5})x(\d{2,5})[,\s]/.exec(stderr);
  if (!match) throw new Error(`could not read the size of ${path.basename(file)}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
