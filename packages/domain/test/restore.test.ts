import { describe, expect, it } from "vitest";
import {
  RESTORE_ORDER,
  RESTORE_PRESETS,
  restorePrompt,
} from "../src/restore.js";

/**
 * The prompts are the product here. A restoration runs on a generative model,
 * so the only thing standing between "restore this newsreel" and a model
 * helpfully making a better shot is the wording — and a restoration that
 * quietly acquires creative latitude is indistinguishable from a working one
 * until an editor spots that a sign changed.
 */

describe("the restoration catalogue", () => {
  it("offers every treatment a prompt and a promise", () => {
    for (const treatment of RESTORE_ORDER) {
      const preset = RESTORE_PRESETS[treatment];
      expect(preset.prompt.length).toBeGreaterThan(200);
      // The fidelity line is what an editor reads before committing a shot to
      // a cut, so it has to say something specific rather than reassure.
      expect(preset.fidelity.length).toBeGreaterThan(40);
    }
  });

  it("says something different about each one", () => {
    const wording = new Set(RESTORE_ORDER.map((t) => RESTORE_PRESETS[t].fidelity));
    expect(wording.size).toBe(RESTORE_ORDER.length);
  });

  it("is honest that colour is invented rather than recovered", () => {
    // No arithmetic recovers the colour of a 1937 omnibus. Saying so is the
    // difference between a documentary caption that is true and one that is not.
    expect(RESTORE_PRESETS.colourise.fidelity).toMatch(/invents colour/i);
  });
});

describe("the restoration prompt", () => {
  it("forbids every way a model would helpfully improve the shot", () => {
    const prompt = restorePrompt("colourise");
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
    const colour = restorePrompt("colourise");
    expect(colour).toContain("Do not add detail");
    expect(colour).toContain("do not clean up damage");

    const detail = restorePrompt("detail");
    expect(detail).toContain("Add no colour whatsoever");
    expect(detail).toContain("Do not clean up damage");

    const clean = restorePrompt("clean");
    expect(clean).toContain("Do not sharpen");
    expect(clean).toContain("do not colourise");
  });

  it("frames a note as a constraint, never as a new instruction", () => {
    const prompt = restorePrompt("colourise", "trams are green and cream");
    expect(prompt).toContain("trams are green and cream");
    /*
     * The wording around the note is what stops "make it cinematic" working.
     * A note appended bare would read as the most recent and most specific
     * instruction in the prompt, which is exactly the position that wins.
     */
    expect(prompt).toContain("never as permission to change the shot");
    // And the restriction lands before the note, not after it.
    expect(prompt.indexOf("never as permission")).toBeLessThan(
      prompt.indexOf("trams are green"),
    );
  });

  it("ignores a blank note rather than appending an empty clause", () => {
    const bare = restorePrompt("repair");
    expect(restorePrompt("repair", "   ")).toBe(bare);
    expect(restorePrompt("repair", "")).toBe(bare);
  });
});
