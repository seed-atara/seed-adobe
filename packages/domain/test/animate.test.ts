import { describe, expect, it } from "vitest";
import {
  ANIMATE_TAIL,
  animatePrompt,
  defaultBeats,
  estimateTokens,
  tierFor,
} from "../src/animate.js";

/**
 * The prompt shape is a measurement, not a preference.
 *
 * Every assertion here corresponds to something that is present in the
 * generations that worked on this project and absent or weak in the ones that
 * did not — read back out of the library, written up in
 * `docs/research/SEEDANCE_2_0_COST_AND_STYLE.md`. They are here so that a
 * later tidy-up of the wording has to be a deliberate decision rather than a
 * quiet regression nobody notices until a day of rotoscoping.
 */

const SHOT = {
  describe:
    "three mariachi musicians in black charro suits with silver trim, bold " +
    "black outlines, flat colour fill",
  beats: [
    { from: 0, to: 4, action: "the trumpeter raises his horn and plays" },
    { from: 4, to: 8, action: "the harpist leans into the strings" },
    { from: 8, to: 10, action: "all three settle" },
  ],
};

describe("the cel-element prompt", () => {
  it("names the artwork before it asks for any motion", () => {
    const prompt = animatePrompt(SHOT);

    /*
     * The model already has the image; the description is there to stop it
     * redesigning. A prompt that opens with actions gets a redesign, which is
     * the single most expensive failure in this pipeline — the clip is
     * unusable and looks fine in a thumbnail.
     */
    expect(prompt.indexOf("mariachi musicians")).toBeLessThan(prompt.indexOf("0-4s"));
    expect(prompt).toContain("Image 1 as the first frame, held exactly:");
  });

  it("puts the camera note on every beat, not once at the end", () => {
    const prompt = animatePrompt(SHOT);

    // Three beats, three notes. A single global instruction gets outvoted by
    // beats that each imply a move, and a cel element that drifts cannot be
    // comped back into the plate it was cut from.
    expect(prompt.match(/camera locked off, no movement/g)).toHaveLength(3);
  });

  it("closes the last beat on the opening pose when it is a loop", () => {
    const looped = animatePrompt(SHOT);
    const once = animatePrompt({ ...SHOT, loop: false });

    expect(looped).toContain("8-10s  all three settle, returning to the exact opening pose");
    // And only the last one — a middle beat told to return to the start
    // produces a shot that twitches back three times.
    expect(looped.match(/seamless loop/g)).toHaveLength(1);
    expect(once).not.toContain("seamless loop");
  });

  it("states the backdrop twice, which is what makes it hold", () => {
    const prompt = animatePrompt(SHOT);

    // Said once at the top it survives about four seconds. The drift mid-shot
    // is what turns a clean key into rotoscoping.
    expect(prompt.match(/chroma-green/g)).toHaveLength(2);
    expect(prompt).toContain("stays pure, even and unchanged for the whole shot");
  });

  it("leaves the backdrop out cleanly rather than trailing an empty clause", () => {
    const prompt = animatePrompt({ ...SHOT, backdrop: "none" });

    expect(prompt).not.toContain("chroma-green");
    expect(prompt).not.toContain(", .");
    expect(prompt).not.toContain("; Characters stay");
    // The constraints still apply — only the backdrop clause goes.
    expect(prompt).toContain(ANIMATE_TAIL);
  });

  it("passes the caller's own words through untouched", () => {
    const prompt = animatePrompt({
      describe: "a yellow hatchback, side view",
      beats: [{ from: 0, to: 6, action: "the wheels turn and the body bounces gently." }],
    });

    // Only the trailing punctuation is tidied, so the added clause reads as
    // one sentence. Nothing is reworded.
    expect(prompt).toContain("the wheels turn and the body bounces gently,");
    expect(prompt).toContain("a yellow hatchback, side view,");
  });

  it("is deterministic, because the prompt is the reproducibility record", () => {
    expect(animatePrompt(SHOT)).toBe(animatePrompt(SHOT));
  });

  it("spreads default beats across the whole duration", () => {
    const beats = defaultBeats(9, "the crowd cheers");

    expect(beats).toHaveLength(3);
    expect(beats[0]!.from).toBe(0);
    expect(beats[2]!.to).toBe(9);
    // No gaps: a range the prompt does not mention is a range the model fills
    // with whatever it likes.
    expect(beats[1]!.from).toBe(beats[0]!.to);
    expect(beats[2]!.from).toBe(beats[1]!.to);
  });
});

describe("what a render will cost", () => {
  it("matches the real jobs it was derived from", () => {
    /*
     * Ground truth from `usage.total_tokens` on this account:
     *   10s 1080p  →  488,025 – 491,149 depending on aspect
     *   10s  720p  →  216,900
     *    6s    4K  →  1,174,500
     * Within 1% is as close as a single pixels-per-token constant can get,
     * and far closer than any published price table.
     */
    expect(estimateTokens("1080p", 10)).toBeGreaterThan(484_000);
    expect(estimateTokens("1080p", 10)).toBeLessThan(494_000);
    expect(estimateTokens("720p", 10)).toBeGreaterThan(214_000);
    expect(estimateTokens("720p", 10)).toBeLessThan(220_000);
    expect(estimateTokens("4k", 6)).toBeGreaterThan(1_160_000);
    expect(estimateTokens("4k", 6)).toBeLessThan(1_190_000);
  });

  it("keeps the ratios between tiers exact, because that is the real decision", () => {
    const at720 = estimateTokens("720p", 10)!;
    const at1080 = estimateTokens("1080p", 10)!;
    const at4k = estimateTokens("4k", 10)!;

    expect(at1080 / at720).toBeCloseTo(2.25, 2);
    expect(at4k / at1080).toBeCloseTo(4, 2);
  });

  it("doubles for a reference video", () => {
    // Measured: 34 of 150 jobs came in at 1.8–2.3x, and every one of them had
    // a video_url content part. The input clip is tokenized too.
    expect(estimateTokens("1080p", 10, { hasVideoReference: true })).toBe(
      estimateTokens("1080p", 10)! * 2,
    );
  });

  it("says nothing rather than guessing for a tier it does not know", () => {
    expect(estimateTokens("2K", 10)).toBeUndefined();
  });

  it("aims for twice the element, which is what this project actually ran", () => {
    /*
     * Not "a tier that covers it". Every clip here is 2.0–4.2 source pixels
     * per screen pixel and they are all clean; halving on the way in is what
     * hides the wobble a generated clip arrives with. Checked against the
     * real comps.
     */
    expect(tierFor(952, 513).size).toBe("1080p"); // Rooftop01 — they used 1920x1080
    expect(tierFor(825, 383).size).toBe("1080p"); // Cafe02 — they used 2120x984
    expect(tierFor(296, 367).size).toBe("720p"); // Cafe01 — a quarter the price
    expect(tierFor(952, 513).oversample).toBeCloseTo(2.02, 1);
  });

  it("admits when an element is too big to oversample at all", () => {
    const huge = tierFor(5000, 2000);

    // 4K is the ceiling, so this one cannot even be covered. Reported as the
    // real ratio rather than rounded into something reassuring — an element
    // this wide is a reason to cut it in two, and hiding that is the wrong
    // kind of help.
    expect(huge.size).toBe("4k");
    expect(huge.covers).toBe(false);
    expect(huge.oversample).toBeLessThan(1);
  });
});
