import { describe, expect, it } from "vitest";
import {
  describeRamp,
  peakSpeed,
  sourceAt,
  speedRampKeys,
  type SpeedRampRequest,
} from "../src/speedRamp.js";

/** The GYG golden-hour-to-night transition: 20 seconds, 1.5s ramps. */
const GYG: SpeedRampRequest = { durationSeconds: 20, rampSeconds: 1.5, endSpeed: 0.2 };

describe("the endpoints, which are the entire requirement", () => {
  /*
   * The clip's first frame is the golden-hour set and its last is the night
   * set, and the artwork on either side of the transition is holding exactly
   * those frames. A remap that lands even one frame short puts a jump on a
   * join, so this is pinned rather than trusted to the curve.
   */
  it("starts on the source's first frame", () => {
    expect(sourceAt(0, GYG)).toBe(0);
  });

  it("ends on the source's last frame, exactly", () => {
    expect(sourceAt(20, GYG)).toBe(20);
  });

  it("emits keys whose first and last pairs are identities", () => {
    const keys = speedRampKeys(GYG);
    expect(keys[0]).toEqual([0, 0]);
    expect(keys[keys.length - 1]).toEqual([20, 20]);
  });

  it("holds the endpoints for any ramp length and end speed", () => {
    for (const rampSeconds of [0.5, 1, 1.5, 3, 10]) {
      for (const endSpeed of [0.05, 0.2, 0.5, 0.9]) {
        const request = { durationSeconds: 20, rampSeconds, endSpeed };
        expect(sourceAt(20, request)).toBeCloseTo(20, 9);
        expect(sourceAt(0, request)).toBe(0);
      }
    }
  });
});

describe("the ramp is a ramp", () => {
  it("runs slow at the ends and fast in the middle", () => {
    const speed = (t: number): number => (sourceAt(t + 0.01, GYG) - sourceAt(t, GYG)) / 0.01;
    expect(speed(0)).toBeCloseTo(0.2, 1);
    expect(speed(10)).toBeGreaterThan(1);
    expect(speed(19.98)).toBeLessThan(0.3);
  });

  it("derives a peak that pays for the slow ends", () => {
    // Not chosen: the middle must run fast enough to still consume 20s of
    // source in 20s of comp time once the ends have been slowed down.
    expect(peakSpeed(20, 1.5, 0.2)).toBeCloseTo(19.7 / 18.5, 9);
    expect(describeRamp(GYG).peak).toBe(1.065);
  });

  it("reports the ratio the eye actually reads", () => {
    expect(describeRamp(GYG).slowestRatio).toBeCloseTo(5.32, 1);
  });

  it("never runs backwards", () => {
    // A non-monotonic remap plays the sunset in reverse somewhere, which is
    // the one failure that would be obvious on screen and silent in a diff.
    const keys = speedRampKeys(GYG);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]![0]).toBeGreaterThan(keys[i - 1]![0]);
      expect(keys[i]![1]).toBeGreaterThanOrEqual(keys[i - 1]![1]);
    }
  });

  it("never asks for a frame outside the clip", () => {
    for (const [at, source] of speedRampKeys(GYG)) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(20);
      expect(source).toBeGreaterThanOrEqual(0);
      expect(source).toBeLessThanOrEqual(20);
    }
  });

  it("keeps moving at the last frame", () => {
    /*
     * The brief for the final second is "natural wave movement only", so the
     * ramp may slow the shot down but must not hold a frame. endSpeed is a
     * fraction, never zero, and this is what says so.
     */
    const lastStep = sourceAt(20, GYG) - sourceAt(20 - 1 / 24, GYG);
    expect(lastStep).toBeGreaterThan(0);
  });
});

describe("the keys are shaped for an artist to read", () => {
  it("samples the ramps densely and the middle not at all", () => {
    const keys = speedRampKeys({ ...GYG, samplesPerRamp: 8 });
    const middle = keys.filter(([at]) => at > 1.5 && at < 18.5);
    expect(middle).toHaveLength(0);
    // Both ramps sampled, plus the shared boundary keys at 1.5s and 18.5s.
    expect(keys.length).toBe(8 + 1 + 8 + 1);
  });

  it("holds the curve to within a frame of linear interpolation", () => {
    /*
     * After Effects only interpolates linearly between these keys, so the
     * sampling has to be fine enough that the chords are the curve. Checked
     * against the analytic value at the midpoint of every segment, where a
     * chord is furthest from the arc it replaces.
     */
    const keys = speedRampKeys(GYG);
    for (let i = 1; i < keys.length; i++) {
      const [t0, s0] = keys[i - 1]!;
      const [t1, s1] = keys[i]!;
      const mid = (t0 + t1) / 2;
      const chord = (s0 + s1) / 2;
      expect(Math.abs(chord - sourceAt(mid, GYG))).toBeLessThan(1 / 24);
    }
  });

  it("collapses to an identity when there is no ramp", () => {
    expect(speedRampKeys({ durationSeconds: 20, rampSeconds: 0 })).toEqual([
      [0, 0],
      [20, 20],
    ]);
  });

  it("survives a ramp as long as half the clip", () => {
    const keys = speedRampKeys({ durationSeconds: 20, rampSeconds: 10, endSpeed: 0.2 });
    expect(keys[0]).toEqual([0, 0]);
    expect(keys[keys.length - 1]).toEqual([20, 20]);
    // No duplicated time at the join, where the two ramps meet at t = T/2.
    const times = keys.map(([at]) => at);
    expect(new Set(times).size).toBe(times.length);
  });

  it("refuses a duration that is not a duration", () => {
    expect(() => speedRampKeys({ durationSeconds: 0 })).toThrow(/positive duration/);
  });
});
