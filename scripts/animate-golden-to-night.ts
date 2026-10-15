/**
 * One 20s shot that takes the GYG set from golden hour to night.
 *
 *   npx tsx scripts/animate-golden-to-night.ts --day ast_a --night ast_b --dry
 *   npx tsx scripts/animate-golden-to-night.ts --day ast_a --night ast_b --size 720p
 *
 * Everything else animated on this project is a loop: one still in both frame
 * slots, three passes tiling thirty seconds, every pass closing on the plate it
 * came from. This is the opposite job and almost none of that applies.
 *
 * - It runs between **two different stills**: `first_frame` is the golden-hour
 *   set as the artist left it on screen, `last_frame` is the same comp with
 *   `Night_layer` turned up. Verified against the provider, which refuses a
 *   last frame mixed with reference images, so this is exactly two images.
 * - It must **not** close on its first frame, so `loop` is off and the final
 *   beat carries no loop-close clause.
 * - `IDLE` -- the clause that makes nearly everything else on this project work
 *   -- is wrong here on three counts at once, so `timelapse` replaces it. See
 *   `TIMELAPSE` in `packages/domain/src/animate.ts`.
 * - The standard stability tail opens "Characters stay fully inside frame at
 *   constant scale", and this brief asks the moon to leave frame. `timelapse`
 *   swaps in `TRANSITION_TAIL`, which keeps every clause the tail is for
 *   without that contradiction.
 *
 * ## The speed ramp is not asked for here
 *
 * The brief wants a second or two of real time at each end with the hours
 * racing through the middle. That is a time remap, it is exact, it is free, and
 * it is adjustable after the clip exists -- so it is applied in After Effects
 * by `speedRampKeys`, not bought from the model. What the beats do ask for is
 * the *shape* of the pacing, because it costs nothing to ask and a model that
 * paces itself needs less remapping on top; `check-daynight-transition.ts`
 * prints the per-second pacing so the two can be reconciled with evidence.
 *
 * ## The one thing that cannot be fixed afterwards
 *
 * The last frame. The clip is spliced against artwork holding the night set, so
 * if the shot does not land on it there is a jump on the join, and no grade or
 * remap recovers that. `LAND_ON_LAST` is the prompt's side of it and the
 * `--first/--last` check is the measurement.
 */
import {
  animatePrompt,
  describeRamp,
  estimateTokens,
  type Beat,
} from "../packages/domain/src/index.js";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const flag = (name: string, fallback = ""): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};

const dayAsset = flag("day");
const nightAsset = flag("night");
const size = flag("size", "720p");
const duration = Number(flag("duration", "20"));
const aspect = flag("aspect", "21:9");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
const PROJECT =
  "ANUAL_SUMMIT_fourentitiesanimated_cycles_margin_sway_leftwind_tidy_chickens_street_tidy_v009.aep";

/**
 * What the account is actually charged per token.
 *
 * The token count is ours and measured across 150 jobs; this rate is an
 * account setting, so it is named as an assumption rather than presented as a
 * fact about the API. The dollar figures below are only as good as this line.
 */
const USD_PER_MILLION_TOKENS = 6.12;

/**
 * The artwork, and where the shot ends.
 *
 * `describe` holds the design and says nothing about motion; `arriveAt` says
 * what the second still is. Both are written from the plates rather than from
 * the brief -- a description written from the brief is how a plate comes back
 * restyled, because the model takes the prose as permission to draw rather than
 * as a reason not to.
 *
 * Written from the two captured plates at 100%, not from the brief.
 *
 * ## The black corners are artwork, and have to be said
 *
 * The comp is cut to a pentagon: above the roof line the top corners are
 * transparent, which flattens to black in the plate, and the night PSD has the
 * same corners painted flat black. On a projection that IS the shape of the
 * screen -- black is simply light not sent -- so a model that helpfully fills
 * those corners with sky would put picture outside the projection and the clip
 * would need a matte it does not otherwise need. Stated here as a fact about
 * what the artwork is, which is the framing that has worked on this project,
 * rather than as an instruction not to paint there.
 */
const DESCRIBE =
  "A wide painted golden-hour scene: a symmetrical arcade of pale cream carved " +
  "stone -- a tall central arch with a gilded fleur-de-lis keystone, flanked by " +
  "two large side arches with smaller stacked arches between them, standing on " +
  "square piers with a black wrought-iron lantern on the pier at each end -- " +
  "opening onto a tropical sea at sunset. The low sun sits in the centre of the " +
  "main arch just above the horizon and lays a broad gold path across breaking " +
  "waves onto wet sand. Coconut palms lean in behind the stonework on both " +
  "sides, monstera and fern planters run along the balustrade at the base, and " +
  "a vine climbs the inner left arch. Deep orange and gold cloud fills the sky. " +
  "Soft painterly illustration, warm amber key light. Above the roof line the " +
  "top corners of the frame are flat black, which is the edge of the artwork " +
  "and stays flat black for the whole shot";

const ARRIVE_AT =
  "the identical arcade at night -- the same cream stone in the same places at " +
  "the same size and the same flat black top corners -- lit cool from the side " +
  "by its two lanterns, under a deep blue sky of moonlit cloud with stars " +
  "showing through, a narrow silver path lying on the dark sea, and an empty " +
  "sky above the horizon";

/**
 * Six beats across twenty seconds.
 *
 * More than the three a ten-second loop uses, for the reason the module's own
 * notes give: a paragraph of action produces a shot that spends its whole
 * length on the first clause, and ranges are what spread it. Twenty seconds
 * carrying a sunset, a dusk, a moonrise and a settled night is four distinct
 * events, and each one needs its own window or the shot will do the sunset and
 * then sit there.
 *
 * The first and last beats ask for real time deliberately. They are the frames
 * that have to match the static artwork either side, and a beat that says
 * "nothing changes yet" is also the model's cue that the ramp belongs there.
 */
const BEATS: Beat[] = [
  {
    from: 0,
    to: 2,
    action:
      "real time, the light exactly as it is in the first frame: the sea rolls " +
      "and breaks at its own natural speed and the sun sits where it is",
  },
  {
    from: 2,
    to: 7,
    action:
      "the time-lapse takes hold and the sun sinks to the horizon and sets: " +
      "the sky runs from gold through orange into deep rose, the warm light " +
      "across the set slides lower and redder, the long shadows stretch and " +
      "then soften away, and the sea goes on rolling at its own speed " +
      "underneath all of it",
  },
  {
    from: 7,
    to: 11,
    action:
      "dusk: the afterglow drains out of the horizon, the sky deepens from " +
      "rose through violet into deep blue, the first stars appear in the upper " +
      "sky, and the light on the set cools from amber to blue",
  },
  {
    from: 11,
    to: 16,
    action:
      "a full moon rises from the horizon in the centre of frame and climbs " +
      "steadily up through the middle of the sky, laying a silver path across " +
      "the water, and passes out through the top edge of frame, leaving the " +
      "sky above the horizon clear",
  },
  {
    from: 16,
    to: 18,
    action:
      "night settles: a deep blue sky with steady stars, the set lit cool and " +
      "even, the silver path gone from the water with the moon",
  },
  {
    from: 18,
    to: 20,
    action:
      "real time again: the time-lapse has stopped and only the sea moves, " +
      "rolling and breaking at its own natural speed under the settled night sky",
  },
];

/**
 * The architecture, named positively.
 *
 * `RIGID` is the half of the idle brief that survives into a transition, and it
 * is the most expensive lesson on this project: an element asked to move where
 * the artwork has nothing drawn behind it comes back with the model inventing
 * that area every frame. Here it is also the registration between the clip and
 * the static set either side of it, so a column that breathes by two pixels is
 * a seam that runs for twenty seconds.
 */
const RIGID = [
  "the central arch, its gilded keystone and every side arch",
  "the stone piers, columns and the balustrade",
  "the two wrought-iron lanterns and their housings",
  "the planters and the line of the horizon",
];

const prompt = animatePrompt({
  describe: DESCRIBE,
  arriveAt: ARRIVE_AT,
  beats: BEATS,
  // Two different stills, so this is not a loop and must not close as one.
  loop: false,
  // An opaque full-frame plate: no backing, no key, no unspill in this path.
  backdrop: "none",
  timelapse: true,
  landOnLast: true,
  rigid: RIGID,
});

// ------------------------------------------------------------------ the price

const tokens = estimateTokens(size, duration) ?? 0;
const dollars = (tokens / 1_000_000) * USD_PER_MILLION_TOKENS;
const ramp = describeRamp({
  durationSeconds: duration,
  rampSeconds: 1.5,
  endSpeed: 0.2,
});

console.log(`=== ${duration}s golden hour -> night, ${size}, ${aspect} ===\n`);
console.log(prompt);
console.log(`\n--- what this costs ---`);
for (const tier of ["480p", "720p", "1080p"]) {
  const t = estimateTokens(tier, duration) ?? 0;
  const d = (t / 1_000_000) * USD_PER_MILLION_TOKENS;
  console.log(
    `  ${tier.padEnd(6)} ${t.toLocaleString().padStart(11)} tokens  ` +
      `$${d.toFixed(2).padStart(6)}${tier === size ? "   <- this run" : ""}`,
  );
}
console.log(
  `  (at $${USD_PER_MILLION_TOKENS}/M, the rate recorded for this account; ` +
    `Seedance 2.5 has no 4K tier)`,
);
console.log(
  `\n--- the ramp that goes on afterwards, in After Effects ---\n` +
    `  ${ramp.rampSeconds}s in and out at ${ramp.endSpeed}x, ` +
    `${ramp.peak}x through the middle, ${ramp.slowestRatio}:1 slowest to fastest.\n` +
    `  Both ends stay exact: source(0) = 0 and source(${duration}) = ${duration}.`,
);

if (dry) {
  console.log("\n--dry: nothing submitted.");
  process.exit(0);
}

if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");
if (!dayAsset || !nightAsset) {
  throw new Error(
    "pass --day <assetId> --night <assetId> (from capture-daynight-plates.ts)",
  );
}

const response = await fetch(`${base}/v1/generations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    providerId: "seedance-2-5",
    operation: "video.generate",
    prompt,
    size,
    durationSeconds: duration,
    aspectRatio: aspect,
    /*
     * Order matters and is positional: `inputRoles[i]` describes
     * `inputAssetIds[i]`. Day first, night last, which is also the order the
     * prompt names them in -- Seedance declares `requiresBindingText`, so the
     * roles and the prose have to agree or the second still reads as a
     * reference and the shot drifts towards it instead of ending on it.
     */
    inputAssetIds: [dayAsset, nightAsset],
    inputRoles: ["first", "last"],
    project: PROJECT,
  }),
});

const raw = await response.text();
if (!response.ok) {
  console.error(`\nFAILED ${response.status}: ${raw.slice(0, 600)}`);
  process.exit(1);
}
const started = JSON.parse(raw) as { job?: { id?: string }; id?: string };
console.log(
  `\nsubmitted: job ${started.job?.id ?? started.id ?? "(see payload)"}`,
);
console.log(
  `  ${tokens.toLocaleString()} tokens, about $${dollars.toFixed(2)}`,
);
