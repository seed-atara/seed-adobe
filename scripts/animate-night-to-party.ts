/**
 * Coastal night -> party-city square, carried by the light coming on.
 *
 *   npx tsx scripts/animate-night-to-party.ts --night ast_a --party ast_b --dry
 *   npx tsx scripts/animate-night-to-party.ts --night ast_a --party ast_b --size 480p
 *
 * The fourth state of the GYG show, and the first transition on this project
 * where the artwork genuinely changes rather than being re-lit.
 *
 * ## Why this one is a test and not a render
 *
 * The golden-hour-to-night shot worked because its two ends were one set under
 * two lights: measured across eight pure-stone patches at full resolution, the
 * architecture was in the same place in both plates to within a pixel once the
 * 20px plate offset was corrected. This is not that. The coastal arcade is
 * cream stone with a central fleur-de-lis keystone over a sea; the party square
 * is three heavy stone arches in painted ochre, teal and red walls with
 * balconies, paper flags and a lit colonial town beyond. Matched on their
 * gradient profiles they come back at **0.359 across and 0.336 down**, where
 * the working transition's own two ends scored 0.59-0.79.
 *
 * So there is no physical process connecting these two images, and asking a
 * model to interpolate between them is asking it to invent ten seconds of
 * architecture. That is a real risk of mush, which is why this runs at 480p for
 * $0.59 first: the question the test answers is "can it carry the change at
 * all", and that question does not need resolution to answer.
 *
 * ## What it is given instead of "morph"
 *
 * The director's own idea, which is a good one: the change is **led by the
 * light**. Only 3.2% of the party plate is lit — strings of small bulbs, star
 * lanterns, wall lamps, lit windows — and those are the seeds. Each kindles,
 * opens into a pool of warm light, and the new artwork appears only inside
 * those pools until they meet. That is a mechanism rather than an instruction,
 * and mechanisms are what these prompts have answered to.
 *
 * The same idea is also a straightforward luminance matte in After Effects,
 * grown from the party plate's own lit pixels, which costs nothing and is
 * exactly art-directable. If this test comes back soft, that is the fallback
 * and it is not a worse answer — it is a more controllable one.
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
const partyAsset = flag("party");
const size = flag("size", "720p");
const duration = Number(flag("duration", "15"));
const aspect = flag("aspect", "21:9");
/**
 * `frames` anchors the ends exactly; `references` can carry the light map.
 *
 * Not a preference — Seedance refuses to mix a last frame with reference
 * images ("first/last frame content cannot be mixed with reference media
 * content", from a real 400), so the false-colour guide and an exact closing
 * frame cannot both be had. The two modes are run against each other at 480p
 * rather than argued about.
 */
const mode = flag("mode", "frames");
const lightmapAsset = flag("lightmap");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
const PROJECT =
  "ANUAL_SUMMIT_fourentitiesanimated_cycles_margin_sway_leftwind_tidy_chickens_street_tidy_v010.aep";
const USD_PER_MILLION_TOKENS = 6.12;

/**
 * Image 1, written from the plate — and deliberately the same words the night
 * hold uses, because that clip's frames and this clip's first frame are the
 * same artwork and any drift between the two prompts shows at the join.
 */
const DESCRIBE =
  "A wide painted night scene: a symmetrical arcade of pale cream carved stone " +
  "-- a tall central arch with a gilded fleur-de-lis keystone, flanked by two " +
  "large side arches with smaller stacked arches between them, standing on " +
  "square piers with a lit black wrought-iron lantern on the pier at each end " +
  "-- opening onto a tropical sea at night under a deep blue sky of moonlit " +
  "cloud, a narrow silver path on the dark water and low surf on wet sand. " +
  "Coconut palms behind the stonework, monstera and fern planters along the " +
  "balustrade. Soft painterly illustration, cool blue moonlight with two small " +
  "warm amber pools at the lanterns. Above the roof line the top corners of " +
  "the frame are flat black, which is the edge of the artwork and stays flat " +
  "black for the whole shot";

/** Image 2, written from the party plate at 100%. */
const ARRIVE_AT =
  "a Mexican colonial party square at night, filling the same frame with the " +
  "same flat black top corners: three heavy carved stone arches on thick piers, " +
  "the walls between them painted ochre, teal and deep red with wrought-iron " +
  "balconies, carved doorways, pots of geraniums and climbing bougainvillea. " +
  "Strings of small warm bulbs and rows of star-shaped paper lanterns are hung " +
  "across the walls, papel picado flags in magenta, blue, orange, yellow and " +
  "green run between the arches, and beyond them a hillside town of lit " +
  "windows and domes rises to a floodlit pink gothic church tower under a " +
  "starry sky. Warm amber light everywhere";

/**
 * Six beats, choreographed to the art direction rather than to the mechanism.
 *
 * The brief is specific about shape: one bulb, a chain reaction, overlapping
 * waves that build, **a moment of restraint before the climax**, then a
 * synchronised cascade and a held hero frame. That shape is the whole thing
 * being bought, and it will not survive being left to a model's own pacing --
 * the two 480p tests both held the night for several seconds and then rushed
 * the reveal in three, which is the opposite of a build.
 *
 * So each movement gets its own window. The restraint beat is the one most
 * likely to be ignored and the one the brief leans on hardest, so it is stated
 * as something positive and visible -- the waves slowing, the lit light
 * steadying and gathering -- rather than as a gap where nothing happens.
 */
const BEATS: Beat[] = [
  {
    from: 0,
    to: 2,
    action:
      "the coastal night held exactly as it is -- only the sea moves and the " +
      "two pier lanterns burn -- and then, on the right-hand wall, one single " +
      "small festoon bulb flickers twice and catches, holding a steady warm " +
      "gold: one bulb only, a few inches of light in a dark frame",
  },
  {
    from: 2,
    to: 4.5,
    action:
      "the bulbs to either side of it take up the light one after another " +
      "along their wire, an even chain running outward at a walking pace, each " +
      "catching with one soft pulse and holding; where the chain has passed, " +
      "the wall behind it comes out of the dark in warm gold -- painted " +
      "plaster, an iron balcony, a pot of geraniums",
  },
  {
    from: 4.5,
    to: 8,
    action:
      "the chain reaches the next strings and they run in sequence across the " +
      "arches, several at once now and overlapping, waves of warm light " +
      "travelling outward and crossing one another; with each wave more of the " +
      "square is revealed -- carved doorways, climbing bougainvillea, rows of " +
      "paper flags in magenta, blue, orange and green -- and the lit area grows " +
      "faster than before, the scale of it increasing",
  },
  {
    from: 8,
    to: 10,
    action:
      "the spread holds back and gathers: the waves slow almost to a stop, only " +
      "two or three bulbs still catching at the far edges, a large part of the " +
      "frame still dark and waiting, and the light already burning steadies and " +
      "draws in very slightly",
  },
  {
    from: 10,
    to: 13,
    action:
      "then everything still unlit strikes at once in a single synchronised " +
      "cascade -- every remaining string, star lantern, wall lamp and window " +
      "coming up together in one sweep across the whole panorama -- and the " +
      "full colour of the square arrives with it: the hillside town of lit " +
      "windows and domes, the floodlit church tower, all of it at once",
  },
  {
    from: 13,
    to: 15,
    action:
      "the hero frame settles and holds: the square at full brightness and " +
      "exactly the artwork of Image 2, every wall, arch, balcony, lantern and " +
      "paper flag in its own place at its own size, a soft warm haze in the " +
      "air, the flags stirring gently, the night sky still dark above it",
  },
];

const references = mode === "references";

const prompt = animatePrompt({
  describe: DESCRIBE,
  arriveAt: ARRIVE_AT,
  // Reference mode names the images as references rather than promising them
  // as frames, which is a promise this request does not make in that mode.
  ...(references ? { asReferences: true } : {}),
  beats: BEATS,
  loop: false,
  backdrop: "none",
  /*
   * The subject is lamps striking, so the tail has to license the flicker it
   * would otherwise forbid. See TRANSITION_TAIL_LIGHTS.
   */
  lights: true,
  ...(references
    ? {
        guide:
          "it marks every light source in the party square as a magenta shape " +
          "on black, one for each bulb, lantern, wall lamp and lit window",
      }
    : {}),
  // NOT `timelapse`: that promises the picture is never re-drawn, and here it
  // must be. See `TRANSFORM` in packages/domain/src/animate.ts.
  transform: true,
  landOnLast: true,
});

const tokens = estimateTokens(size, duration) ?? 0;
const dollars = (tokens / 1_000_000) * USD_PER_MILLION_TOKENS;

console.log(
  `=== ${duration}s coastal night -> party square, ${size}, ${aspect} ===\n`,
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
console.log(
  `\nthe two plates match each other at 0.359 across / 0.336 down; the ` +
    `golden-hour\nshot's own ends matched at 0.59-0.79, so this is the ` +
    `uncertain one. That is what\nthe cheap tier is for.`,
);

if (dry) {
  console.log("\n--dry: nothing submitted.");
} else {
  if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");
  if (!nightAsset || !partyAsset)
    throw new Error("pass --night <assetId> --party <assetId>");

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
      inputAssetIds: references
        ? [nightAsset, partyAsset, lightmapAsset].filter(Boolean)
        : [nightAsset, partyAsset],
      inputRoles: references
        ? [nightAsset, partyAsset, lightmapAsset]
            .filter(Boolean)
            .map(() => "reference")
        : ["first", "last"],
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
