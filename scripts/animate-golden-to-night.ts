/**
 * One 20s shot that takes the GYG set from golden hour to night.
 *
 *   npx tsx scripts/animate-golden-to-night.ts --day ast_a --night ast_b --dry
 *   npx tsx scripts/animate-golden-to-night.ts --day ast_a --night ast_b --size 720p
 *   npx tsx scripts/animate-golden-to-night.ts --surface right --day .. --night .. --draft
 *
 * ## Three surfaces, one shot
 *
 * The proscenium was first and the two side walls carry the same twenty
 * seconds. They are not the same picture and cannot share one prompt: the
 * proscenium frames the sun inside its central arch and the moon rises up
 * through the middle of it, while the sides are a long colonnade along the
 * coast with **no sun disc and no moon disc anywhere in the artwork** -- only
 * the light they cast. Asking a side for a moonrise would be asking it to draw
 * a moon the held artwork does not have, and the clip would then have to lose
 * it again before the join.
 *
 * So the surfaces differ in three places and agree everywhere else: what the
 * plate is, what the shot arrives at, and which beats carry the change. The
 * side night descriptions are the ones already written from those plates for
 * the night-to-party shot, reused verbatim -- the same artwork described twice
 * in two different ways is how a transition ends up somewhere between them.
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
const surfaceName = (flag("surface", "pros") || "pros").toLowerCase();
/*
 * Draft mode: 480p only, billed at the normal 480p rate, and about four times
 * faster. The returned task id converts to 1080p later without re-rolling the
 * shot. See docs/research/SEEDANCE_PREVIEW_MODE.md.
 */
const draft = argv.includes("--draft");
/*
 * `--from-draft <taskId>` renders the full-resolution version of that draft.
 *
 * Step 2: the same content as the approved draft rather than another roll of
 * the prompt. Seedance 2.5 only produces 1080p this way, and the draft id is
 * valid for seven days from the draft's created_at.
 */
const fromDraft = flag("from-draft");

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
const PROS_DESCRIBE =
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

const PROS_ARRIVE_AT =
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
const PROS_BEATS: Beat[] = [
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
const PROS_RIGID = [
  "the central arch, its gilded keystone and every side arch",
  "the stone piers, columns and the balustrade",
  "the two wrought-iron lanterns and their housings",
  "the planters and the line of the horizon",
];

/**
 * The side walls.
 *
 * `describe` is the golden-hour plate and `arriveAt` the night one, written to
 * name the *same* architecture in the same words so the only difference between
 * them is the light. The night half is lifted from `animate-night-to-party.ts`,
 * where it was written from these same plates at 100%, so the two shots that
 * meet on the night state describe that state identically.
 */
const sideBeats = (lights: string): Beat[] => [
  {
    from: 0,
    to: 2,
    action:
      "real time, the light exactly as it is in the first frame: the surf " +
      "breaks and the palm fronds stir at their own natural speed and nothing " +
      "else changes yet",
  },
  {
    from: 2,
    to: 7,
    action:
      "the time-lapse takes hold and the sun goes down behind the coast: the " +
      "sky runs from gold through orange into deep rose, the warm light across " +
      "the stonework slides lower and redder, the shadows stretch and then " +
      "soften away, and the surf goes on breaking at its own speed underneath " +
      "all of it",
  },
  {
    from: 7,
    to: 11,
    action:
      "dusk: the afterglow drains out of the horizon, the sky deepens from " +
      "rose through violet into deep blue, the first stars appear in the upper " +
      "sky, and the light on the colonnade cools from amber to blue",
  },
  {
    from: 11,
    to: 16,
    action:
      "the lanterns on the piers come up one by one into small warm pools, " +
      lights +
      ", and a narrow silver path of moonlight settles onto the dark sea " +
      "from off frame",
  },
  {
    from: 16,
    to: 18,
    action:
      "night settles: a deep blue sky of moonlit cloud with steady stars, the " +
      "stonework lit cool and even with the warm lantern pools holding steady",
  },
  {
    from: 18,
    to: 20,
    action:
      "real time again: the time-lapse has stopped and only the surf and the " +
      "palm fronds move, at their own natural speed under the settled night sky",
  },
];

const SIDE_RIGID = [
  "every arch of the colonnade and the columns they stand on",
  "the stone piers, the balustrade and the planters",
  "the wrought-iron lanterns and their housings",
  "the roof line and the line of the horizon",
];

interface Surface {
  describe: string;
  arriveAt: string;
  beats: Beat[];
  rigid: string[];
}

const SURFACES: Record<string, Surface> = {
  pros: {
    describe: PROS_DESCRIBE,
    arriveAt: PROS_ARRIVE_AT,
    beats: PROS_BEATS,
    rigid: PROS_RIGID,
  },
  left: {
    describe:
      "A wide painted golden-hour scene: a long colonnade of pale cream stone " +
      "arches on slender paired columns, a black wrought-iron lantern on each " +
      "pier, planters of monstera and fern running along the base, and through " +
      "the arches a rocky coast with surf breaking, a hillside town of pale " +
      "buildings among palms on the left, palm fronds overhanging, and a sky of " +
      "deep orange and gold cloud. Soft painterly illustration, warm amber key " +
      "light low from the side",
    arriveAt:
      "the identical colonnade at night -- the same arches on the same columns " +
      "in the same places at the same size -- a black wrought-iron lantern " +
      "burning on each pier, planters of monstera and fern running along the " +
      "base, and through the arches a moonlit rocky coast with surf breaking, a " +
      "dark hillside town of small lit windows on the left, palm fronds " +
      "overhanging, and a deep blue night sky of cloud and stars. Cool blue " +
      "moonlight with small warm pools at the lanterns",
    beats: sideBeats("the windows of the hillside town across the water light up warm"),
    rigid: SIDE_RIGID,
  },
  right: {
    describe:
      "A wide painted golden-hour scene: a long colonnade of pale cream stone " +
      "arches on paired columns, a black wrought-iron lantern on each pier, " +
      "planters of monstera and fern along the base, and through the arches a " +
      "rocky shore with surf and a sea arch in the rock, palm fronds " +
      "overhanging at both ends, and a sky of deep orange and gold cloud. Soft " +
      "painterly illustration, warm amber key light low from the side",
    arriveAt:
      "the identical colonnade at night -- the same arches on the same columns " +
      "in the same places at the same size -- a black wrought-iron lantern " +
      "burning on each pier, planters of monstera and fern along the base, and " +
      "through the arches a moonlit rocky shore with surf and a sea arch in the " +
      "rock, palm fronds overhanging at both ends, and a deep blue night sky of " +
      "cloud and stars. Cool blue moonlight with small warm pools at the lanterns",
    beats: sideBeats("the surf going on breaking pale against the dark rock"),
    rigid: SIDE_RIGID,
  },
};

const surface = SURFACES[surfaceName];
if (!surface) {
  throw new Error(
    `--surface ${surfaceName} is not one of ${Object.keys(SURFACES).join(", ")}`,
  );
}

const prompt = animatePrompt({
  describe: surface.describe,
  arriveAt: surface.arriveAt,
  beats: surface.beats,
  // Two different stills, so this is not a loop and must not close as one.
  loop: false,
  // An opaque full-frame plate: no backing, no key, no unspill in this path.
  backdrop: "none",
  timelapse: true,
  landOnLast: true,
  rigid: surface.rigid,
});

// ------------------------------------------------------------------ the price

/*
 * Draft mode is 480p only -- the API rejects any other resolution on a draft
 * -- so the flag decides the tier rather than sitting alongside it.
 */
const runTier = draft ? "480p" : fromDraft ? "1080p" : size;
const tokens = estimateTokens(runTier, duration) ?? 0;
const dollars = (tokens / 1_000_000) * USD_PER_MILLION_TOKENS;
const ramp = describeRamp({
  durationSeconds: duration,
  rampSeconds: 1.5,
  endSpeed: 0.2,
});

console.log(
  `=== ${duration}s golden hour -> night, ${surfaceName.toUpperCase()}, ` +
    `${runTier}${draft ? " draft" : ""}, ${aspect} ===\n`,
);
console.log(prompt);
console.log(`\n--- what this costs ---`);
for (const tier of ["480p", "720p", "1080p"]) {
  const t = estimateTokens(tier, duration) ?? 0;
  const d = (t / 1_000_000) * USD_PER_MILLION_TOKENS;
  console.log(
    `  ${tier.padEnd(6)} ${t.toLocaleString().padStart(11)} tokens  ` +
      `$${d.toFixed(2).padStart(6)}${tier === runTier ? "   <- this run" : ""}`,
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
    size: runTier,
    durationSeconds: duration,
    ...(draft ? { draft: true } : {}),
    ...(fromDraft ? { sourceTaskId: fromDraft } : {}),
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
