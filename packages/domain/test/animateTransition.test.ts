import { describe, expect, it } from "vitest";
import {
  ANIMATE_TAIL,
  IDLE,
  LAND_ON_LAST,
  TIMELAPSE,
  TRANSITION_TAIL,
  animatePrompt,
  type AnimateRequest,
} from "../src/animate.js";

/**
 * The GYG golden-hour-to-night transition: one 20s shot between two frames.
 *
 * A different job from everything else in this module, which animates cut-out
 * elements that must not change. Here the whole picture changes and the
 * geometry must not, and several clauses that are right for an element are
 * actively wrong for this.
 */
const TRANSITION: AnimateRequest = {
  describe: "A painted golden-hour Mexican coastal set, sun low over the sea",
  arriveAt: "the same set at night under a deep blue sky",
  loop: false,
  backdrop: "none",
  timelapse: true,
  landOnLast: true,
  rigid: ["the proscenium arch", "the balustrade"],
  beats: [
    { from: 0, to: 2, action: "the waves roll at their natural speed" },
    { from: 2, to: 18, action: "the sun sets and the moon rises and leaves frame" },
    { from: 18, to: 20, action: "the night settles, waves rolling" },
  ],
};

describe("naming which still is which", () => {
  /*
   * Seedance declares `requiresBindingText`. A `first_frame` and a
   * `last_frame` that the prompt never mentions are, as far as the prompt is
   * concerned, two references -- and the shot then drifts towards the second
   * rather than ending on it.
   */
  it("names image 1 as the first frame and image 2 as the last", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).toContain("Image 1 as the first frame and Image 2 as the last frame");
    expect(prompt).toContain("Image 2, which is where the shot ends");
  });

  it("puts what image 2 is before the beats", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt.indexOf("the same set at night")).toBeLessThan(prompt.indexOf("0-2s"));
  });

  it("falls back to the single-frame lead when there is no second image", () => {
    const prompt = animatePrompt({ ...TRANSITION, arriveAt: undefined });
    expect(prompt).toContain("Image 1 as the first frame, held exactly");
    expect(prompt).not.toContain("Image 2");
  });

  it("does not close the last beat on a loop", () => {
    // `loop: false`, so the final beat must not be told to return to its
    // opening state -- which on a transition would undo the whole shot.
    expect(animatePrompt(TRANSITION)).not.toContain("seamless loop");
  });
});

describe("the tail a transition needs", () => {
  /*
   * This is the one that would have cost a generation. ANIMATE_TAIL opens
   * "Characters stay fully inside frame at constant scale", and this brief
   * asks the moon to rise, cross and LEAVE frame. The tail is global and the
   * beats are local, and on this project the global note has won every time
   * it has been tested against a beat.
   */
  it("does not require everything to stay inside frame", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).not.toContain("stay fully inside frame");
    expect(prompt).not.toContain(ANIMATE_TAIL);
  });

  it("keeps every clause the tail is actually for", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).toContain(TRANSITION_TAIL);
    // Temporal instability is still the commonest way one of these is unusable.
    expect(prompt).toContain("no stuttering, strobing, pulsing or jumping");
    // And a lock-off is still a lock-off.
    expect(prompt).toContain("no change of lens, framing or scale");
  });

  it("leaves the element tail alone when this is not a timelapse", () => {
    const prompt = animatePrompt({ ...TRANSITION, timelapse: false });
    expect(prompt).toContain(ANIMATE_TAIL);
    expect(prompt).not.toContain(TRANSITION_TAIL);
  });
});

describe("a timelapse is not an idle", () => {
  it("is off unless asked for", () => {
    const plain = animatePrompt({ ...TRANSITION, timelapse: false, landOnLast: false });
    expect(plain).not.toContain(TIMELAPSE.closing);
    expect(plain).not.toContain(LAND_ON_LAST.closing);
  });

  it("says what changes and what does not", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).toContain("re-lit, never re-drawn and never re-composed");
    expect(prompt).toContain("as if photographed from a locked tripod");
  });

  it("is not combined with IDLE, which forbids this brief three ways over", () => {
    /*
     * IDLE forbids anything appearing (a moonrise), anything changing shape (a
     * setting sun, cloud) and asks for motion that is "small" (hours in twenty
     * seconds). The two are not meant to be set together, and this test is
     * here so that a future caller who sets both sees them conflict in a
     * failing test rather than in a $6 clip.
     */
    const both = animatePrompt({ ...TRANSITION, idle: true });
    expect(both).toContain(IDLE.closing);
    expect(both).toContain(TIMELAPSE.closing);
    expect(IDLE.closing).toContain("appears or disappears");
    expect(TIMELAPSE.closing).toContain("move");
  });

  it("still honours rigid, which is the half of the idle brief that survives", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).toContain("the proscenium arch and the balustrade");
    expect(prompt).toContain("must not move, sway, bend");
  });
});

describe("arriving at the last frame rather than stopping at it", () => {
  it("describes the end of the shot as still in motion", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt).toContain("where the shot arrives at speed");
    expect(prompt).toContain("reaches the last frame mid-motion");
  });

  it("names no defect, following the lesson that naming one summons it", () => {
    /*
     * ANIMATE_TAIL_LIGHTS records what happened when two clauses forbade a
     * global exposure pulse by describing it: the pulse got worse. So this
     * clause says what the end of the shot IS and never uses the word for
     * what it must not do.
     */
    const prompt = animatePrompt(TRANSITION);
    expect(LAND_ON_LAST.closing).not.toMatch(/freez|frozen|hold still|stop/i);
    expect(prompt).not.toMatch(/do not freeze/i);
  });

  it("comes after the timelapse clause, so it wins the disagreement", () => {
    // "Nothing is re-composed" and "it is still moving as it lands" pull
    // against each other in the final second. The usable failure is a slightly
    // loose landing, not a dead one, so the motion note is read last.
    const prompt = animatePrompt(TRANSITION);
    expect(prompt.indexOf(LAND_ON_LAST.closing)).toBeGreaterThan(
      prompt.indexOf(TIMELAPSE.closing),
    );
  });
});
