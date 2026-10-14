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
 *
 * ## Why these asset ids are not the captures
 *
 * No R2 publisher is configured on this box, so `ArkAssetLibrary` cannot
 * register a reference and every image falls back to an inline base64 data
 * URI -- twice over, because `loop` puts the same still in both frame slots.
 * These plates are painterly night artwork at ~3.8 bytes per pixel, so R7's
 * capture is an 11 MB PNG, which is ~29 MB of JSON, which does not upload
 * inside the provider's 60s timeout. Three of the four died there with
 * "Seedance POST /contents/generations/tasks failed" and no HTTP status,
 * because the abort happens in transport and never reaches the API.
 *
 * The fix is not a longer timeout. A 1080p generation makes 1920x1080, so the
 * plate cannot inform more pixels than that: resized to 1920 on the long edge
 * and encoded q95 4:4:4, R7 goes 11 MB -> 0.68 MB for a mean error of
 * 0.72/255 (max 12), which is far less than the 4:2:0 H.264 the result comes
 * back in. `R{n}_plate.jpg`, adopted into the library.
 *
 * ## And why they are sent at exactly 1920x1080
 *
 * Of the first four clips, R7 was the only one whose plate was already the
 * generation's own size, and it was the only one that composited invisibly:
 * measured against the plate over the 24px feather band, its seam came back at
 * mean 2.33 / p99 14, against 17.63 / 135 for R5, 15.57 / 88 for R6 and
 * 7.60 / 67 for R8 — and R5's seam was worse at its edge than in its middle,
 * which is a patch however well it is feathered. The three bad ones are the
 * three the model had to resample (1.11x, 1.38x, 2.59x) to reach its own
 * working grid, and a first frame that had to be resampled is a first frame
 * that was re-interpreted rather than held. Upscaling the plate ourselves adds
 * no information, but it hands the model the grid it is going to work on.
 */
import { animatePrompt } from "../packages/domain/src/animate.js";

const dry = process.argv.includes("--dry");
/** `--only R5,R7` re-runs part of the set without respending on the rest. */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? "").split(",") : [];
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
    assetId: "ast_59ba0925-072f-4e40-861e-3cb6d125b614",
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
    assetId: "ast_1e324a75-3155-4093-a2e9-6b777cd306e5",
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
    assetId: "ast_26a8f7a7-1828-4861-916f-f9f2b3edf756",
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
    assetId: "ast_567b6741-81d9-4378-bb5a-55c8b3bd720e",
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
    /*
     * This plate is a deliberately out-of-focus corner of the wall, and the
     * first pass at it climbed to 193% of the plate's gradient energy by frame
     * 151 before settling back: soft, crisp, soft, in one loop. Against a wall
     * that stays soft around it, that is the patch pulling focus.
     */
    holdDetail: true,
  },
] as const;

for (const region of REGIONS) {
  if (only.length && !only.some((pick) => region.name.endsWith(pick.replace(/^R/, "")))) {
    continue;
  }
  const prompt = animatePrompt({
    describe: region.describe,
    beats: [...region.beats],
    loop: true,
    // An opaque window of a painting. Nothing to stand on, nothing to key.
    backdrop: "none",
    idle: true,
    // These are lanterns; the standard tail would tell the model not to flicker.
    lights: true,
    ...("holdDetail" in region && region.holdDetail ? { holdDetail: true } : {}),
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
