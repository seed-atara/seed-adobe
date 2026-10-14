/**
 * The four regions of `gyg_SIDESpartycity2_left6` as gentle 10s idle loops.
 *
 *   npx tsx scripts/animate-partycity-state3.ts [--dry]
 *
 * These regions are not elements standing on a backdrop — they are opaque
 * rectangular windows of a painted wall, 100% alpha all four, so there is no
 * backing, no key and no unspill in this pipeline. The generated clip replaces
 * that rectangle directly. `backdrop: "none"` is the whole of it.
 *
 * Two things are being asked of the model and they pull against each other:
 * lanterns that flicker, and architecture that does not move at all. A flicker
 * is a brightness change, and the cheapest way for a model to brighten a lamp
 * is to redraw the lamp. So every region names its masonry as `rigid` — what
 * the still parts of the first frame are, positively — and every region is an
 * `idle`, which forbids anything growing, unfurling or changing outline.
 *
 * Ten seconds, not twelve: the comp is 30s and the clip has to tile it exactly.
 * 10 x 3 and 15 x 2 are the only durations that do, and 10s is the cheaper.
 */
import { animatePrompt } from "../packages/domain/src/animate.js";

const dry = process.argv.includes("--dry");
const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
const PROJECT =
  "ANUAL_SUMMIT_fourentitiesanimated_cycles_margin_sway_leftwind_tidy_chickens_street_tidy_v009.aep";

if (!dry && !token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

/**
 * Written from the plates, not from the brief.
 *
 * `describe` holds the design and says nothing about motion; `beats` say what
 * moves and nothing about what it looks like. Mixing them is how a plate comes
 * back restyled.
 */
const REGIONS = [
  {
    name: "SEED Region 5",
    assetId: "ast_6802cc25-5434-40bb-a792-f44096312cd9",
    size: [1724, 969] as const,
    describe:
      "A painted night scene of a Mexican colonial courtyard: two pale carved " +
      "stone arches on fluted columns, a row of small black wrought-iron " +
      "lanterns with warm amber flames mounted on the columns, a string of " +
      "cut-paper papel picado flags in magenta, blue, orange, yellow, green and " +
      "purple strung across the upper third with small warm bulbs on the same " +
      "wire, dark green climbing foliage on the stonework, and a deep blue " +
      "starry sky with cypress silhouettes behind. Soft painterly illustration, " +
      "warm amber key light against cool blue shadow",
    rigid: [
      "the carved stone arches",
      "the fluted columns",
      "the lantern housings and their ironwork",
      "the wire the flags hang from",
    ],
    beats: [
      {
        from: 0,
        to: 5,
        action:
          "the amber flames inside the lanterns breathe very slightly brighter " +
          "and dimmer at their own uneven rates, a soft glow pulse of a few " +
          "percent with no change to the lamp or its glass; the papel picado " +
          "flags lift and settle a few degrees on their wire; the climbing " +
          "foliage sways a leaf's width",
      },
      {
        from: 5,
        to: 10,
        action:
          "the same small breathing continues and comes back to exactly where " +
          "it started: flames at their opening brightness, every flag hanging " +
          "at its opening angle, the foliage back where it was",
      },
    ],
  },
  {
    name: "SEED Region 6",
    assetId: "ast_46b31cda-21da-4dbb-9f62-c0edcc169d37",
    size: [1390, 782] as const,
    describe:
      "A painted night view through a pale stone arch down a warm Mexican " +
      "hillside street: tiers of amber-lit terracotta and cream buildings " +
      "climbing a slope, dozens of small warm window lights and hanging " +
      "lanterns, canvas awnings slung across the street below, woven textiles " +
      "and blankets hanging on the left, dense magenta bougainvillea and dark " +
      "green shrubs on the right, potted plants at street level, deep blue " +
      "starry sky above. Soft painterly illustration, strong warm amber glow " +
      "against cool blue night",
    rigid: [
      "the stone arch framing the view",
      "the buildings and their walls",
      "the lantern housings",
      "the awning poles",
    ],
    beats: [
      {
        from: 0,
        to: 5,
        action:
          "the window lights and hanging lanterns breathe slightly brighter and " +
          "dimmer at their own uneven rates, a few percent each, no lamp " +
          "changing shape; the canvas awnings stir gently; the bougainvillea and " +
          "shrubs sway a leaf's width; the hanging textiles move very slightly",
      },
      {
        from: 5,
        to: 10,
        action:
          "the same small breathing continues and returns to exactly the opening " +
          "state: every light at its first-frame brightness, the awnings and " +
          "foliage back where they began",
      },
    ],
  },
  {
    name: "SEED Region 7",
    assetId: "ast_456498eb-bcdc-4030-ad9d-d80934c242e4",
    size: [2262, 1272] as const,
    describe:
      "A painted night elevation of a Mexican colonial facade: three pale " +
      "carved stone arches over a deep red-orange wall, tall wooden doors with " +
      "iron studs, small iron balconies with potted plants, black wrought-iron " +
      "lanterns with warm amber flames on the columns and walls, a string of " +
      "cut-paper papel picado flags in orange, purple, pink, teal and green " +
      "across the upper third with small warm bulbs on the wire, magenta " +
      "bougainvillea at the right, blue-painted column bases, deep blue starry " +
      "sky and cypress silhouettes behind. Soft painterly illustration, warm " +
      "amber key against cool blue shadow",
    rigid: [
      "the carved stone arches and columns",
      "the red wall",
      "the wooden doors",
      "the iron balconies",
      "the lantern housings and their ironwork",
    ],
    beats: [
      {
        from: 0,
        to: 5,
        action:
          "the amber flames in the lanterns breathe very slightly brighter and " +
          "dimmer at their own uneven rates, a few percent, with no change to " +
          "any lamp or its glass; the papel picado flags lift and settle a few " +
          "degrees on their wire; the bougainvillea and the balcony plants sway " +
          "a leaf's width",
      },
      {
        from: 5,
        to: 10,
        action:
          "the same small breathing continues and comes back to exactly the " +
          "opening state: flames at their first-frame brightness, every flag at " +
          "its opening angle, every plant back where it was",
      },
    ],
  },
  {
    name: "SEED Region 8",
    assetId: "ast_df6f9b55-2a6a-48c5-bf75-002f6b7c7a5d",
    size: [742, 417] as const,
    describe:
      "A painted, softly out-of-focus night detail of a pale stone arch and a " +
      "studded wooden door, with three small black wrought-iron lanterns " +
      "holding warm amber flames, a carved stone lintel, and a little dark " +
      "green foliage at the edges. Soft painterly illustration, shallow focus, " +
      "warm amber light pooling on cream stone",
    rigid: [
      "the stone arch and its lintel",
      "the wooden door",
      "the lantern housings and their ironwork",
    ],
    beats: [
      {
        from: 0,
        to: 5,
        action:
          "the three amber flames breathe very slightly brighter and dimmer at " +
          "their own uneven rates, a few percent each, with no change to any " +
          "lamp, and the warm pool of light on the stone shifts with them; the " +
          "small leaves at the edges stir a leaf's width",
      },
      {
        from: 5,
        to: 10,
        action:
          "the same small breathing continues and returns to exactly the opening " +
          "state, the flames back at their first-frame brightness and the stone " +
          "lit exactly as it was",
      },
    ],
    note: "the plate is genuinely soft — keep the shallow focus, do not sharpen it",
  },
] as const;

for (const region of REGIONS) {
  const prompt = animatePrompt({
    describe: region.describe,
    beats: [...region.beats],
    loop: true,
    // An opaque window of a painting. Nothing to stand on, nothing to key.
    backdrop: "none",
    idle: true,
    // These are lanterns; the standard tail would tell the model not to flicker.
    lights: true,
    rigid: [...region.rigid],
  });

  console.log(`\n=== ${region.name}  ${region.size[0]}x${region.size[1]} ===`);
  console.log(prompt);

  if (dry) continue;

  const response = await fetch(`${base}/v1/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "seedance-2-0",
      operation: "video.generate",
      prompt,
      size: "1080p",
      durationSeconds: 10,
      // The element's own shape, which is 16:9 for all four here.
      aspectRatio: "16:9",
      inputAssetIds: [region.assetId],
      // Same still in both frame slots, so the clip ends where it began. This
      // is what makes three passes tile 30s without a visible seam.
      inputRoles: ["loop"],
      project: PROJECT,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    console.error(`  FAILED ${response.status}: ${raw.slice(0, 400)}`);
    continue;
  }
  const started = JSON.parse(raw) as { job?: { id?: string }; id?: string };
  console.log(`  job ${started.job?.id ?? started.id ?? "(see payload)"}`);
}
