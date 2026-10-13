/**
 * The five clips of the golden-hour proscenium (STATE2).
 *
 *   npx tsx scripts/animate-pros-state2.ts            prints the plan and the bill
 *   npx tsx scripts/animate-pros-state2.ts --submit    sends them
 *   npx tsx scripts/animate-pros-state2.ts --submit --only bg
 *
 * `gyg_gh_pros_pano_3` is two flat PSD layers: `FG_Object`, the stone
 * proscenium with its planters and lanterns, and `BG_waves_Sunset`, a single
 * connected sunset over the sea. That split is the whole plan.
 *
 * **Four regions carry the foreground.** Johannes framed them — two squares on
 * the bottom corners where a lantern sits over a planter, two 9:16 portraits
 * on the inner columns where a monstera vine climbs. Each is generated from an
 * opaque crop of the assembled plate, so the model can see what is drawn
 * behind every leaf, and is then clamped back to `FG_Object`'s own alpha. The
 * clamp is what makes "nothing else in the FG moves" true: outside the
 * foreground's silhouette the region contributes nothing and the background
 * clip shows through, so a region never freezes a rectangle of sea.
 *
 * **One clip carries the background.** It cannot be split: the sky band alone
 * is 5.55:1 and the water band 3.23:1, both past the 21:9 ceiling where
 * `adaptive` crops into the middle of a plate instead of fitting it. The whole
 * visible window is 2.04:1, which fits, so it goes in one piece — and the
 * palms cannot be held out of it either, measured: they share the sea's own
 * luminance range and overlap it spatially.
 *
 * Tier and length were Johannes's call, priced per option before anything was
 * sent: 1080p for the regions (~1.0-1.26x, no downscale headroom) and a 10s
 * loop at 4K for the background, run three times across the 30s comp.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { animatePrompt, estimateTokens, type Beat } from "../packages/domain/src/animate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const submit = process.argv.includes("--submit");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;

/* Measured from the SEEDANCE_2_0 research: ~$3 for a 10s 1080p clip. */
const DOLLARS_PER_TOKEN = 3 / 488_000;

/**
 * The wind, stated once and reused.
 *
 * Five clips of one frame have to agree about it or the proscenium reads as
 * five unrelated plates. Drifting left, which is the direction STATE1's left
 * wall was built to.
 */
const WIND = "a soft steady offshore breeze drifting to the left";

interface Shot {
  key: string;
  label: string;
  assetId: string;
  /** Pixels in the comp, for the oversample report. */
  screen: [number, number];
  size: string;
  aspectRatio: string;
  durationSeconds: number;
  describe: string;
  rigid: string[];
  /**
   * An idle rather than a performance. On by default.
   *
   * Off for the sea, and that is not a preference. `IDLE` forbids anything
   * unfurling or changing its shape, size or outline — which is exactly what a
   * breaking wave does. Asking for both gets a prompt that argues with itself,
   * so the water is held even-paced by its beats and by `rigid` instead.
   */
  idle?: boolean;
  beats: Beat[];
}

const SHOTS: Shot[] = [
  {
    key: "r1",
    label: "SEED Region 1 — bottom-left planter and lantern",
    assetId: "ast_ca664f8b-05c9-4b3a-a751-f8bfb1b76277",
    screen: [1141, 1141],
    size: "1080p",
    aspectRatio: "1:1",
    durationSeconds: 10,
    describe:
      "A painted golden-hour scene: a cream marble column and arch on the left " +
      "with a black wrought-iron lantern mounted on it, its glass lit by a small " +
      "warm flame, and a raised marble planter below holding a dense bank of " +
      "ferns, split-leaf philodendron and crotons, rim-lit gold by a low sun " +
      "over the sea behind",
    rigid: [
      "the marble column",
      "the arch",
      "the planter wall",
      "the lantern's iron frame and glass panes",
      "the sea, the sky and the palms behind",
    ],
    beats: [
      {
        from: 0,
        to: 3.5,
        action:
          "the fern fronds and philodendron leaves drift slowly, each " +
          "rocking a little on its own stem at its own speed, the " +
          "thinnest tips travelling furthest; the flame in the lantern " +
          "wavers very slightly",
      },
      {
        from: 3.5,
        to: 7,
        action:
          "the drift carries on and eases the other way, one or two " +
          "leaves turning a fraction to catch the light; the flame keeps " +
          "its small steady waver",
      },
      {
        from: 7,
        to: 10,
        action:
          "the drift brings every leaf back to exactly its opening " +
          "position and the flame to its opening height",
      },
    ],
  },
  {
    key: "r2",
    label: "SEED Region 2 — bottom-right planter and lantern",
    assetId: "ast_9e8435b3-7b3b-43ee-8fb8-57c2119cfdc9",
    screen: [1191, 1191],
    size: "1080p",
    aspectRatio: "1:1",
    durationSeconds: 10,
    describe:
      "A painted golden-hour scene: a cream marble column and arch on the right " +
      "carrying a black wrought-iron lantern with a small warm flame behind its " +
      "glass, and a raised marble planter below holding a tall spiky rosette of " +
      "banana-like leaves over a low clipped hedge, all rim-lit gold by a low " +
      "sun over the sea behind",
    rigid: [
      "the marble column",
      "the arch",
      "the planter wall",
      "the lantern's iron frame and glass panes",
      "the sea, the sky, the distant headland and the palms behind",
    ],
    beats: [
      {
        from: 0,
        to: 3.5,
        action:
          "the tall spiky leaves drift slowly, each swaying a little at " +
          "its own speed with the tips travelling furthest, and the hedge " +
          "surface stirs faintly; the flame in the lantern wavers very " +
          "slightly",
      },
      {
        from: 3.5,
        to: 7,
        action:
          "the drift carries on and eases the other way, the rosette " +
          "breathing open and closed by a hair; the flame keeps its small " +
          "steady waver",
      },
      {
        from: 7,
        to: 10,
        action:
          "the drift brings every leaf back to exactly its opening " +
          "position and the flame to its opening height",
      },
    ],
  },
  {
    key: "r3",
    label: "SEED Region 3 — monstera vine, left inner column",
    assetId: "ast_0f36e5f8-b106-4aee-bc37-37d9b46087d4",
    screen: [1024, 1820],
    size: "1080p",
    aspectRatio: "9:16",
    durationSeconds: 10,
    describe:
      "A painted golden-hour scene: a tall cream marble column carrying three " +
      "nested arches, with a split-leaf monstera vine climbing it from a marble " +
      "planter at its foot — large glossy slotted leaves at intervals up the " +
      "shaft and finer trailing creeper between them, every leaf edged in gold " +
      "by a low sun over the sea behind",
    rigid: [
      "the marble column",
      "all three stone arches",
      "the planter box",
      "the sea, the sky and the clouds behind",
    ],
    beats: [
      {
        from: 0,
        to: 3.5,
        action:
          "the monstera leaves drift slowly, each tilting a little on its " +
          "own stem at its own speed, the trailing creeper swinging " +
          "faintly at its loose ends",
      },
      {
        from: 3.5,
        to: 7,
        action:
          "the drift carries on and eases the other way, the same leaves " +
          "rocking back through centre",
      },
      {
        from: 7,
        to: 10,
        action:
          "the drift brings every leaf and tendril back to exactly where " +
          "it began",
      },
    ],
  },
  {
    key: "r4",
    label: "SEED Region 4 — ivy at the right inner column",
    assetId: "ast_d96bb7de-d188-42d8-8a76-4644c7d3fd2f",
    screen: [1046, 1860],
    size: "1080p",
    aspectRatio: "9:16",
    durationSeconds: 10,
    describe:
      "A painted golden-hour scene: a pair of tall cream marble columns carrying " +
      "nested stone arches, open sea and sunset sky visible through the openings, " +
      "with dense dark-green ivy and a low clipped hedge banked around the " +
      "columns' feet in a marble planter, rim-lit gold by a low sun",
    rigid: [
      "both marble columns",
      "every stone arch and moulding",
      "the planter wall",
      "the sea, the sky and the clouds seen through the arches",
    ],
    beats: [
      {
        from: 0,
        to: 3.5,
        action:
          "the ivy leaves stir slowly against the stone and the hedge " +
          "surface shifts faintly, the loose trailing shoots moving " +
          "furthest",
      },
      {
        from: 3.5,
        to: 7,
        action:
          "the stirring carries on and eases the other way, the same " +
          "leaves settling back against the columns",
      },
      {
        from: 7,
        to: 10,
        action:
          "the stirring brings every leaf and shoot back to exactly where " +
          "it began",
      },
    ],
  },
  {
    key: "bg",
    label: "BG_waves_Sunset — the whole visible window",
    assetId: "ast_a281ad24-5d1c-47b7-a2de-de216e991645",
    screen: [5750, 3234],
    size: "4K",
    /*
     * 16:9 explicitly, and the plate is cut to exactly 16:9 to match it.
     *
     * The visible window is 5750x2818 = 2.04:1, which is inside the supported
     * range — and that is not enough. Sent at `adaptive`, Ark picked the
     * nearest *named* aspect, 16:9, and centre-cropped 370px off each side.
     * Measured: correlation 0.92 against a centre 5010px crop, 0.71 against a
     * squeeze. Being inside 21:9..9:21 only means `adaptive` will not reach for
     * a wildly wrong shape; it still crops to the nearest listed one.
     *
     * So the plate carries 208px of real artwork above and below the window —
     * there is plenty, the BG layer is 16080x5721 and only 5750x2818 of it is
     * used — making it a true 16:9 that nothing needs to crop. `fit: "cover"`
     * scales the result back by 1.4974x and the padding falls outside the comp.
     */
    aspectRatio: "16:9",
    durationSeconds: 10,
    describe:
      "A painted tropical sunset: a low sun sitting just above a flat ocean " +
      "horizon with a bright glitter column running from it down the water to " +
      "the sand, banks of backlit orange and gold clouds filling the sky, three " +
      "sets of breaking waves crossing the bay with white foam, wet sand and " +
      "dark rocks in the foreground, and tall coconut palms leaning in from both " +
      "sides with tropical planting at their feet",
    idle: false,
    rigid: [
      "the sun",
      "the level ocean horizon line",
      "the beach sand",
      "the dark rocks",
      "the distant headland on the right",
    ],
    beats: [
      {
        from: 0,
        to: 3.5,
        action:
          "the swell moves steadily through the bay and the nearest wave " +
          "curls and breaks, white water running up the wet sand; the " +
          "palm fronds stir slowly and the clouds drift slowly left",
      },
      {
        from: 3.5,
        to: 7,
        action:
          "the water keeps moving at the same even pace as the broken " +
          "wave slides back down the sand and a second wave breaks behind " +
          "it, the glitter column breaking up and re-forming; the palms " +
          "and clouds drift on",
      },
      {
        from: 7,
        to: 10,
        action:
          "the water returns to exactly the opening swell with the foam " +
          "lines in the same shapes, and the palms and clouds come back " +
          "to their opening positions",
      },
    ],
  },
];

const chosen = only ? SHOTS.filter((shot) => shot.key === only) : SHOTS;
if (!chosen.length) {
  console.error(`--only must be one of ${SHOTS.map((s) => s.key).join(", ")}`);
  process.exit(2);
}

let tokens = 0;
for (const shot of chosen) {
  const prompt = animatePrompt({
    describe: shot.describe,
    beats: shot.beats,
    loop: true,
    backdrop: "none",
    rigid: shot.rigid,
    // Everything on this proscenium is scenery, not a performance — except
    // the sea, which has to be allowed to break.
    idle: shot.idle !== false,
  });
  const estimate = estimateTokens(shot.size, shot.durationSeconds) ?? 0;
  tokens += estimate;
  const [w, h] = shot.screen;
  const oversample = Math.sqrt(
    ({ "1080p": 1920 * 1080, "4K": 3840 * 2160 } as Record<string, number>)[shot.size]! / (w * h),
  );

  console.log(`\n${"=".repeat(78)}\n${shot.label}`);
  console.log(
    `${w}x${h} in the comp · ${shot.size} ${shot.aspectRatio} · ` +
      `${shot.durationSeconds}s loop · ${oversample.toFixed(2)}x oversample · ` +
      `${estimate.toLocaleString()} tokens ≈ $${(estimate * DOLLARS_PER_TOKEN).toFixed(2)}`,
  );
  console.log(`${"-".repeat(78)}\n${prompt}`);

  if (!submit) continue;

  const env = Object.fromEntries(
    (await readFile(path.join(root, ".env"), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  const base = `http://${env.SEED_AE_HOST ?? "127.0.0.1"}:${env.SEED_AE_PORT ?? "47831"}`;
  const response = await fetch(`${base}/v1/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SEED_AE_SESSION_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      providerId: "seedance-2-0",
      model: "dreamina-seedance-2-0-260128",
      operation: "video.generate",
      prompt,
      size: shot.size,
      aspectRatio: shot.aspectRatio,
      durationSeconds: shot.durationSeconds,
      // The same still in both frame slots — Ark's flf2v, which is what makes
      // the clip end where it began.
      inputAssetIds: [shot.assetId],
      inputRoles: ["loop"],
    }),
  });
  const payload = (await response.json()) as any;
  if (!response.ok) {
    console.log(`  REFUSED ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
    continue;
  }
  console.log(`  submitted  job ${payload.job?.id}  generation ${payload.generation?.id}`);
}

console.log(
  `\n${chosen.length} shot${chosen.length === 1 ? "" : "s"}, ` +
    `${tokens.toLocaleString()} tokens ≈ $${(tokens * DOLLARS_PER_TOKEN).toFixed(2)}` +
    (submit ? "" : "\nNothing was sent. Re-run with --submit."),
);
