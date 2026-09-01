import { describe, expect, it } from "vitest";
import {
  keyframePrompt,
  DEFAULT_FREEDOM,
  RESTORE_ORDER,
  RESTORE_PRESETS,
  latitudeFor,
  presetLook,
  restorePrompt,
} from "../src/restore.js";

/**
 * The prompt shape is the product here, and it was wrong once already.
 *
 * The first version was a paragraph of pure prohibition. Measured on real
 * footage it produced worse pictures *and* invented motion, which BytePlus's
 * own guidance predicts: Seedance reads a spatial layer and a temporal one,
 * and a prompt made only of "do not" gives the temporal layer nothing to
 * follow. These tests hold the corrected shape — lead with what to make, keep
 * the constraints to a closing tail — because the failure it replaces looked
 * like a working feature.
 */

describe("the look presets", () => {
  it("gives every preset text an artist can read and edit", () => {
    for (const id of RESTORE_ORDER) {
      const preset = RESTORE_PRESETS[id];
      expect(preset.look.length).toBeGreaterThan(120);
      expect(presetLook(id)).toBe(preset.look);
    }
  });

  it("describes what to make rather than what to avoid", () => {
    /*
     * The heart of the redesign. A preset that opens with prohibitions is the
     * old failure returning, so the openings are held to positive description
     * — no preset may be mostly "no" and "not".
     */
    for (const id of RESTORE_ORDER) {
      const look = RESTORE_PRESETS[id].look;
      const negatives = (look.match(/\b(no|not|never|avoid|do not)\b/gi) ?? []).length;
      const sentences = look.split(/\.\s/).length;
      expect(negatives).toBeLessThan(sentences);
    }
  });

  it("asks for the detail that makes a restoration worth running", () => {
    // Every look has to name concrete surfaces. "High quality" renders
    // nothing; "rivets and panel lines on metal" renders rivets.
    for (const id of RESTORE_ORDER) {
      expect(RESTORE_PRESETS[id].look).toMatch(
        /detail|texture|grain|weave|rivet|pores|lettering/i,
      );
    }
  });

  it("keeps monochrome monochrome, and says so first", () => {
    // The one preset that must exclude something, because "add detail" on
    // black and white footage otherwise invites colour.
    expect(RESTORE_PRESETS.monochrome.look).toMatch(/^Black and white throughout/);
  });
});

describe("the restoration prompt", () => {
  it("opens by anchoring to the reference, so Ark still reads it as an edit", () => {
    /*
     * Load-bearing, and easy to break by making the prompt read better. Ark
     * classifies a request carrying a reference video by what the prompt asks
     * for, and only an edit may send `duration: -1` — which is what keeps the
     * result attached to the source instead of becoming a new shot of an
     * arbitrary length.
     */
    const prompt = restorePrompt(presetLook("detail"));
    expect(prompt.startsWith("Re-render this exact footage")).toBe(true);
    expect(prompt).toContain("reference video is the shot");
  });

  it("puts the look in the middle and the constraints at the end", () => {
    const prompt = restorePrompt("shot on Kodachrome, fine grain");
    const look = prompt.indexOf("Kodachrome");
    const tail = prompt.indexOf("no flicker");
    expect(look).toBeGreaterThan(0);
    // The published shape: constraints are an always-append tail, not an
    // opening wall. Inverting this is what buried the description of what to
    // make under two hundred words of prohibition.
    expect(tail).toBeGreaterThan(look);
    expect(prompt.trimEnd().endsWith("no invented objects or people.")).toBe(true);
  });

  it("holds framing, camera and timing at every setting of the slider", () => {
    /*
     * The slider controls how freely the picture may be rendered, never how
     * freely the shot may be re-staged. Letting framing or timing loose at the
     * top of the range would make it an ordinary generation with a clip
     * attached — which the Generate tab already is — and would also risk Ark
     * refusing `duration: -1`, the only thing tying the result to the source.
     */
    for (const freedom of [0, 25, 50, 75, 100]) {
      const prompt = restorePrompt(presetLook("detail"), { freedom }).toLowerCase();
      for (const held of ["framing", "camera", "perspective", "cuts", "timing"]) {
        expect(prompt).toContain(held);
      }
      expect(prompt.startsWith("re-render this exact footage")).toBe(true);
    }
  });

  it("frames a note as background rather than an instruction", () => {
    const prompt = restorePrompt(presetLook("colourise"), { note: "RAF airfield, 1941" });
    expect(prompt).toContain("RAF airfield, 1941");
    /*
     * A note appended bare sits at the end of the prompt as the most recent
     * and most specific instruction, which is the position that wins. Framed
     * as background and placed before the tail, it informs rather than steers.
     */
    expect(prompt).toContain("background for the render rather than an instruction");
    expect(prompt.indexOf("RAF airfield")).toBeLessThan(prompt.indexOf("no flicker"));
  });

  it("ignores a blank note rather than appending an empty clause", () => {
    const bare = restorePrompt(presetLook("clean"));
    expect(restorePrompt(presetLook("clean"), { note: "   " })).toBe(bare);
    expect(restorePrompt(presetLook("clean"), { note: "" })).toBe(bare);
  });

  it("sends the artist's own words when they have replaced the preset", () => {
    // The field is editable and what is on screen is what gets sent. A preset
    // that survived into the prompt regardless would make the control a lie.
    const prompt = restorePrompt("grainy 16mm reversal, blown highlights");
    expect(prompt).toContain("grainy 16mm reversal");
    expect(prompt).not.toContain("35mm colour negative");
  });
});

describe("the freedom slider", () => {
  it("defaults to the middle, which is what an artist means by restore", () => {
    expect(DEFAULT_FREEDOM).toBe(50);
    expect(latitudeFor(DEFAULT_FREEDOM).label).toBe("Balanced");
    // No argument is the same as the default, so the route and a bare call
    // cannot drift apart.
    expect(restorePrompt("x")).toBe(restorePrompt("x", { freedom: DEFAULT_FREEDOM }));
  });

  it("moves through three named bands and clamps outside them", () => {
    expect(latitudeFor(0).label).toBe("Faithful");
    expect(latitudeFor(33).label).toBe("Faithful");
    expect(latitudeFor(34).label).toBe("Balanced");
    expect(latitudeFor(66).label).toBe("Balanced");
    expect(latitudeFor(67).label).toBe("Free");
    expect(latitudeFor(100).label).toBe("Free");
    // A slider cannot send these, but a request can.
    expect(latitudeFor(-40).label).toBe("Faithful");
    expect(latitudeFor(9999).label).toBe("Free");
  });

  it("actually changes the prompt, rather than being a control that does nothing", () => {
    const faithful = restorePrompt(presetLook("detail"), { freedom: 0 });
    const balanced = restorePrompt(presetLook("detail"), { freedom: 50 });
    const free = restorePrompt(presetLook("detail"), { freedom: 100 });
    expect(new Set([faithful, balanced, free]).size).toBe(3);

    // Faithful forbids reinterpretation outright; free invites it. That is the
    // whole axis, and it is worth asserting because a slider wired to nothing
    // is indistinguishable from a slider that works.
    expect(faithful).toContain("nothing is reinterpreted");
    expect(free).toContain("Reinterpret the surfaces");
  });
});

describe("the key-frame prompt", () => {
  it("demands deep focus, because a sharp lens means the opposite to an image model", () => {
    /*
     * The first real key frame came back photoreal and soft — shallow depth of
     * field, background thrown out. "Sharp prime lens" reads as a flattering
     * portrait look, which is the opposite of archive: documentary photography
     * where everything front to back reads.
     */
    const prompt = keyframePrompt("modern digital cinema camera").toLowerCase();
    for (const wanted of ["deep depth of field", "no background blur", "no motion blur"]) {
      expect(prompt).toContain(wanted);
    }
  });

  it("pins this scene rather than a scene like it", () => {
    const prompt = keyframePrompt("sharp and detailed");
    // An image model given latitude composes a better photograph, and a better
    // photograph of different people is worthless for archive.
    expect(prompt).toContain("same position");
    expect(prompt).toContain("Nothing enters the frame and nothing leaves it");
    // Anatomy is named because it is what fails first and what an audience
    // notices first.
    expect(prompt).toContain("right number of fingers");
  });

  it("says the reference is degraded, so its softness is not copied", () => {
    const prompt = keyframePrompt("sharp");
    expect(prompt).toContain("Do not reproduce its softness");
  });
});
