import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plateAgreement } from "../src/media/agreement.js";

const run = promisify(execFile);

/** The bundled binary, so this runs the same everywhere rather than on PATH. */
const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;
const env = { ...process.env, SEED_FFMPEG: ffmpeg };

/**
 * The measurement has exactly two claims, and they pull against each other.
 *
 * It must notice when the picture *moves*, because a roof line that slid is
 * what gets a transformed plate rejected. And it must not notice when the
 * picture is merely *repainted*, because that is the job — a correct
 * summer-to-winter is supposed to look nothing like its plate.
 *
 * Either claim is easy to satisfy alone. A similarity score gets the second
 * one catastrophically wrong, which is why this is not one, and why the
 * repainted case below is the more important of the two tests.
 */

let root: string;
/** 1600x900 with real structure in it — something to correlate against. */
let plate: string;
/** Same geometry, tones destroyed: what a legitimate transformation does. */
let repainted: string;
/** Same tones, content slid 40px left: what a failed one does. */
let drifted: string;
/** Nothing in it at all — the case that must refuse to answer. */
let blank: string;

const PLATE_WIDTH = 1600;
const DRIFT = 40;

// Five ffmpeg invocations, for the same reason the tests below get 60s.
beforeAll(async () => {
  // A space in the path, like every real project folder.
  root = await mkdtemp(path.join(tmpdir(), "seed agreement "));

  const source = path.join(root, "source frame.png");
  await run(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1",
    "-frames:v", "1", source,
  ]);

  plate = path.join(root, "plate.png");
  await run(ffmpeg, [
    "-y", "-loglevel", "error", "-i", source,
    "-vf", `crop=${PLATE_WIDTH}:900:100:100`, "-frames:v", "1", plate,
  ]);

  /*
   * Repainting, done as brutally as possible: the tones are inverted and the
   * contrast crushed, so almost no pixel holds its original value while every
   * edge stays exactly where it was. A metric that scores brightness or
   * similarity fails this outright. That is the point of including it.
   */
  repainted = path.join(root, "repainted.png");
  await run(ffmpeg, [
    "-y", "-loglevel", "error", "-i", source,
    "-vf", `crop=${PLATE_WIDTH}:900:100:100,negate,eq=contrast=0.45:brightness=0.2`,
    "-frames:v", "1", repainted,
  ]);

  // Cropped 40px further right, so the content sits 40px left of where it was.
  drifted = path.join(root, "drifted.png");
  await run(ffmpeg, [
    "-y", "-loglevel", "error", "-i", source,
    "-vf", `crop=${PLATE_WIDTH}:900:${100 + DRIFT}:100`, "-frames:v", "1", drifted,
  ]);

  blank = path.join(root, "blank.png");
  await run(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=gray:size=${PLATE_WIDTH}x900`,
    "-frames:v", "1", blank,
  ]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/*
 * Every test here shells out to ffmpeg twice on a 1600x900 frame, which takes
 * a few seconds on a warm machine and longer on a cold one. Vitest's default
 * 5s is sized for tests that do arithmetic, and this one measures images, so
 * the first test in the file failed on timing roughly as often as it passed
 * and got written off as a flake for a week. It was not flaky; it was
 * correct and slow, and the limit was wrong.
 */
describe("measuring a plate against its render", { timeout: 60_000 }, () => {
  it("reports no movement when a frame is compared to itself", async () => {
    const agreement = await plateAgreement(plate, plate, { plateWidth: PLATE_WIDTH, env });
    expect(agreement.measured).toBeGreaterThan(20);
    expect(agreement.medianDistance).toBe(0);
    expect(agreement.held).toBe(1);
  });

  it("reports no movement when the surfaces are repainted but nothing moved", async () => {
    /*
     * The load-bearing test. This is a summer-to-winter that went *right*:
     * every tone destroyed, every edge where it was. A similarity score would
     * call this a total failure and argue for the timid render over the
     * correct one, which is the specific way this feature could be worse than
     * having no feature.
     */
    const agreement = await plateAgreement(plate, repainted, {
      plateWidth: PLATE_WIDTH,
      env,
    });
    expect(agreement.measured).toBeGreaterThan(20);
    expect(agreement.medianDistance).toBeLessThanOrEqual(agreement.tolerance);
    expect(agreement.held).toBeGreaterThan(0.9);
  });

  it("reports the distance, and roughly the right one, when content slides", async () => {
    const agreement = await plateAgreement(plate, drifted, {
      plateWidth: PLATE_WIDTH,
      env,
    });
    expect(agreement.measured).toBeGreaterThan(20);
    // Measured at a 480-wide working scale, so a 40px plate drift lands on
    // about 12 working pixels and comes back quantised to ~3.3px steps.
    expect(agreement.medianDistance).toBeGreaterThan(DRIFT * 0.7);
    expect(agreement.medianDistance).toBeLessThan(DRIFT * 1.3);
    expect(agreement.held).toBeLessThan(0.2);
  });

  it("says which region is worst, so an artist can be pointed at it", async () => {
    const agreement = await plateAgreement(plate, drifted, {
      plateWidth: PLATE_WIDTH,
      env,
    });
    expect(agreement.worst).toBeDefined();
    expect(agreement.worst!.distance).toBeGreaterThanOrEqual(agreement.medianDistance);
    expect(agreement.worst!.column).toBeGreaterThanOrEqual(0);
    expect(agreement.worst!.row).toBeGreaterThanOrEqual(0);
  });

  it("refuses to answer about a frame with nothing in it", async () => {
    /*
     * Flat regions produce confident numbers about nothing — the same mistake
     * as the flat-sky crop that read +678% during the restoration work, which
     * is why the rule is enforced in code rather than left to the reader. A
     * blank frame must come back as "measured nothing", not as "held
     * perfectly".
     */
    const agreement = await plateAgreement(blank, blank, { plateWidth: PLATE_WIDTH, env });
    expect(agreement.measured).toBe(0);
    expect(agreement.skipped).toBeGreaterThan(0);
    expect(agreement.worst).toBeUndefined();
    expect(agreement.held).toBe(0);
  });

  it("compares a 4K render to a 1080 plate without being told they differ", async () => {
    // Both sides reduce to a common working width, so a render that came back
    // larger than its plate — which is the normal case — still compares.
    const large = path.join(root, "large.png");
    await run(ffmpeg, [
      "-y", "-loglevel", "error", "-i", plate,
      "-vf", "scale=3840:-2", "-frames:v", "1", large,
    ]);

    const agreement = await plateAgreement(plate, large, { plateWidth: PLATE_WIDTH, env });
    expect(agreement.measured).toBeGreaterThan(20);
    expect(agreement.medianDistance).toBeLessThanOrEqual(agreement.tolerance);
  });
});
