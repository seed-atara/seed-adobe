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
const size = flag("size", "480p");
const duration = Number(flag("duration", "10"));
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
 * Five beats, because this shot has four distinct events in ten seconds and a
 * paragraph of action would spend the whole length on the first clause.
 *
 * The first beat deliberately asks for nothing. It is the frame that has to
 * match the night hold it cuts from, and a beat that says "nothing changes
 * yet" is also where the model is told the change has not started.
 */
const BEATS: Beat[] = [
  {
    from: 0,
    to: 1.5,
    action:
      "the coastal night exactly as it is: only the sea moves, the two " +
      "lanterns on the piers burn steadily, and every other lamp is dark",
  },
  {
    from: 1.5,
    to: 4,
    action:
      "the first lamps strike, each at its own moment and none of them " +
      "cleanly: a string of small bulbs stutters two or three times before it " +
      "catches, a star-shaped paper lantern flutters and holds, a window " +
      "surges bright and settles back; they are scattered across the frame, " +
      "not in a line, and between them the picture is still night",
  },
  {
    from: 4,
    to: 7,
    action:
      "more lamps strike in clusters, and around each one that has caught, the " +
      "warm light soaks outwards into the picture with a ragged uneven edge " +
      "that creeps and branches rather than opening as a circle; inside that " +
      "light the painted walls, iron balconies, flowers and paper flags of the " +
      "square are what is there, while beyond its edge the blue night is " +
      "untouched",
  },
  {
    from: 7,
    to: 9,
    action:
      "the lit patches grow into one another and close the gaps between them, " +
      "the last pockets of blue night give way, and the lit hillside town and " +
      "its floodlit church tower come up beyond the arches",
  },
  {
    from: 9,
    to: 10,
    action:
      "every lamp has settled to a steady burn and the square is fully lit, " +
      "with only the paper flags stirring gently on their wires",
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
