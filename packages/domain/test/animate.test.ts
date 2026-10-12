import { describe, expect, it } from "vitest";
import {
  ANIMATE_TAIL,
  animatePrompt,
  defaultBeats,
  estimateTokens,
  tierFor,
  aspectFits,
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

  it("offers a backdrop for artwork that is already green", () => {
    /*
     * Not a style option. Measured on the four GYG entities as the distance
     * from pure chroma green to the nearest artwork pixel: the mariachi trio
     * is 127 clear, but the taco date is **54** — inside the matte's default
     * tolerance of 60 before anything is generated, because the man is
     * wearing green shorts. On green, his shorts are background.
     *
     * So the backdrop has to be choosable per element, and the alternative
     * has to read to the model exactly like the green one does.
     */
    const blue = animatePrompt({ ...SHOT, backdrop: "blue" });

    expect(blue.match(/chroma-blue/g)).toHaveLength(2);
    expect(blue).toContain("stays pure, even and unchanged for the whole shot");
    expect(blue).not.toContain("chroma-green");

    // Same sentence, one word different — the wording is what the eleven
    // generations that worked used, and only the colour may vary.
    const green = animatePrompt(SHOT);
    expect(blue).toBe(green.replace(/chroma-green/g, "chroma-blue"));
  });

  it("can hold the subject on the spot so it can be moved by hand", () => {
    /*
     * The difference between this and `camera locked off` is the whole
     * point: that one stops the frame moving, this stops the subject moving
     * inside it. A walk cycle that walks across frame can be used once, at
     * the speed and in the direction the model picked. One on the spot is a
     * loop the artist drives with a Position keyframe.
     */
    const cycle = animatePrompt({ ...SHOT, inPlace: true });

    expect(cycle).toContain("animated as a cycle on the spot");
    expect(cycle).toContain("no travel across frame");
    // Said twice, like the backdrop, and for the same measured reason.
    expect(cycle.match(/on the spot/g)).toHaveLength(2);

    // The locked camera is still on every beat. They are not alternatives.
    expect(cycle.match(/camera locked off/g)).toHaveLength(SHOT.beats.length);
  });

  it("says where the subject must stay before the generic constraints", () => {
    const cycle = animatePrompt({ ...SHOT, inPlace: true });
    // The specific instruction outranks the boilerplate, and the last thing
    // read carries least.
    expect(cycle.indexOf("no travel across frame")).toBeLessThan(cycle.indexOf(ANIMATE_TAIL));
  });

  it("leaves it out entirely when the element is meant to travel", () => {
    expect(animatePrompt(SHOT)).not.toContain("on the spot");
  });

  it("can hold the subject clear of every frame edge", () => {
    /*
     * Measured across eleven finished GYG elements: every one had opaque
     * alpha running along at least one frame edge, because a plate captured
     * from a PSD layer IS that layer's bounding box. The car lost its
     * bumpers across 60% of the left edge. Invisible until the artist moves
     * the layer, at which point the cut reads as a line across the artwork.
     */
    const framed = animatePrompt({ ...SHOT, margin: true });

    expect(framed).toContain("clear empty space on all four sides");
    expect(framed).toContain("must never touch, cross or be cropped by any edge");
    // Stated twice, like the backdrop and the in-place note.
    expect(framed.match(/clear empty/g)).toHaveLength(2);
  });

  it("does not ask for margin on an element meant to run off frame", () => {
    // A balcony railing that continues behind an arch column, or a bag being
    // handed out of shot, is supposed to touch the edge.
    expect(animatePrompt(SHOT)).not.toContain("clear empty");
  });

  it("stacks the frame constraints in order of how specific they are", () => {
    const both = animatePrompt({ ...SHOT, inPlace: true, margin: true });
    expect(both.indexOf("no travel across frame"))
      .toBeLessThan(both.indexOf("must never touch, cross or be cropped"));
    expect(both.indexOf("must never touch, cross or be cropped"))
      .toBeLessThan(both.indexOf(ANIMATE_TAIL));
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

  it("treats a tier as a pixel budget, not a width", () => {
    /*
     * The correction that paid for itself. `aspectRatio: "adaptive"` spends
     * a tier's pixels in the ELEMENT's shape, so a tier's nominal width only
     * describes a 16:9 element.
     *
     * Measured: the mariachi element is 564x421, it was asked for at 1080p,
     * and Ark returned 1664x1248 — 2,076,672 pixels against 1080p's
     * 2,073,600, and nothing like 1920 wide. After Effects then reported a
     * pixel ratio of 2.95 for that layer.
     */
    const mariachi = tierFor(564, 421);
    expect(mariachi.size).toBe("1080p");
    expect(mariachi.oversample).toBeCloseTo(2.95, 1);

    /*
     * And the case that was costing money. A bunting strand is 8:1. By
     * nominal width 1920 "could not" cover 2103, so the old rule reached for
     * 4K — four times the price — when 1080p at that aspect is 4080x508 and
     * oversamples it nearly twice over.
     */
    expect(Math.sqrt(2073600 / (2103 * 262))).toBeCloseTo(1.94, 1);
    expect(tierFor(2103, 262, 1.9).size).toBe("1080p");
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

describe("shapes Seedance will not make", () => {
  it("turns down an element wider than 21:9 before it is paid for", () => {
    /*
     * The GYG cloud bank, 2083x591. Asked for at `adaptive`, Ark returned
     * 2206x946 — 21:9 — having zoomed into the middle of the plate and
     * thrown most of the clouds away. `adaptive` crops to the nearest
     * supported aspect; it does not fit to it.
     */
    const clouds = aspectFits(2083, 591);
    expect(clouds.fits).toBe(false);
    expect(clouds.aspect).toBeCloseTo(3.525, 2);
    expect(clouds.why).toContain("crop");

    // And the case that makes the point: an 8:1 bunting strand was never
    // generatable at its own shape, whatever tier it was sent at.
    expect(aspectFits(2103, 262).fits).toBe(false);
  });

  it("passes the shapes that actually came back right", () => {
    for (const [w, h] of [[564, 421], [952, 513], [354, 379], [875, 441], [244, 433]]) {
      expect(aspectFits(w!, h!).fits).toBe(true);
    }
  });

  it("turns down an element taller than 9:21 as well", () => {
    expect(aspectFits(200, 900).fits).toBe(false);
  });
});
