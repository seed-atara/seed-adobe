import { describe, expect, it } from "vitest";
import {
  RESTORE_ORDER,
  RESTORE_PRESETS,
  laneOffer,
  lanesFor,
  restorePrompt,
} from "../src/restore.js";

/**
 * The prompts are the product on the generated lane, and the *absence* of one
 * is the product on the measured lane. Both are worth holding still: a
 * restoration that quietly acquires creative latitude is indistinguishable
 * from a working one until an editor spots that a sign changed.
 */

describe("what each lane can promise", () => {
  it("offers no measured lane for anything that has to invent", () => {
    // Colour was never recorded and damage hid what it covered. Neither is
    // recoverable by arithmetic, so offering an upscaler for them would be a
    // promise nothing can keep.
    expect(lanesFor("colourise")).toEqual(["generated"]);
    expect(lanesFor("repair")).toEqual(["generated"]);
  });

  it("offers both lanes where both can genuinely do the work", () => {
    expect(lanesFor("detail")).toEqual(["measured", "generated"]);
    expect(lanesFor("clean")).toEqual(["measured", "generated"]);
  });

  it("puts the safest lane first, so a default choice is the conservative one", () => {
    for (const treatment of RESTORE_ORDER) {
      const first = RESTORE_PRESETS[treatment].lanes[0];
      if (lanesFor(treatment).includes("measured")) {
        expect(first?.lane).toBe("measured");
      }
    }
  });

  it("says what it can promise, differently, for every offer", () => {
    const wording = new Set<string>();
    for (const treatment of RESTORE_ORDER) {
      for (const offer of RESTORE_PRESETS[treatment].lanes) {
        expect(offer.fidelity.length).toBeGreaterThan(40);
        wording.add(offer.fidelity);
      }
    }
    // Every pair says something specific rather than one sentence reused.
    expect(wording.size).toBe(
      RESTORE_ORDER.reduce((total, t) => total + RESTORE_PRESETS[t].lanes.length, 0),
    );
  });
});

describe("the restoration prompt", () => {
  it("has none at all on the measured lane", () => {
    // Not an empty string — undefined, so a caller cannot accidentally send
    // one. An upscaler has no prompt field, and a note that goes nowhere is
    // worse than no note because the artist believes it was applied.
    expect(restorePrompt("detail", "measured")).toBeUndefined();
    expect(restorePrompt("clean", "measured", "make it warmer")).toBeUndefined();
  });

  it("forbids every way a model would helpfully improve the shot", () => {
    const prompt = restorePrompt("colourise", "generated") ?? "";
    for (const forbidden of [
      "reframe",
      "recrop",
      "re-time",
      "stabilise",
      "recompose",
      "beautify",
      "modernise",
    ]) {
      expect(prompt.toLowerCase()).toContain(forbidden);
    }
    // The identity of the people in the frame is the thing an editor cannot
    // let drift, so it is pinned by name rather than left to "keep the subject".
    expect(prompt).toContain("identity");
  });

  it("keeps colourising to colour, and detail to detail", () => {
    // Each treatment has to exclude the others explicitly. Asked for colour, a
    // model will happily sharpen too, and then two passes cannot be compared.
    const colour = restorePrompt("colourise", "generated") ?? "";
    expect(colour).toContain("Do not add detail");
    expect(colour).toContain("do not clean up damage");

    const detail = restorePrompt("detail", "generated") ?? "";
    expect(detail).toContain("Add no colour whatsoever");
    expect(detail).toContain("Do not clean up damage");
  });

  it("frames a note as a constraint, never as a new instruction", () => {
    const prompt = restorePrompt("colourise", "generated", "trams are green and cream") ?? "";
    expect(prompt).toContain("trams are green and cream");
    /*
     * The wording around the note is what stops "make it cinematic" working.
     * A note appended bare would read as the most recent and most specific
     * instruction in the prompt, which is exactly the position that wins.
     */
    expect(prompt).toContain("never as permission to change the shot");
    // And it lands after the restriction, not before it.
    expect(prompt.indexOf("never as permission")).toBeLessThan(
      prompt.indexOf("trams are green"),
    );
  });

  it("ignores a blank note rather than appending an empty clause", () => {
    const bare = restorePrompt("repair", "generated");
    expect(restorePrompt("repair", "generated", "   ")).toBe(bare);
    expect(restorePrompt("repair", "generated", "")).toBe(bare);
  });

  it("has no prompt for a lane a treatment does not offer", () => {
    expect(restorePrompt("colourise", "measured")).toBeUndefined();
    expect(laneOffer("colourise", "measured")).toBeUndefined();
  });
});
