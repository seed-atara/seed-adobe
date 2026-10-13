import { describe, expect, it } from "vitest";
import { planClampAlpha } from "../src/clampAlpha.js";

/**
 * The graph, not the pixels.
 *
 * An ffmpeg filter graph fails quietly: a swapped `alphamerge` input order
 * gives an inverted clip that still plays, and a matte left in RGB gives an
 * alpha mixed out of three channels that is subtly wrong everywhere. Both
 * look fine in a thumbnail and are discovered in After Effects, which is the
 * one place this repo cannot run a test. So the string is asserted here.
 */
describe("clamping a clip to a matte", () => {
  const base = {
    input: "clip.mp4",
    matte: "matte.png",
    output: "out.mov",
    width: 1440,
    height: 1440,
  };

  it("feeds alphamerge the picture first and the matte second, as grey", () => {
    const plan = planClampAlpha(base);
    const filter = plan.args[plan.args.indexOf("-filter_complex") + 1]!;

    expect(filter).toContain("[v][m]alphamerge[out]");
    expect(filter).toContain("[1:v]format=gray");
    // The picture is input 0 and keeps an alpha channel to merge into.
    expect(filter).toContain("[0:v]scale=1440:1440:flags=lanczos,format=rgba[v]");
  });

  it("writes ProRes 4444 with alpha, and no audio track", () => {
    const { args } = planClampAlpha(base);
    expect(args.join(" ")).toContain("-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le");
    expect(args).toContain("-an");
    expect(args[args.length - 1]).toBe("out.mov");
  });

  it("keeps the clip's resolution by default, and the matte's when asked", () => {
    expect(planClampAlpha(base)).toMatchObject({ width: 1440, height: 1440 });
    /*
     * The default is the one that keeps detail: a clip generated at a tier's
     * pixel budget is usually larger than the region it came from, and
     * downscaling here throws that away before After Effects can use it.
     */
    const down = planClampAlpha({ ...base, toMatte: { width: 1140, height: 1140 } });
    expect(down).toMatchObject({ width: 1140, height: 1140 });
    const filter = down.args[down.args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("scale=1140:1140");
  });

  it("refuses an odd dimension rather than losing a line in a decoder", () => {
    expect(() => planClampAlpha({ ...base, width: 1441 })).toThrow(/odd dimension/);
    expect(() => planClampAlpha({ ...base, height: 1141 })).toThrow(/odd dimension/);
  });

  it("refuses a size it was not really given", () => {
    for (const size of [{ width: 0 }, { height: 1 }, { width: 1440.5 }]) {
      expect(() => planClampAlpha({ ...base, ...size })).toThrow(/real frame size/);
    }
  });

  it("refuses a missing path instead of writing somewhere surprising", () => {
    expect(() => planClampAlpha({ ...base, output: "" })).toThrow(/input, a matte and an output/);
    expect(() => planClampAlpha({ ...base, matte: "" })).toThrow(/input, a matte and an output/);
  });
});
