import { describe, expect, it } from "vitest";
import { planWheelSpin, referenceSpeed, thinKeys, type Sample } from "../src/wheelSpin.js";

/**
 * The GYG car, as the artist actually drove it.
 *
 * Measured from the real layer: twenty seconds of steady travel at 242 px/s,
 * a two-second stop at the drive-thru window, then away again. The wheels
 * were spinning through the stop, which is the whole reason this exists.
 */
function drive(): Sample[] {
  const out: Sample[] = [];
  const fps = 24;
  for (let f = 0; f <= 30 * fps; f++) {
    const t = f / fps;
    let x: number;
    if (t <= 20) x = -915 + 242 * t;
    else if (t <= 22) x = -915 + 242 * 20; // stopped at the window
    else x = -915 + 242 * 20 + 300 * (t - 22);
    out.push({ t, x, y: 1693.5 });
  }
  return out;
}

describe("a wheel that turns because the car moved", () => {
  it("holds the wheel still for exactly as long as the car is", () => {
    const plan = planWheelSpin(drive(), { sourceSeconds: 30 });

    expect(plan.stops).toHaveLength(1);
    expect(plan.stops[0]!.fromSeconds).toBeCloseTo(20, 1);
    expect(plan.stops[0]!.toSeconds).toBeCloseTo(22, 1);

    // And the remapped value does not advance across the stop, which is the
    // thing the viewer actually sees.
    const at = (t: number) => {
      const keys = plan.keys;
      for (let i = 1; i < keys.length; i++) {
        if (keys[i]![0] >= t) {
          const [t0, v0] = keys[i - 1]!;
          const [t1, v1] = keys[i]!;
          return t1 === t0 ? v0 : v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
        }
      }
      return keys[keys.length - 1]![1];
    };
    expect(Math.abs(at(21.5) - at(20.5))).toBeLessThan(0.02);
  });

  it("keeps the wheel turning while the car is", () => {
    const plan = planWheelSpin(drive(), { sourceSeconds: 30 });
    const first = plan.keys[0]![1];
    const last = plan.keys[plan.keys.length - 1]![1];
    expect(last).toBeGreaterThan(first);
    expect(last).toBeLessThanOrEqual(30);
  });

  it("does not care how far the car goes, only how long it moves", () => {
    /*
     * Scale-invariant, and that is the point: the reference speed is taken
     * from the car's own motion, so a car that covers eight times the
     * ground at eight times the speed still reads the clip at the same
     * rate. Distance in pixels is an arbitrary unit; what the wheel cares
     * about is how fast this car is going relative to itself.
     */
    const near = planWheelSpin(drive(), { sourceSeconds: 30 });
    const far = planWheelSpin(drive().map((s) => ({ ...s, x: s.x * 8 })), {
      sourceSeconds: 30,
    });

    expect(far.rate).toBeCloseTo(near.rate, 3);
    expect(far.sourceUsed).toBeCloseTo(near.sourceUsed, 2);
    expect(far.referenceSpeed).toBeCloseTo(near.referenceSpeed * 8, 0);
  });

  it("never reads past the end of the clip on a shot longer than it", () => {
    /*
     * The real overflow: time spent MOVING is what consumes the source, so
     * a sixty-second shot exhausts a thirty-second clip and the wheel would
     * freeze half way. Slowing the whole thing keeps every relative speed
     * right and only changes the overall rate.
     */
    const long: Sample[] = [];
    for (let f = 0; f <= 60 * 24; f++) long.push({ t: f / 24, x: 242 * (f / 24), y: 0 });
    const plan = planWheelSpin(long, { sourceSeconds: 30 });

    expect(plan.rate).toBeCloseTo(0.5, 1);
    expect(Math.max(...plan.keys.map((k) => k[1]))).toBeLessThanOrEqual(30.001);
  });

  it("ignores a creep of a hundredth of a pixel", () => {
    // An eased keyframe barely moving still moves. Without a floor the wheel
    // rotates slowly through what is meant to be a dead stop.
    const creeping: Sample[] = [];
    for (let f = 0; f <= 240; f++) creeping.push({ t: f / 24, x: 100 + f * 0.01, y: 0 });
    const plan = planWheelSpin(creeping, { sourceSeconds: 30 });
    expect(plan.stops).toHaveLength(1);
    expect(plan.keys[plan.keys.length - 1]![1]).toBe(0);
  });

  it("takes the median moving speed, not the mean or the maximum", () => {
    /*
     * Twenty seconds of cruising and two of crawling: the shot should look
     * right for the cruise. The mean is dragged down by the crawl and the
     * maximum makes everything look slow.
     */
    const speeds = [...Array(20).fill(242), ...Array(2).fill(10)];
    expect(referenceSpeed(speeds, 1)).toBe(242);
  });

  it("thins out the keys on a constant-speed run", () => {
    // 721 keyframes for a car that mostly drives in a straight line is not a
    // property anybody can read or edit.
    const plan = planWheelSpin(drive(), { sourceSeconds: 30 });
    expect(plan.keys.length).toBeLessThan(40);
    expect(plan.keys.length).toBeGreaterThan(3);
  });

  it("keeps both ends when thinning", () => {
    const keys: Array<[number, number]> = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const thinned = thinKeys(keys, 0.01);
    expect(thinned[0]).toEqual([0, 0]);
    expect(thinned[thinned.length - 1]).toEqual([3, 3]);
    expect(thinned).toHaveLength(2);
  });
});
