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
    {
      from: 2,
      to: 18,
      action: "the sun sets and the moon rises and leaves frame",
    },
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
    expect(prompt).toContain(
      "Image 1 as the first frame and Image 2 as the last frame",
    );
    expect(prompt).toContain("Image 2, which is where the shot ends");
  });

  it("puts what image 2 is before the beats", () => {
    const prompt = animatePrompt(TRANSITION);
    expect(prompt.indexOf("the same set at night")).toBeLessThan(
      prompt.indexOf("0-2s"),
    );
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
    const plain = animatePrompt({
      ...TRANSITION,
      timelapse: false,
      landOnLast: false,
    });
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

describe("a change between two different sets, led by the light", () => {
  /**
   * The GYG show's third transition: coastal night to party-city square.
   * Measured on their gradient profiles those two sets match at 0.36, where
   * the golden-hour-to-night shot's own two ends matched at 0.59-0.79. The
   * artwork genuinely changes here, which makes `timelapse` actively wrong.
   */
  const TRANSFORMING: AnimateRequest = {
    describe: "A painted coastal night arcade under moonlight",
    arriveAt: "a Mexican party-city square, every lamp and paper lantern lit",
    loop: false,
    backdrop: "none",
    transform: true,
    landOnLast: true,
    beats: [
      { from: 0, to: 10, action: "the lamps kindle and the light spreads" },
    ],
  };

  it("never claims the picture is not re-drawn", () => {
    /*
     * The whole reason this option exists. `TIMELAPSE.closing` ends "The
     * picture is re-lit, never re-drawn and never re-composed" -- right for a
     * sunset, a flat contradiction of this brief -- and reaching for the
     * nearest existing option is how a prompt forbids its own subject.
     */
    const prompt = animatePrompt(TRANSFORMING);
    expect(prompt).not.toContain("never re-drawn");
    expect(prompt).not.toContain(TIMELAPSE.closing);
  });

  it("gives the model a mechanism rather than an instruction to morph", () => {
    const prompt = animatePrompt(TRANSFORMING);
    expect(prompt).toContain(
      "carried by the light and happens only where the light reaches",
    );
    expect(prompt).toContain(
      "the artwork of the second image is what is revealed",
    );
    expect(prompt).toContain("still exactly as it was");
  });

  it("takes the transition tail, not the element one", () => {
    /*
     * ANIMATE_TAIL is wrong twice here: it pins everything inside frame at
     * constant scale, and it ends "no stuttering or flickering", which on a
     * shot whose subject is lights kindling reads as a ban on the subject.
     */
    const prompt = animatePrompt(TRANSFORMING);
    expect(prompt).toContain(TRANSITION_TAIL);
    expect(prompt).not.toContain(ANIMATE_TAIL);
    expect(prompt).not.toContain("no stuttering or flickering");
  });

  it("still lands on the last frame in motion", () => {
    expect(animatePrompt(TRANSFORMING)).toContain(LAND_ON_LAST.closing);
  });

  it("is off unless asked for", () => {
    const plain = animatePrompt({ ...TRANSFORMING, transform: false });
    expect(plain).not.toContain("carried by the light");
    expect(plain).toContain(ANIMATE_TAIL);
  });
});

describe("a transform whose subject is the lamps coming on", () => {
  const KINDLING: AnimateRequest = {
    describe: "A painted coastal night arcade under moonlight",
    arriveAt: "a Mexican party-city square, every lamp and paper lantern lit",
    loop: false,
    backdrop: "none",
    transform: true,
    lights: true,
    landOnLast: true,
    beats: [{ from: 0, to: 10, action: "the lamps flicker on and the light spreads" }],
  };

  it("does not forbid the flicker it is asking for", () => {
    /*
     * The expensive kind of contradiction, and the second time this exact
     * shape has come up on this project. TRANSITION_TAIL ends "no stuttering,
     * strobing, pulsing or jumping between frames" -- right for a sunset, a
     * flat ban on a shot whose subject is lamps striking.
     */
    const prompt = animatePrompt(KINDLING);
    expect(prompt).not.toContain("no stuttering, strobing, pulsing");
    expect(prompt).toContain("may flicker, stutter and surge as they strike");
  });

  it("keeps the stability guarantee it is for", () => {
    const prompt = animatePrompt(KINDLING);
    expect(prompt).toContain("no tearing, smearing or jumping between frames");
    expect(prompt).toContain("no change of lens, framing or scale");
  });

  it("does not claim nothing else changes brightness", () => {
    // ANIMATE_TAIL_LIGHTS ends that way, correctly, for a lamp on a static
    // wall. Here the whole second plate arrives on the light these lamps cast.
    const prompt = animatePrompt(KINDLING);
    expect(prompt).not.toContain("nothing else in the artwork changes brightness");
  });

  it("falls back to the plain transition tail without lights", () => {
    const prompt = animatePrompt({ ...KINDLING, lights: false });
    expect(prompt).toContain(TRANSITION_TAIL);
    expect(prompt).not.toContain("may flicker, stutter and surge");
  });
});

describe("the false-colour guide image", () => {
  const GUIDED: AnimateRequest = {
    describe: "A painted coastal night arcade under moonlight",
    loop: false,
    backdrop: "none",
    transform: true,
    lights: true,
    guide: "every light source in the party square marked in magenta on black",
    beats: [{ from: 0, to: 10, action: "the lamps flicker on" }],
  };

  it("names it as a diagram and says what to read it for", () => {
    const prompt = animatePrompt(GUIDED);
    expect(prompt).toContain("Image 3 is a diagram and not a scene");
    expect(prompt).toContain("Read it only to know which parts of the picture are light sources");
  });

  it("names no defect, so it does not ask for magenta by forbidding it", () => {
    const prompt = animatePrompt(GUIDED);
    expect(prompt).not.toMatch(/do not (paint|draw|render)/i);
  });

  it("is absent unless given", () => {
    expect(animatePrompt({ ...GUIDED, guide: undefined })).not.toContain("Image 3");
  });
});
