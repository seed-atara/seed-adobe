/**
 * Turning a wheel because the vehicle moved, not because time passed.
 *
 * A generated clip of a car has its wheels turning at whatever rate the
 * model chose, forever. Laid under a car the artist then drives with
 * Position keyframes, the wheels keep spinning while it sits at the
 * drive-thru window — which is the one thing everybody notices.
 *
 * The fix is not another generation. The clip already holds a turning
 * wheel; the only question is how fast to read it. Rotation is proportional
 * to distance travelled, so remapped time is the running total of distance,
 * scaled. Stopped car, zero distance, zero rotation, and the ramps in and
 * out of the stop come free because they are already in the artist's easing.
 */

export interface Sample {
  /** Seconds. */
  t: number;
  x: number;
  y: number;
}

export interface WheelSpinPlan {
  /** `[seconds, sourceSeconds]`, ready for the host's `setTimeRemap`. */
  keys: Array<[number, number]>;
  /** Pixels per second at which the clip reads at its natural rate. */
  referenceSpeed: number;
  /** Total distance the vehicle covered. */
  distance: number;
  /** Seconds of the source clip the plan actually uses. */
  sourceUsed: number;
  /**
   * How much the clip was slowed to fit the source. 1 means the wheels turn
   * at the rate they were generated at while the vehicle is at its typical
   * speed; below 1 means the journey was too long for the clip and the
   * wheels had to be slowed to avoid running off the end.
   */
  rate: number;
  /** Spans where the vehicle was stationary, for reporting. */
  stops: Array<{ fromSeconds: number; toSeconds: number }>;
}

export interface WheelSpinOptions {
  /** Length of the source clip. Remapped time never exceeds this. */
  sourceSeconds: number;
  /**
   * Below this many pixels per second the vehicle counts as stopped.
   * Guards against a keyframe interpolating by a hundredth of a pixel and
   * creeping the wheel round over thirty seconds.
   */
  stillSpeed?: number;
  /** Drop keys whose value is within this of the straight line through them. */
  tolerance?: number;
}

/** Straight-line distance between two samples. */
function step(a: Sample, b: Sample): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The speed at which the clip should read at its natural rate.
 *
 * The median of the moving samples, not the mean and not the maximum. A
 * vehicle that spends twenty seconds cruising and two seconds crawling away
 * from a stop should look right for the twenty: the mean is dragged down by
 * the crawl, and the maximum makes the whole shot look slow.
 */
export function referenceSpeed(speeds: number[], stillSpeed: number): number {
  const moving = speeds.filter((s) => s > stillSpeed).sort((a, b) => a - b);
  if (moving.length === 0) return 0;
  return moving[Math.floor(moving.length / 2)]!;
}

/**
 * Drops keyframes that lie on the straight line between their neighbours.
 *
 * Time remapping every frame of a thirty-second shot is 720 keyframes, and
 * the motion is mostly constant-speed runs where all but the two ends are
 * redundant. This leaves a property an artist can actually read, and the
 * curve is identical because every key is linear anyway.
 */
export function thinKeys(
  keys: Array<[number, number]>,
  tolerance: number,
): Array<[number, number]> {
  if (keys.length <= 2) return keys.slice();
  const out: Array<[number, number]> = [keys[0]!];
  for (let i = 1; i < keys.length - 1; i++) {
    const last = out[out.length - 1]!;
    const next = keys[i + 1]!;
    const span = next[0] - last[0];
    if (span <= 0) continue;
    const predicted = last[1] + ((keys[i]![0] - last[0]) / span) * (next[1] - last[1]);
    if (Math.abs(keys[i]![1] - predicted) > tolerance) out.push(keys[i]!);
  }
  out.push(keys[keys.length - 1]!);
  return out;
}

/**
 * Builds the time-remap keyframes for a vehicle's wheels.
 */
export function planWheelSpin(
  samples: Sample[],
  options: WheelSpinOptions,
): WheelSpinPlan {
  const stillSpeed = options.stillSpeed ?? 1;
  const tolerance = options.tolerance ?? 0.004;

  if (samples.length < 2) {
    return {
      keys: [[0, 0], [options.sourceSeconds, 0]],
      referenceSpeed: 0,
      distance: 0,
      sourceUsed: 0,
      rate: 1,
      stops: [],
    };
  }

  const speeds: number[] = [];
  const steps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.t - samples[i - 1]!.t;
    const d = step(samples[i - 1]!, samples[i]!);
    steps.push(d);
    speeds.push(dt > 0 ? d / dt : 0);
  }

  const reference = referenceSpeed(speeds, stillSpeed);
  const distance = steps.reduce((a, b) => a + b, 0);

  /*
   * Running total of distance, in seconds of source clip: a metre of road
   * per second of wheel at the reference speed. A stationary stretch adds
   * nothing, so the wheel holds.
   */
  const raw: number[] = [0];
  for (let i = 0; i < steps.length; i++) {
    const dt = samples[i + 1]!.t - samples[i]!.t;
    const speed = speeds[i]!;
    const moved = speed > stillSpeed ? steps[i]! : 0;
    raw.push(raw[raw.length - 1]! + (reference > 0 ? (moved / reference) : 0) * (dt > 0 ? 1 : 0));
  }

  /*
   * The clip is finite. If the journey would read past its end the whole
   * thing is slowed to fit, which keeps every relative speed correct and
   * only changes how fast the wheel turns overall — far better than running
   * out of clip and freezing mid-shot.
   */
  const wanted = raw[raw.length - 1]!;
  const rate = wanted > options.sourceSeconds ? options.sourceSeconds / wanted : 1;

  const keys: Array<[number, number]> = samples.map((s, i) => [
    Math.round(s.t * 1000) / 1000,
    Math.round(raw[i]! * rate * 1000) / 1000,
  ]);

  const stops: Array<{ fromSeconds: number; toSeconds: number }> = [];
  let open: number | null = null;
  for (let i = 0; i < speeds.length; i++) {
    const still = speeds[i]! <= stillSpeed;
    if (still && open === null) open = samples[i]!.t;
    if (!still && open !== null) {
      stops.push({ fromSeconds: open, toSeconds: samples[i]!.t });
      open = null;
    }
  }
  if (open !== null) {
    stops.push({ fromSeconds: open, toSeconds: samples[samples.length - 1]!.t });
  }

  return {
    keys: thinKeys(keys, tolerance),
    referenceSpeed: Math.round(reference * 100) / 100,
    distance: Math.round(distance * 10) / 10,
    sourceUsed: Math.round(wanted * rate * 1000) / 1000,
    rate: Math.round(rate * 1000) / 1000,
    stops,
  };
}
