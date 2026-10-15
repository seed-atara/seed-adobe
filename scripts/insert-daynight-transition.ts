/**
 * Lays the 20s day-to-night transition into the comp, ramped, joined at both ends.
 *
 *   npx tsx scripts/insert-daynight-transition.ts <clip.mp4> [--dry]
 *   npx tsx scripts/insert-daynight-transition.ts <clip.mp4> --start 0 --ramp 1.5
 *
 * Four separate jobs, and each one of them is the answer to something that was
 * measured rather than a decoration:
 *
 * 1. **Crop the bars off.** The plates went out padded to 21:9 because
 *    5750x2818 is 2.0405:1 and Seedance does not return that shape -- sent
 *    unpadded it snaps to 16:9 and centre-crops the proscenium away. The
 *    padding comes straight back off here, computed from the same ratio that
 *    put it on rather than from a remembered pixel count.
 *
 * 2. **Ramp it.** A second and a half of real time at each end with the hours
 *    racing between them. Done here and not in the prompt because `source(0)=0`
 *    and `source(T)=T` are the whole reason the clip is usable and arithmetic
 *    can guarantee them; a model cannot.
 *
 * 3. **Dissolve the head.** The clip is a 3-4.5x upscale of a 5750px plate, so
 *    its first frame is a *soft* version of a sharp one. Content-wise it
 *    matches; sharpness-wise it does not, and a cut would read as a focus pop
 *    on an otherwise invisible join. Four tenths of a second of dissolve from
 *    the artwork underneath hides it completely and costs nothing.
 *
 * 4. **Dissolve the tail into `Night_layer` itself.** The brief is that the end
 *    frame is *exactly* the night plate, and the surest way to deliver that is
 *    to end on the night plate rather than on a rendering of it. The night
 *    layer comes up over the last four tenths of a second, which both lands the
 *    final frame exactly and takes the softness off the other join. It then
 *    stays up, so the comp holds a sharp night set from the end of the
 *    transition to 30s.
 *
 * Nothing here is destructive: it adds one layer and animates the opacity of a
 * layer that was already sitting at zero. `--dry` prints the whole plan,
 * including every keyframe, and changes nothing.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeRamp,
  speedRampKeys,
} from "../packages/domain/src/speedRamp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
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
const clip = argv.find(
  (a, at) => !a.startsWith("--") && !(at > 0 && argv[at - 1]!.startsWith("--")),
);

const startSeconds = num("start", 0);
const rampSeconds = num("ramp", 1.5);
const endSpeed = num("endSpeed", 0.2);
const dissolve = num("dissolve", 0.4);
const nightName = str("layer", "Night_layer");
/** The comp's own shape, which is what the bars were added to reach 21:9. */
const compWidth = num("compWidth", 5750);
const compHeight = num("compHeight", 2818);
const aspect = str("aspect", "21:9");

if (!clip) {
  console.error("usage: insert-daynight-transition.ts <clip.mp4> [--dry]");
  process.exit(2);
}

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

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
  const parsed = JSON.parse(raw) as {
    ok?: boolean;
    error?: unknown;
    value?: unknown;
  };
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

// ------------------------------------------------------- 1. crop the padding

async function probe(
  file: string,
): Promise<{ w: number; h: number; fps: number; frames: number }> {
  const run = spawn(ffmpeg, ["-i", file], { windowsHide: true });
  let info = "";
  run.stderr.on("data", (c) => (info += String(c)));
  await new Promise<void>((done) => run.on("close", () => done()));
  const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
  if (!size) throw new Error(`could not read ${file}`);
  const rate = /([\d.]+) fps/.exec(info);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const fps = rate ? Number(rate[1]) : 24;
  const seconds = dur
    ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
    : 0;
  return {
    w: Number(size[1]),
    h: Number(size[2]),
    fps,
    frames: Math.round(seconds * fps),
  };
}

const meta = await probe(clip);
const [aw, ah] = aspect.split(":").map(Number);
const targetAspect = (aw ?? 21) / (ah ?? 9);

/*
 * The padded canvas the plates were built on, recomputed from the same rule
 * rather than remembered: whichever axis was short of the named aspect got the
 * bars, and the crop is that fraction of whatever the model actually returned.
 */
const padWidth =
  compWidth / compHeight < targetAspect
    ? Math.round((compHeight * targetAspect) / 2) * 2
    : compWidth;
const padHeight =
  compWidth / compHeight > targetAspect
    ? Math.round(compWidth / targetAspect / 2) * 2
    : compHeight;
const keepW = Math.round((meta.w * compWidth) / padWidth / 2) * 2;
const keepH = Math.round((meta.h * compHeight) / padHeight / 2) * 2;
const keepX = Math.round((meta.w - keepW) / 2);
const keepY = Math.round((meta.h - keepH) / 2);

/**
 * The last frame's own time, not the clip's duration.
 *
 * A 481-frame clip at 24fps is 20.0417s long, but its last *frame* starts at
 * 480/24 = 20.0s, and a time remap addresses frames. Asked for 20.0417 After
 * Effects answers `Value 20.04 out of range 0 to 20.04` — true, and only by a
 * rounding hair, which is the kind of boundary that is much easier to read off
 * an error message than to reason about beforehand.
 *
 * It also makes the ramp a round twenty seconds, which is what was ordered.
 */
const durationSeconds =
  Math.round(((meta.frames - 1) / meta.fps) * 1000) / 1000;
console.log(
  `${path.basename(clip)}  ${meta.w}x${meta.h} @ ${meta.fps}  ${durationSeconds.toFixed(2)}s`,
);
console.log(
  `  cropping to ${keepW}x${keepH} at +${keepX},+${keepY}  ` +
    `(${(keepW / keepH).toFixed(4)}:1 against the comp's ${(compWidth / compHeight).toFixed(4)}:1)`,
);
if (Math.abs(keepW / keepH - compWidth / compHeight) > 0.02) {
  console.log(
    `  ! the cropped shape does not match the comp. Check --aspect and whether ` +
      `the model returned the shape it was asked for.`,
  );
}

const work = path.join(root, ".work", "daynight");
const cropped = path.join(
  work,
  `${path.basename(clip, path.extname(clip))}_cropped.mov`,
);

// --------------------------------------------------------------- 2. the ramp

const rampRequest = { durationSeconds, rampSeconds, endSpeed };
const keys = speedRampKeys(rampRequest);
const shape = describeRamp(rampRequest);
console.log(
  `\nspeed ramp: ${shape.rampSeconds}s in and out at ${shape.endSpeed}x, ` +
    `${shape.peak}x through the middle, ${shape.slowestRatio}:1 slowest to fastest`,
);
console.log(`  ${keys.length} keyframes, linear between them:`);
for (const [at, source] of keys) {
  console.log(
    `    ${String(at).padStart(6)}s  ->  source ${String(source).padStart(6)}s`,
  );
}

/** Comp time is offset by where the clip starts; source time is not. */
const remapKeys = keys.map(([at, source]) => [
  Math.round((startSeconds + at) * 1000) / 1000,
  source,
]);

// ------------------------------------------------------------ 3 & 4. the joins

const endsAt = startSeconds + durationSeconds;
const headKeys = [
  { atSeconds: startSeconds, value: 0 },
  {
    atSeconds: Math.round((startSeconds + dissolve) * 1000) / 1000,
    value: 100,
  },
];
/*
 * The night layer is held at zero until the very end of the transition so that
 * the comp plays the generated shot, not the still underneath it, and then
 * comes up to full for the last fraction of a second and stays there. The
 * third key is what makes the final frame exactly the night plate; the first
 * two are what stop it showing before it is wanted.
 */
const tailKeys = [
  { atSeconds: startSeconds, value: 0 },
  { atSeconds: Math.round((endsAt - dissolve) * 1000) / 1000, value: 0 },
  { atSeconds: Math.round(endsAt * 1000) / 1000, value: 100 },
];

console.log(`\njoins, ${dissolve}s each:`);
console.log(
  `  head  clip opacity   ${headKeys.map((k) => `${k.atSeconds}s=${k.value}%`).join("  ")}`,
);
console.log(
  `  tail  ${nightName} opacity  ${tailKeys.map((k) => `${k.atSeconds}s=${k.value}%`).join("  ")}`,
);
console.log(
  `        and it stays at 100% from ${endsAt}s to the end of the comp`,
);

/** The name the clip layer gets, and how this finds it again on a re-run. */
const LAYER_NAME = "SEED day-to-night 20s";

if (dry) {
  console.log("\n--dry: nothing cropped, nothing inserted, nothing changed.");
} else {
  /*
   * Re-runnable on purpose. Getting the ramp right took two attempts against
   * real After Effects errors, and a script that imports a second copy of a
   * 20-second clip every time it is run would have left four of them stacked in
   * the comp.
   *
   * But reuse has to be checked against the SOURCE, not just the layer name.
   * Re-running this with a different clip — the 1080p final after the 720p
   * preview, which is exactly what happens here — would otherwise silently
   * re-ramp the old footage and report success, and the comp would still be
   * holding the preview. So a layer whose source is not this clip is replaced
   * rather than reused.
   */
  const present = ((await host("compTree")).layers ?? []).find(
    (l: { name: string }) => l.name === LAYER_NAME,
  ) as { index: number; source?: { file?: string } } | undefined;
  const wantFile = path.basename(cropped, path.extname(cropped));
  const sameClip = present?.source?.file?.startsWith(wantFile) === true;

  if (present && !sameClip) {
    console.log(
      `\n"${LAYER_NAME}" is layer ${present.index} but holds ` +
        `${present.source?.file ?? "something else"} — replacing it`,
    );
    await host("deleteLayer", {
      layerIndex: present.index,
      expectName: LAYER_NAME,
    });
  } else if (present) {
    console.log(
      `\n"${LAYER_NAME}" is already layer ${present.index} — re-ramping that`,
    );
  }
  const existing = sameClip ? present : undefined;

  if (!existing) {
    await mkdir(work, { recursive: true });
    console.log(`\ncropping -> ${path.basename(cropped)}`);
    const crop = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-i",
        clip,
        "-vf",
        `crop=${keepW}:${keepH}:${keepX}:${keepY}`,
        // ProRes, not H.264: this goes into a comp and gets scaled up 3-4x, and
        // re-encoding a crop through a lossy codec throws away exactly the
        // high-frequency detail that an upscale has least of to begin with.
        "-c:v",
        "prores_ks",
        "-profile:v",
        "3",
        "-qscale:v",
        "9",
        "-an",
        cropped,
      ],
      { windowsHide: true },
    );
    const errors: string[] = [];
    crop.stderr.on("data", (c) => errors.push(String(c)));
    await new Promise<void>((done, fail) =>
      crop.on("close", (code) =>
        code === 0
          ? done()
          : fail(
              new Error(errors.join("").slice(0, 400) || `ffmpeg exit ${code}`),
            ),
      ),
    );
  }

  const tree = await host("compTree");
  const night = (tree.layers ?? []).find(
    (l: { name: string }) => l.name.toLowerCase() === nightName.toLowerCase(),
  );
  if (!night)
    throw new Error(`no layer called "${nightName}" in ${tree.comp?.name}`);

  let clipIndex: number;
  if (existing) {
    clipIndex = Number(existing.index);
  } else {
    const adopted = await api("/v1/assets/adopt", { path: cropped });
    const assetId = String(adopted.asset?.id ?? adopted.id ?? "");
    console.log(`  adopted ${assetId}`);
    console.log(`\ninserting into ${tree.comp?.name} at ${startSeconds}s`);
    const placed = await host("insertIntoComp", {
      assetId,
      startSeconds,
      fit: "cover",
      name: LAYER_NAME,
    });
    clipIndex = Number(placed.layer?.index ?? placed.index ?? 1);
    console.log(`  layer ${clipIndex}  ${placed.layer?.name ?? ""}`);
  }

  console.log(`  time remapping ${remapKeys.length} keys`);
  const remapped = await host("setTimeRemap", {
    layerIndex: clipIndex,
    keys: remapKeys,
  });
  console.log(
    `  ${remapped.keysApplied} applied, source ${remapped.firstValue} -> ${remapped.lastValue}`,
  );

  console.log(`  head dissolve on layer ${clipIndex}`);
  await host("setTransform", {
    layerIndex: clipIndex,
    property: "opacity",
    keyframes: headKeys,
    replace: true,
  });

  /*
   * The night layer has to sit ABOVE the clip for its dissolve to read, and
   * `insertIntoComp` puts the new layer at the top. Re-read the tree rather
   * than assuming the night layer's old index: adding a layer shifted it.
   */
  const after = await host("compTree");
  const nightNow = (after.layers ?? []).find(
    (l: { name: string }) => l.name.toLowerCase() === nightName.toLowerCase(),
  );
  const nightIndex = Number(nightNow?.index ?? night.index);
  if (nightIndex > clipIndex) {
    console.log(`  moving ${nightName} from ${nightIndex} above the clip`);
    await host("moveLayer", { layerIndex: nightIndex, toIndex: clipIndex });
  }

  const nightFinal = (await host("compTree")).layers.find(
    (l: { name: string }) => l.name.toLowerCase() === nightName.toLowerCase(),
  );
  console.log(`  tail dissolve on ${nightName} (layer ${nightFinal.index})`);
  await host("setLayerEnabled", {
    layerIndex: nightFinal.index,
    enabled: true,
  });
  await host("setTransform", {
    layerIndex: nightFinal.index,
    property: "opacity",
    keyframes: tailKeys,
    replace: true,
  });

  console.log(
    `\ndone. ${startSeconds}-${endsAt}s is the transition, ` +
      `${endsAt}s onward is the night set.`,
  );
}
