import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPTH,
  TRANSFORM_ORDER,
  TRANSFORM_PRESETS,
  depthFor,
  presetChange,
  transformKeyframePrompt,
  transformPrompt,
} from "../src/transform.js";
import { keyframePrompt, restorePrompt } from "../src/restore.js";

/**
 * A transformation fails in the opposite direction to a restoration, and these
 * tests exist to hold that distinction in place.
 *
 * Summer-to-winter run through the restore path came back as a different shot
 * that happened to be wintry — camera moved, buildings reshaped, people
 * replaced. Two causes, and both are the kind that come back if someone tidies
 * the prompts later: the freedom slider granted a blanket licence in order to
 * obtain one change, and the key-frame prompt forbade the very change being
 * asked for.
 */

describe("the change presets", () => {
  it("gives every preset text an artist can read and edit", () => {
    for (const id of TRANSFORM_ORDER) {
      const preset = TRANSFORM_PRESETS[id];
      expect(preset.change.length).toBeGreaterThan(200);
      expect(presetChange(id)).toBe(preset.change);
    }
  });

  it("describes what the season does to a place, not what a picture looks like", () => {
    /*
     * The single biggest lever on plate fidelity. "Snow lies on every
     * upward-facing surface" renders snow onto the surfaces already in frame;
     * "a beautiful winter scene" renders a different place. Every preset has
     * to open by acting on *this* location.
     */
    for (const id of TRANSFORM_ORDER) {
      expect(TRANSFORM_PRESETS[id].change).toMatch(/^The same place/);
    }
  });

  it("names concrete surfaces, because a model renders nouns", () => {
    for (const id of TRANSFORM_ORDER) {
      expect(TRANSFORM_PRESETS[id].change).toMatch(
        /ground|roof|branch|foliage|grass|surface|shadow|sky|water|stone|metal/i,
      );
    }
  });
});

describe("the transformation prompt", () => {
  it("opens as an edit of the plate, so Ark still reads it as one", () => {
    /*
     * Load-bearing and easy to break by making the prompt read better. Ark
     * classifies a request carrying a reference video by what the prompt asks
     * for, and only an edit may send `duration: -1` — which is what keeps the
     * result attached to the plate rather than becoming a new shot of an
     * arbitrary length.
     */
    const prompt = transformPrompt(presetChange("winter"));
    expect(prompt.startsWith("Re-render this exact footage")).toBe(true);
    expect(prompt).toContain("reference video is the plate");
  });

  it("holds the camera, the geometry, the people and the cut at every depth", () => {
    // The plate lock is not on the slider. A setting that let any of these go
    // would be an ordinary generation with a clip attached.
    for (const depth of [0, 25, 50, 75, 100]) {
      const prompt = transformPrompt(presetChange("winter"), { depth }).toLowerCase();
      for (const held of [
        "same place at the same height on the same lens",
        "keeps its exact shape, size, position and proportion",
        "same part of the sky",
        "same person",
        "nothing enters the frame and nothing leaves it",
        "cuts and the timing",
      ]) {
        expect(prompt).toContain(held);
      }
    }
  });

  it("never grants the blanket licence that the freedom slider grants", () => {
    /*
     * The actual bug, asserted directly. Restoration's top band hands over
     * every surface, texture and light in the picture — correct there, because
     * the whole picture is being re-rendered and nothing in it is supposed to
     * become a different thing. Handed to a transformation it is permission to
     * change everything in order to change one thing, which is what produced a
     * winter shot of somewhere else.
     */
    const restoreFree = restorePrompt(presetChange("winter"), { freedom: 100 });
    expect(restoreFree).toContain("Reinterpret the surfaces");

    for (const depth of [0, 50, 100]) {
      const prompt = transformPrompt(presetChange("winter"), { depth });
      expect(prompt).not.toContain("Reinterpret the surfaces");
      expect(prompt).not.toContain("freely");
    }
  });

  it("puts the change before the constraints, per the published shape", () => {
    const prompt = transformPrompt("the same place under three feet of snow");
    const change = prompt.indexOf("three feet of snow");
    const keep = prompt.indexOf("Everything else is identical");
    const tail = prompt.indexOf("Wiped against the original");
    expect(change).toBeGreaterThan(0);
    // Constraints are an always-append tail, not an opening wall — the shape
    // that measured badly for restoration when it was inverted.
    expect(keep).toBeGreaterThan(change);
    expect(tail).toBeGreaterThan(keep);
  });

  it("frames a note as background rather than an instruction", () => {
    const prompt = transformPrompt(presetChange("winter"), { note: "Kent, 1943" });
    expect(prompt).toContain("Kent, 1943");
    expect(prompt).toContain("background for the render rather than an instruction");
  });

  it("ignores a blank note rather than appending an empty clause", () => {
    const bare = transformPrompt(presetChange("fog"));
    expect(transformPrompt(presetChange("fog"), { note: "   " })).toBe(bare);
    expect(transformPrompt(presetChange("fog"), { note: "" })).toBe(bare);
  });

  it("sends the artist's own words when they have replaced the preset", () => {
    const prompt = transformPrompt("the same street, flooded to knee height");
    expect(prompt).toContain("flooded to knee height");
    expect(prompt).not.toContain("Fresh snow lies");
  });
});

describe("the depth slider", () => {
  it("defaults to seasonal, which is what a director means by make it winter", () => {
    expect(DEFAULT_DEPTH).toBe(50);
    expect(depthFor(DEFAULT_DEPTH).label).toBe("Seasonal");
    expect(transformPrompt("x")).toBe(transformPrompt("x", { depth: DEFAULT_DEPTH }));
  });

  it("moves through three named bands and clamps outside them", () => {
    expect(depthFor(0).label).toBe("Surface");
    expect(depthFor(33).label).toBe("Surface");
    expect(depthFor(34).label).toBe("Seasonal");
    expect(depthFor(66).label).toBe("Seasonal");
    expect(depthFor(67).label).toBe("Full");
    expect(depthFor(100).label).toBe("Full");
    expect(depthFor(-40).label).toBe("Surface");
    expect(depthFor(9999).label).toBe("Full");
  });

  it("changes how far the change reaches, never whether the plate holds", () => {
    const surface = transformPrompt(presetChange("winter"), { depth: 0 });
    const full = transformPrompt(presetChange("winter"), { depth: 100 });
    expect(surface).not.toBe(full);

    // The axis: silhouettes preserved at the bottom, wardrobe permitted at the
    // top. Identity is held at both, because that is where the risk lives.
    expect(surface).toContain("keeps the shape and silhouette");
    expect(full).toContain("what the people are wearing");
    expect(full).toContain("unmistakably the same individual");
  });
});

describe("the transformation key frame", () => {
  it("does not forbid the change it is being asked to make", () => {
    /*
     * The second cause, asserted directly. Restoration's key-frame prompt
     * insists every object stays "exactly what it is" with the light
     * "unchanged" — correct for a restoration and flatly incompatible with
     * "make it winter". A model handed both has to violate one, and which one
     * it picks varies run to run, which is what looked like randomness.
     */
    const restore = keyframePrompt("sharp and detailed");
    expect(restore).toContain("exactly what it is");
    expect(restore).toContain("direction of the light are unchanged");

    const transform = transformKeyframePrompt(presetChange("winter"));
    expect(transform).not.toContain("exactly what it is");
    expect(transform).not.toContain("direction of the light are unchanged");
  });

  it("holds the sun's position while letting the light's quality change", () => {
    /*
     * The distinction restoration never had to draw. Shadow *direction* is an
     * invariant because it is what makes a comp line up against the plate;
     * the colour, softness and strength of the light are part of the change.
     * Collapsing the two either freezes the season or unpins the shadows.
     */
    const prompt = transformKeyframePrompt(presetChange("golden"));
    expect(prompt).toContain("same part of the sky");
    expect(prompt).toContain("same direction");
    expect(prompt).toContain("low and warm");
  });

  it("pins this place rather than a place like it", () => {
    const prompt = transformKeyframePrompt(presetChange("winter"));
    expect(prompt).toContain("not a new photograph of a similar place");
    expect(prompt).toContain("Nothing enters the frame and nothing leaves it");
  });

  it("locks the framing, because a better photograph is a tighter one", () => {
    const prompt = transformKeyframePrompt(presetChange("summer")).toLowerCase();
    for (const wanted of [
      "identical field of view",
      "same proportion of the frame",
      "do not zoom in",
      "do not recompose",
    ]) {
      expect(prompt).toContain(wanted);
    }
  });

  it("demands deep focus, because a sharp lens means the opposite to an image model", () => {
    const prompt = transformKeyframePrompt(presetChange("winter")).toLowerCase();
    for (const wanted of ["deep depth of field", "no background blur", "no motion blur"]) {
      expect(prompt).toContain(wanted);
    }
  });
});
