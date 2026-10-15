/**
 * A 10s night hold for the GYG proscenium: the sea moves, nothing else does.
 *
 *   npx tsx scripts/animate-night-loop.ts --night ast_... --dry
 *   npx tsx scripts/animate-night-loop.ts --night ast_... --size 1080p
 *
 * The third piece of the sequence: golden hour, then the 20s day-to-night
 * transition, then this on repeat. It is the opposite brief to the transition
 * in every way that matters, so almost none of that prompt carries over.
 *
 * - `loop` is back ON. Same still in both frame slots, which is what makes the
 *   clip end where it began and tile without a seen jump.
 * - `timelapse` is OFF. Nothing about the light changes; this is a held moment,
 *   not a passage of time, so `TIMELAPSE` and `LAND_ON_LAST` would both be
 *   describing a shot that is not being asked for.
 * - The standard `ANIMATE_TAIL` comes back, because nothing has to leave frame
 *   here and its "no stuttering or flickering" is wanted unqualified: the
 *   lanterns are lit in the plate and are meant to stay steady.
 *
 * ## Why `idle` is off even though the brief is "almost not moving"
 *
 * `IDLE` is the clause that makes nearly everything else on this project work,
 * and it is wrong here for one specific reason: it forbids anything changing
 * its shape, size, length or outline. That is exactly what water does. Region 9
 * of the party-city wall — a fountain — was the same problem and came back
 * right only once `idle` was turned off for it.
 *
 * What holds the shot still instead is `RIGID`, which is the stronger clause
 * anyway: it names what the still parts of the first frame ARE rather than
 * asking for less motion in general. Everything solid is named, so the sea is
 * the only thing left that can move. "Almost not moving" is then a property of
 * the beats, which ask for swell and foam and nothing else.
 *
 * ## Ten seconds, and where it sits
 *
 * The comp is 30s and the transition occupies 0-20s, so one pass of a 10s loop
 * fills 20-30s exactly. It can also tile indefinitely if the hold wants to be
 * longer than the comp, because a loop that closes on its own plate joins to
 * itself and to the transition's last frame, which is that same plate.
 */
import {
  animatePrompt,
  estimateTokens,
  type Beat,
} from "../packages/domain/src/index.js";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const flag = (name: string, fallback = ""): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};

const nightAsset = flag("night");
const size = flag("size", "1080p");
const duration = Number(flag("duration", "10"));
const aspect = flag("aspect", "21:9");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
const PROJECT =
  "ANUAL_SUMMIT_fourentitiesanimated_cycles_margin_sway_leftwind_tidy_chickens_street_tidy_v010.aep";

/** See the note in `animate-golden-to-night.ts`: an account setting, not a fact. */
const USD_PER_MILLION_TOKENS = 6.12;

/**
 * The night set, written from the plate.
 *
 * The same artwork the transition lands on, so the description is the
 * transition's `arriveAt` grown into a full `describe` — and it has to be,
 * because this clip's first frame and that clip's last frame are the same
 * image and any drift between the two prompts shows up at the 20s join.
 */
const DESCRIBE =
  "A wide painted night scene: a symmetrical arcade of pale cream carved stone " +
  "-- a tall central arch with a gilded fleur-de-lis keystone, flanked by two " +
  "large side arches with smaller stacked arches between them, standing on " +
  "square piers with a lit black wrought-iron lantern on the pier at each end " +
  "-- opening onto a tropical sea at night. A deep blue sky of moonlit cloud " +
  "with stars showing through, a narrow silver path lying on the dark water, " +
  "low surf breaking onto wet sand that reflects it. Coconut palms behind the " +
  "stonework on both sides, monstera and fern planters along the balustrade, a " +
  "vine on the inner left arch. Soft painterly illustration, cool blue " +
  "moonlight with warm amber pools at the two lanterns. Above the roof line " +
  "the top corners of the frame are flat black, which is the edge of the " +
  "artwork and stays flat black for the whole shot";

/**
 * Two beats, and the second one is the loop.
 *
 * The sea is the only subject, so there is nothing to spread across more
 * windows than this; what the ranges are really doing is giving the model
 * somewhere to turn the water around so that second ten closes on frame one.
 */
const BEATS: Beat[] = [
  {
    from: 0,
    to: 5,
    action:
      "only the sea moves, slowly and gently: low swells lift and pass, the " +
      "thin line of foam creeps a little way up the wet sand and slides back, " +
      "and the silver path on the water shivers and reforms as the surface " +
      "moves under it",
  },
  {
    from: 5,
    to: 10,
    action:
      "the same slow swell continues and settles back to exactly where it " +
      "started: the same foam line on the same sand, the same silver path, the " +
      "water surface as it was in the first frame",
  },
];

/**
 * Everything that is not the sea.
 *
 * This is doing the work `idle` would normally do, and doing it better: the sea
 * is the only thing not on this list, so it is the only thing with permission
 * to move. The clouds and stars are named deliberately — they would read as
 * natural drift, but the brief is "almost not moving" and a drifting sky over a
 * 10s loop has to return to its start, which is one more thing to get wrong.
 */
const RIGID = [
  "the central arch, its gilded keystone and every side arch",
  "the stone piers, columns and the balustrade",
  "the two lit lanterns, their housings and the pools of light they cast",
  "the palms, the planters, the ferns and the vine",
  "the clouds and the stars",
];

const prompt = animatePrompt({
  describe: DESCRIBE,
  beats: BEATS,
  // Same still in both frame slots. This is what tiles.
  loop: true,
  // An opaque full-frame plate: no backing, no key, no unspill.
  backdrop: "none",
  // Off on purpose: IDLE forbids anything changing shape, and that is water.
  idle: false,
  rigid: RIGID,
});

const tokens = estimateTokens(size, duration) ?? 0;
const dollars = (tokens / 1_000_000) * USD_PER_MILLION_TOKENS;

console.log(
  `=== ${duration}s night hold, water only, ${size}, ${aspect} ===\n`,
);
console.log(prompt);
console.log(`\n--- what this costs ---`);
for (const tier of ["480p", "720p", "1080p"]) {
  const t = estimateTokens(tier, duration) ?? 0;
  console.log(
    `  ${tier.padEnd(6)} ${t.toLocaleString().padStart(11)} tokens  ` +
      `$${((t / 1_000_000) * USD_PER_MILLION_TOKENS).toFixed(2).padStart(6)}` +
      `${tier === size ? "   <- this run" : ""}`,
  );
}
console.log(
  `  (at $${USD_PER_MILLION_TOKENS}/M, the rate recorded for this account)`,
);

if (dry) {
  console.log("\n--dry: nothing submitted.");
} else {
  if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");
  if (!nightAsset)
    throw new Error("pass --night <assetId> (the padded 21:9 night plate)");

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
      inputAssetIds: [nightAsset],
      // One still, both frame slots. The role the provider calls flf2v.
      inputRoles: ["loop"],
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
}
