import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFor, toDisplayReferred } from "../src/media/displayReferred.js";

const run = promisify(execFile);
const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;

let root: string;
let linearSource: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "seed colour "));
  /*
   * A 16-bit RGBA PNG holding LINEAR values — the shape After Effects writes
   * from a colour-managed project. `saveFrameToPng` gives rgba64, so the
   * fixture does too; an 8-bit stand-in would not exercise the decode path.
   *
   * 0x37 is 55/255 = 0.216, which is mid-grey in *scene* terms: encoded to
   * sRGB it lands at ~128. That single number is the whole bug — the capture
   * held the scene value and everything downstream read it as a display one.
   */
  linearSource = path.join(root, "linear plate.png");
  await run(ffmpeg, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x373737:s=160x90",
    "-frames:v", "1", "-pix_fmt", "rgba64le", linearSource,
  ]);
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function meanLevel(file: string): Promise<number> {
  const { stdout } = await run(
    ffmpeg,
    ["-v", "error", "-i", file, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 28, encoding: "buffer" },
  );
  const bytes = stdout as unknown as Buffer;
  let total = 0;
  for (const value of bytes) total += value;
  return total / bytes.length;
}

describe("deciding whether a capture needs converting", () => {
  it("recognises the ACES spaces After Effects names", () => {
    expect(planFor("ACES - ACEScg")?.label).toBe("ACEScg");
    expect(planFor("ACES2065-1")?.label).toBe("ACES2065-1");
  });

  it("leaves a display-referred project alone", () => {
    // Converting an already-encoded frame would apply the transfer function
    // twice and blow out the midtones — worse than the bug being fixed.
    expect(planFor("sRGB IEC61966-2.1")).toBeUndefined();
    expect(planFor("Rec.709")).toBeUndefined();
    expect(planFor("")).toBeUndefined();
    expect(planFor(undefined)).toBeUndefined();
  });

  it("converts a linear Rec.709 project, which is display primaries but not display transfer", () => {
    expect(planFor("Linear Rec.709")?.label).toBe("linear Rec.709");
  });

  it("refuses a log space rather than guessing a curve for it", () => {
    // ACEScct needs a curve, not a matrix. A plausible-looking wrong picture
    // is worse than an obviously dark one that prompts a question.
    expect(planFor("ACEScct")).toBeUndefined();
    expect(planFor("ARRI LogC4")).toBeUndefined();
  });
});

describe("converting the frame", () => {
  it("lifts linear midtones to where a screen expects them", async () => {
    const file = path.join(root, "capture.png");
    await copyFile(linearSource, file);

    const before = await meanLevel(file);
    const result = await toDisplayReferred(file, "ACES - ACEScg", { env: { SEED_FFMPEG: ffmpeg } });

    expect(result.converted).toBe(true);
    expect(result.from).toBe("ACEScg");

    const after = await meanLevel(file);
    // Linear 0.216 is sRGB ~0.5. That is the whole bug: the capture held the
    // scene value and everything downstream read it as a display value.
    expect(before).toBeLessThan(70);
    expect(after).toBeGreaterThan(110);
    expect(after).toBeLessThan(160);
  }, 120_000);

  it("does nothing, and says so, for a space it does not know", async () => {
    const file = path.join(root, "untouched.png");
    await copyFile(linearSource, file);
    const before = await meanLevel(file);

    const result = await toDisplayReferred(file, "ACEScct", { env: { SEED_FFMPEG: ffmpeg } });
    expect(result.converted).toBe(false);
    expect(result.reason).toMatch(/nothing to do/);
    expect(await meanLevel(file)).toBeCloseTo(before, 5);
  }, 60_000);

  it("leaves the capture alone when there is no ffmpeg", async () => {
    const file = path.join(root, "no-ffmpeg.png");
    await copyFile(linearSource, file);
    const before = await meanLevel(file);

    const result = await toDisplayReferred(file, "ACES - ACEScg", {
      env: { SEED_FFMPEG: path.join(root, "not-a-binary") },
    });
    expect(result.converted).toBe(false);
    expect(result.reason).toMatch(/no ffmpeg/);
    // A capture that cannot be converted is still a capture.
    expect(await meanLevel(file)).toBeCloseTo(before, 5);
  }, 60_000);
});
