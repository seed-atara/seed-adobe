/**
 * Lays the 20s golden-hour-to-night clip into a side-wall comp, unsqueezed.
 *
 *   npx tsx scripts/insert-side-ghnight.ts --side left --dry
 *   npx tsx scripts/insert-side-ghnight.ts --side left
 *   npx tsx scripts/insert-side-ghnight.ts --side right --clip <path.mp4>
 *
 * The same four jobs as `insert-daynight-transition.ts` -- fit, ramp, dissolve
 * the head, dissolve the tail into the night plate -- with the first one
 * inverted, which is the whole reason this is a separate script.
 *
 * ## The proscenium is padded; a side wall is squeezed
 *
 * 5750x2818 is 2.0405:1, narrower than the 21:9 Seedance returns, so the
 * proscenium plates went out with bars on and the bars come straight back off
 * with a crop. 6688x1912 is **3.4979:1**, wider than 21:9, and padding it would
 * have spent a third of the frame on bars -- so the side plates went out
 * squeezed instead, 1.5x anamorphic, and come back as a 2206x946 clip that is
 * the whole wall in the wrong shape. Undoing that is a non-uniform scale, not a
 * crop: there is nothing to throw away.
 *
 * ## And the scale is AE's, not ffmpeg's
 *
 * `insert-daynight-transition.ts` re-encodes its crop to ProRes because a crop
 * has to be rendered somewhere. An unsqueeze does not: After Effects' Scale is
 * two numbers and will happily hold 303% x 202%, so the clip goes in untouched
 * and is stretched at render time. That skips a 700MB intermediate and a
 * generation of re-encoding, and it keeps the comp pointing at the file the
 * asset library knows about rather than a derivative of it.
 *
 * The softness is real and is not hidden: a 2206px clip across a 6688px wall is
 * a 3x upscale, and the plate either side of it is sharp. That is what the head
 * and tail dissolves are for -- the same 0.4s as the proscenium, measured there
 * to be enough to stop the join reading as a focus pop.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeRamp,
  speedRampKeys,
} from "../packages/domain/src/speedRamp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const num = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? Number(argv[at + 1] ?? fallback) : fallback;
};
const str = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};

/**
 * The two walls, and which clip is each one's approved render.
 *
 * Pinned by asset filename rather than passed in, because these two came back
 * from the draft conversion with the drafts' own seeds -- 9108 and 7419 -- and
 * a side wall laid in from the wrong file is the kind of mistake that is
 * invisible until the whole 270 degrees is projected.
 */
const SIDES: Record<
  string,
  { comp: string; night: string; clip: string; seed: number }
> = {
  left: {
    comp: "GYG_SIDES_LEFT_gh_to_night",
    night: "LEFT_night",
    clip: "seedance-2-5_3190649c_00.mp4",
    seed: 9108,
  },
  right: {
    comp: "GYG_SIDES_RIGHT_gh_to_night",
    night: "RIGHT_night",
    clip: "seedance-2-5_473be839_00.mp4",
    seed: 7419,
  },
};

const sideName = str("side", "left").toLowerCase();
const side = SIDES[sideName];
if (!side) {
  console.error(`--side must be one of ${Object.keys(SIDES).join(", ")}`);
  process.exit(2);
}

const GENERATED = "D:/SEEDD/Research/AE_SEED/.seed-ae/assets/generated";
const clip = str("clip", path.join(GENERATED, side.clip));
const startSeconds = num("start", 0);
const rampSeconds = num("ramp", 1.5);
const endSpeed = num("endSpeed", 0.2);
const dissolve = num("dissolve", 0.4);
const compWidth = num("compWidth", 6688);
const compHeight = num("compHeight", 1912);

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;

async function host(
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw) as { ok?: boolean; error?: unknown; value?: unknown };
  if (parsed.ok === false)
    throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  return parsed.value ?? parsed;
}

async function api(route: string, body: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${route}: ${raw.slice(0, 400)}`);
  return JSON.parse(raw);
}

/** 481 frames at 24fps: the last FRAME is at 20.0s, the file is 20.04s long. */
const CLIP_WIDTH = num("clipWidth", 2206);
const CLIP_HEIGHT = num("clipHeight", 946);
const FRAMES = num("frames", 481);
const FPS = num("fps", 24);
const durationSeconds = Math.round(((FRAMES - 1) / FPS) * 1000) / 1000;

const scaleX = Math.round((compWidth / CLIP_WIDTH) * 10000) / 100;
const scaleY = Math.round((compHeight / CLIP_HEIGHT) * 10000) / 100;

console.log(`=== ${side.comp}   ${sideName.toUpperCase()} wall`);
console.log(
  `  ${path.basename(clip)}  ${CLIP_WIDTH}x${CLIP_HEIGHT}, seed ${side.seed}, ` +
    `${durationSeconds.toFixed(2)}s`,
);
console.log(
  `  unsqueeze: scale ${scaleX}% x ${scaleY}%  ` +
    `(${(CLIP_WIDTH / CLIP_HEIGHT).toFixed(4)}:1 -> ${(compWidth / compHeight).toFixed(4)}:1, ` +
    `a ${(scaleX / scaleY).toFixed(3)}x horizontal stretch)`,
);

const rampRequest = { durationSeconds, rampSeconds, endSpeed };
const keys = speedRampKeys(rampRequest);
const shape = describeRamp(rampRequest);
console.log(
  `\n  speed ramp: ${shape.rampSeconds}s real time at each end (${shape.endSpeed}x), ` +
    `${shape.peak}x through the middle`,
);
for (const [at, source] of keys) {
  console.log(`    ${String(at).padStart(6)}s  ->  source ${String(source).padStart(6)}s`);
}

const remapKeys = keys.map(([at, source]) => [
  Math.round((startSeconds + at) * 1000) / 1000,
  source,
]);

const endsAt = startSeconds + durationSeconds;
const headKeys = [
  { atSeconds: startSeconds, value: 0 },
  { atSeconds: Math.round((startSeconds + dissolve) * 1000) / 1000, value: 100 },
];
const tailKeys = [
  { atSeconds: startSeconds, value: 0 },
  { atSeconds: Math.round((endsAt - dissolve) * 1000) / 1000, value: 0 },
  { atSeconds: Math.round(endsAt * 1000) / 1000, value: 100 },
];

console.log(`\n  joins, ${dissolve}s each:`);
console.log(`    head  clip opacity        ${headKeys.map((k) => `${k.atSeconds}s=${k.value}%`).join("  ")}`);
console.log(`    tail  ${side.night} opacity  ${tailKeys.map((k) => `${k.atSeconds}s=${k.value}%`).join("  ")}`);
console.log(`          and it holds at 100% from ${endsAt}s to the end of the comp`);

const LAYER_NAME = `SEED golden-to-night 20s`;

if (dry) {
  console.log("\n--dry: nothing inserted, nothing changed.");
  process.exit(0);
}

if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

/** The comp is found by name, so a renamed or missing one stops rather than guesses. */
const comps = await host("projectComps");
const target = (comps.comps ?? comps.items ?? []).find(
  (c: { name: string }) => c.name === side.comp,
);
if (!target) throw new Error(`no comp called ${side.comp} in this project`);
/*
 * `setActiveComp` reports whether the comp actually became active rather than
 * assuming it: `openInViewer` can succeed while After Effects leaves focus on
 * the viewer that was already in front. `insertIntoComp` takes no comp id and
 * uses `app.project.activeItem`, so an ignored `isActive: false` puts the layer
 * in whatever comp the artist happened to be looking at -- which is exactly
 * what it did the first time this ran. Verified twice, and against the host's
 * own idea of the active comp rather than this script's.
 */
let active = await host("setActiveComp", { compId: String(target.id) });
if (active.isActive !== true) {
  console.log(`  ${target.name} did not come forward on the first try — asking again`);
  active = await host("setActiveComp", { compId: String(target.id) });
}
const context = await host("getContext");
if (String(context.compId) !== String(target.id)) {
  throw new Error(
    `${target.name} (${target.id}) would not become the active comp — ` +
      `After Effects is still on ${context.compName} (${context.compId}). ` +
      `Click the comp in the Project panel and run this again.`,
  );
}
console.log(`\nactive comp ${target.id} ${target.name}`);

/*
 * Re-runnable, and checked against the SOURCE rather than the layer name --
 * the 480p draft went in under this same name while it was being judged, and a
 * script that trusted the name would have re-ramped the draft and reported
 * success with the comp still holding it.
 */
const before = ((await host("compTree")).layers ?? []) as Array<{
  index: number;
  name: string;
  source?: { file?: string };
}>;
const present = before.find((l) => l.name === LAYER_NAME);
const sameClip = present?.source?.file?.startsWith(path.basename(clip, path.extname(clip))) === true;

if (present && !sameClip) {
  console.log(
    `  "${LAYER_NAME}" is layer ${present.index} holding ${present.source?.file ?? "something else"} — replacing it`,
  );
  await host("deleteLayer", { layerIndex: present.index, expectName: LAYER_NAME });
} else if (present) {
  console.log(`  "${LAYER_NAME}" is already layer ${present.index} — re-ramping that`);
}

let clipIndex: number;
if (present && sameClip) {
  clipIndex = Number(present.index);
} else {
  const adopted = await api("/v1/assets/adopt", { path: clip });
  const assetId = String(adopted.asset?.id ?? adopted.id ?? "");
  console.log(`  adopted ${assetId}`);
  const placed = await host("insertIntoComp", {
    assetId,
    startSeconds,
    // `none` because the fit is being set by hand: every other mode scales the
    // two axes together, which is exactly what must not happen to a squeeze.
    fit: "none",
    name: LAYER_NAME,
  });
  clipIndex = Number(placed.layer?.index ?? placed.index ?? 1);
  console.log(`  layer ${clipIndex}  ${placed.layer?.name ?? LAYER_NAME}`);
}

console.log(`  unsqueezing to ${scaleX}% x ${scaleY}%`);
await host("setTransform", {
  layerIndex: clipIndex,
  property: "scale",
  value: [scaleX, scaleY],
  replace: true,
});
await host("setTransform", {
  layerIndex: clipIndex,
  property: "position",
  value: [compWidth / 2, compHeight / 2],
  replace: true,
});

console.log(`  time remapping ${remapKeys.length} keys`);
const remapped = await host("setTimeRemap", { layerIndex: clipIndex, keys: remapKeys });
console.log(`  ${remapped.keysApplied} applied, source ${remapped.firstValue} -> ${remapped.lastValue}`);

console.log(`  head dissolve on layer ${clipIndex}`);
await host("setTransform", {
  layerIndex: clipIndex,
  property: "opacity",
  keyframes: headKeys,
  replace: true,
});

/*
 * The night plate has to sit ABOVE the clip for its dissolve to read, and
 * `insertIntoComp` puts the new layer on top. Re-read the tree rather than
 * trusting the index from before the insert: adding a layer shifted it.
 */
const after = ((await host("compTree")).layers ?? []) as Array<{ index: number; name: string }>;
const night = after.find((l) => l.name.toLowerCase() === side.night.toLowerCase());
if (!night) throw new Error(`no layer called "${side.night}" in ${side.comp}`);
if (night.index > clipIndex) {
  console.log(`  moving ${side.night} from ${night.index} above the clip`);
  await host("moveLayer", { layerIndex: night.index, toIndex: clipIndex });
}

const nightFinal = ((await host("compTree")).layers ?? []).find(
  (l: { name: string }) => l.name.toLowerCase() === side.night.toLowerCase(),
);
console.log(`  tail dissolve on ${side.night} (layer ${nightFinal.index})`);
await host("setLayerEnabled", { layerIndex: nightFinal.index, enabled: true });
await host("setTransform", {
  layerIndex: nightFinal.index,
  property: "opacity",
  keyframes: tailKeys,
  replace: true,
});

const tree = await host("compTree");
console.log(`\n${side.comp} now holds:`);
for (const layer of tree.layers ?? [])
  console.log(`  ${String(layer.index).padStart(2)}  ${layer.name}`);
console.log(
  `\ndone. ${startSeconds}-${endsAt}s is the transition, ${endsAt}s onward is the night set.`,
);
