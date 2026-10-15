/**
 * Grabs the two end frames of the golden-hour-to-night transition from AE.
 *
 *   npx tsx scripts/capture-daynight-plates.ts [--layer Night_layer] [--dry]
 *   npx tsx scripts/capture-daynight-plates.ts --size 720p
 *
 * The artist's setup is the whole trick and it belongs to them: the golden-hour
 * elements are freeze-framed, and a night version of the same set sits on top
 * of them at zero opacity. So the start frame is simply what is on screen, and
 * the end frame is the same comp with that one layer turned up. Two captures of
 * one comp, in perfect register by construction, which is a far better
 * guarantee than two renders of two comps could give.
 *
 * ## What this changes in the project, and what it puts back
 *
 * Two properties of one layer: the night layer is switched on and its opacity
 * taken to 100, and both go back to exactly what they were. Both, because the
 * layer as prepared is *disabled* and at 0% — either one left alone would
 * capture the day frame twice and nothing would say so, which is the quiet
 * failure this is shaped to avoid. The restore runs in a `finally`, so a
 * capture that throws still puts the layer back: a night layer left switched on
 * is a silently wrecked comp, and the artist would find it rather than be told.
 *
 * `setTransform` refuses a property that is already keyframed or driven by an
 * expression unless it is told to replace it, and that refusal is not worked
 * around here. If the night layer's opacity is animated, that is somebody's
 * animation and this script stops rather than overwrite it.
 *
 * ## The shape, which is the expensive part
 *
 * The proscenium comp is 5750x2818 — 2.0405:1, which is not a shape Seedance
 * returns. Sent at `adaptive` it came back 3840x2160, having snapped to 16:9
 * and centre-cropped 370px off each side, and on this plate those 370px are the
 * proscenium arch. So the plate is padded out to a named aspect here and the
 * aspect is then asked for by name, leaving the model nothing to decide.
 *
 * 21:9 rather than 16:9, and the pixels are the same either way — 12.5% of the
 * frame is padding at 21:9 against 12.9% at 16:9. The reason is the brief: the
 * moon has to rise through the middle of the sky and leave through the top
 * edge. Padding the sides leaves every vertical relationship — horizon height,
 * sky depth, where the top edge is — exactly as the artwork has it. Padding the
 * top would put the moon's exit inside invented sky that gets cropped away,
 * where it cannot be checked.
 *
 * ## Why the plates come back resized
 *
 * Measured on the party-city wall, and the single largest effect found on this
 * project: of four regions, the only one that composited invisibly was the one
 * whose plate was already the generation's own output size. Over the feather
 * band its seam was mean 2.43 against 7.60, 15.57 and 17.64 for the three the
 * model had to resample, and re-sending one of those at exactly 1920x1080 took
 * it from 15.57 to 6.10. Upscaling a plate adds no information, but it hands
 * the model the grid it is going to work on, and a first frame it has to
 * resample is a first frame it has re-interpreted rather than held.
 *
 * It also keeps the request small enough to send. No R2 publisher is
 * configured on this box, so every reference travels as an inline base64 data
 * URI; a full-frame projection plate is tens of megabytes of JSON and five
 * generations died in transport before that was understood.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aspectFits } from "../packages/domain/src/animate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};
const layerName = flag("layer", "Night_layer");
const size = flag("size", "720p");
/** The named Seedance aspect the plate is padded out to. */
const aspect = flag("aspect", "21:9");
/** How the padding is filled. `smear` streaks the edge; `mirror` reflects it. */
const fill = flag("fill", "smear");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

/** The pixel budget of each tier, which is what a generation actually spends. */
const TIER_PIXELS: Record<string, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
};

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
  // The host answers HTTP 200 for its own refusals too; checking only the
  // status is how an earlier script reported "placed" three times for nothing.
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

// ------------------------------------------------------------ the comp itself

/**
 * The workspace root, so a capture's path can be resolved.
 *
 * `captureFrame` reports `storageUri` as a library-relative path --
 * `assets/originals/....png` -- because an asset belongs to the library rather
 * than to a location on someone's disk. Handing that straight to ffmpeg is how
 * the first run of this got two good captures and then failed on the resize.
 */
const workspaceResponse = await fetch(`${base}/v1/workspace`, {
  headers: { Authorization: `Bearer ${token}` },
});
const workspace = (await workspaceResponse.json()) as {
  workspace?: { root?: string };
};
const libraryRoot = String(workspace.workspace?.root ?? "");
if (!libraryRoot) throw new Error("could not read the workspace root from /v1/workspace");

/** An absolute path for a capture, whichever form the host reported it in. */
function onDisk(reported: string): string {
  return path.isAbsolute(reported) ? reported : path.join(libraryRoot, reported);
}

const context = await host("getContext");
const compName = String(context.compName ?? context.comp?.name ?? "(unknown)");
const compWidth = Number(context.width ?? context.comp?.width ?? 0);
const compHeight = Number(context.height ?? context.comp?.height ?? 0);
const playhead = Number(context.timeSeconds ?? context.time ?? 0);

console.log(
  `comp "${compName}"  ${compWidth}x${compHeight}  playhead ${playhead.toFixed(3)}s`,
);

if (!compWidth || !compHeight) {
  console.log(JSON.stringify(context).slice(0, 800));
  throw new Error("could not read the comp's size from getContext");
}

/*
 * The shape question, before anything is spent. `adaptive` does not mean "the
 * plate's own shape" -- it means the nearest aspect Seedance returns, cropped
 * to. That cost $12 on the proscenium background, which is 2.04:1, was sent at
 * `adaptive`, and came back 16:9 with 370px taken off each side.
 */
const shape = aspectFits(compWidth, compHeight);
console.log(
  `  aspect ${shape.aspect}:1  nearest Seedance shape ${shape.crop.nearest}`,
);
if (shape.why) console.log(`  ! ${shape.why}`);
if (shape.warn) console.log(`  ! ${shape.warn}`);

// ------------------------------------------------- find the night layer

const tree = await host("compTree");
const layers: Array<{ index: number; name: string; enabled?: boolean }> =
  Array.isArray(tree.layers) ? tree.layers : Array.isArray(tree) ? tree : [];
if (!layers.length) {
  console.log(JSON.stringify(tree).slice(0, 1200));
  throw new Error("compTree returned no layers");
}
console.log(`\n${layers.length} layers:`);
for (const layer of layers.slice(0, 40)) {
  console.log(
    `  ${String(layer.index).padStart(3)}  ${layer.name}${layer.enabled === false ? "  (off)" : ""}`,
  );
}

const night = layers.find(
  (l) => l.name.toLowerCase() === layerName.toLowerCase(),
);
if (!night) {
  throw new Error(
    `no layer called "${layerName}" in ${compName}. Pass --layer with the real name.`,
  );
}
console.log(`\nnight layer: ${night.index}  ${night.name}`);

// --------------------------------------------------------------- the captures

/**
 * Pads a capture out to the named aspect and lands it on the generation's grid.
 *
 * Both in one filter chain and in this order, because padding after the scale
 * would put the bars on the output grid rather than in the artwork, and the
 * whole point is that the model receives one rectangle of the exact shape and
 * size it is going to work in.
 *
 * 4:4:4 at q2 so the chroma of a painted sunset survives the trip. Measured on
 * the party-city plates: 11 MB of PNG down to 0.68 MB for a mean error of
 * 0.72/255, which is far less than the 4:2:0 H.264 the result comes back in.
 */
async function toGrid(
  from: string,
  to: string,
  w: number,
  h: number,
  pad: { width: number; height: number; x: number; y: number },
): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const chain = [
    `pad=${pad.width}:${pad.height}:${pad.x}:${pad.y}`,
    // Fills what `pad` just created. Left/right only on a 21:9 pad, and the
    // filter is given the same numbers so it cannot disagree with the pad.
    pad.x > 0
      ? `fillborders=left=${pad.x}:right=${pad.width - pad.x - compWidth}:mode=${fill}`
      : "",
    pad.y > 0
      ? `fillborders=top=${pad.y}:bottom=${pad.height - pad.y - compHeight}:mode=${fill}`
      : "",
    `scale=${w}:${h}:flags=lanczos`,
  ]
    .filter(Boolean)
    .join(",");
  const run = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-i",
      from,
      "-vf",
      chain,
      "-q:v",
      "2",
      "-pix_fmt",
      "yuvj444p",
      to,
    ],
    { windowsHide: true },
  );
  const errors: string[] = [];
  run.stderr.on("data", (c) => errors.push(String(c)));
  await new Promise<void>((done, fail) =>
    run.on("close", (code) =>
      code === 0
        ? done()
        : fail(
            new Error(errors.join("").slice(0, 400) || `ffmpeg exit ${code}`),
          ),
    ),
  );
}

const pixels = TIER_PIXELS[size.toLowerCase()];
if (!pixels)
  throw new Error(`${size} is not a tier this sends (480p, 720p, 1080p)`);

const [aw, ah] = aspect.split(":").map(Number);
if (!aw || !ah) throw new Error(`cannot read "${aspect}" as an aspect`);
const targetAspect = aw / ah;

/*
 * The padded canvas: the comp's own pixels, with bars on whichever axis is
 * short of the named aspect. Even numbers throughout, because every encoder in
 * this chain wants them and an odd pad is the kind of off-by-one that shows up
 * as a one-pixel line after the crop.
 */
const padWidth =
  compWidth / compHeight < targetAspect
    ? Math.round((compHeight * targetAspect) / 2) * 2
    : compWidth;
const padHeight =
  compWidth / compHeight > targetAspect
    ? Math.round(compWidth / targetAspect / 2) * 2
    : compHeight;
const padX = Math.round((padWidth - compWidth) / 2);
const padY = Math.round((padHeight - compHeight) / 2);

/*
 * A tier is a pixel budget spent in the requested aspect, measured rather than
 * assumed: region 9 asked for 1080p at 1:1 and came back 1440x1440, which is
 * the 1080p budget exactly. So this is the size the generation will work at,
 * and the size the plate is therefore handed over at.
 */
const gridH = Math.round(Math.sqrt(pixels / targetAspect) / 2) * 2;
const gridW = Math.round((gridH * targetAspect) / 2) * 2;
/** What the comp's own area gets of that, once the bars are cropped back off. */
const usefulW = Math.round((gridW * compWidth) / padWidth);
const usefulH = Math.round((gridH * compHeight) / padHeight);
const oversample = Math.sqrt((usefulW * usefulH) / (compWidth * compHeight));

console.log(
  `\npadding ${compWidth}x${compHeight} out to ${padWidth}x${padHeight} (${aspect}) ` +
    `with ${padX}px ${fill} bars each side` +
    (padY ? ` and ${padY}px top and bottom` : ""),
);
console.log(
  `  ${(100 * (1 - (compWidth * compHeight) / (padWidth * padHeight))).toFixed(1)}% of the ` +
    `generated frame is padding, cropped off afterwards`,
);
console.log(
  `plates sent at ${gridW}x${gridH} — the ${size} budget spent in ${aspect}`,
);
console.log(
  `  the comp's own area gets ${usefulW}x${usefulH} of that, ` +
    `which is ${oversample.toFixed(3)}x its ${compWidth}x${compHeight}`,
);
if (oversample < 1) {
  console.log(
    `  ! that is a ${(1 / oversample).toFixed(1)}x UPSCALE back into the comp. ` +
      `Fine for judging motion; see the note on the final pass before approving one.`,
  );
}

const work = path.join(root, ".work", "daynight");
let restored = false;

/**
 * Back to exactly how the artist left it: switched off, at 0%.
 *
 * Read off the layer rather than assumed — `wasEnabled` and `wasOpacity` come
 * from `compTree` above, so a comp prepared differently is restored to how it
 * actually was and not to this script's idea of it.
 */
const wasEnabled = night.enabled === true;
const wasOpacity = Number(
  (night as { opacityPercent?: number }).opacityPercent ?? 0,
);
/*
 * Taken out of `night` here rather than read inside `restore`.
 *
 * The `if (!night) throw` above narrows it, but the narrowing does not reach
 * into a function body, so `night.index` inside the closure is `possibly
 * undefined` to the compiler and right to a reader. Holding the index is also
 * the honest thing: restore has to put back the layer this script changed, not
 * whatever `night` happens to point at when it runs.
 */
const nightIndex = night.index;
async function restore(): Promise<void> {
  await host("setTransform", {
    layerIndex: nightIndex,
    property: "opacity",
    value: wasOpacity,
  });
  await host("setLayerEnabled", {
    layerIndex: nightIndex,
    enabled: wasEnabled,
  });
  restored = true;
}

console.log(
  `\n${night.name} is currently ${wasEnabled ? "on" : "off"} at ${wasOpacity}% — ` +
    `it goes on at 100% for one capture and comes straight back to that`,
);

if (dry) {
  console.log("\n--dry: nothing captured, nothing changed.");
} else {
  try {
    console.log("\n1/2  capturing the golden-hour set as it stands");
    const day = await host("captureFrame");
    const dayPath = String(
      day.asset?.storageUri ?? day.path ?? day.asset?.path ?? "",
    );
    console.log(`     ${day.asset?.id ?? "(no id)"}  ${dayPath}`);
    if (day.warning) console.log(`     ! ${day.warning}`);

    console.log(
      `\n2/2  switching ${night.name} on at 100% and capturing the night set`,
    );
    // Both, in this order. As prepared the layer is disabled AND at 0%, so
    // raising only one of the two captures the day frame a second time and
    // nothing in the result would say so.
    await host("setLayerEnabled", { layerIndex: night.index, enabled: true });
    await host("setTransform", {
      layerIndex: night.index,
      property: "opacity",
      value: 100,
    });
    const nightCapture = await host("captureFrame");
    const nightPath = String(
      nightCapture.asset?.storageUri ??
        nightCapture.path ??
        nightCapture.asset?.path ??
        "",
    );
    console.log(`     ${nightCapture.asset?.id ?? "(no id)"}  ${nightPath}`);
    if (nightCapture.warning) console.log(`     ! ${nightCapture.warning}`);

    // Put it back before anything else can fail.
    await restore();
    console.log(`\n     ${night.name} back to off at 0% opacity`);

    console.log("\nresizing both onto the generation grid and adopting them");
    const out: Array<{ label: string; assetId: string; file: string }> = [];
    for (const [label, source] of [
      ["day", dayPath],
      ["night", nightPath],
    ] as const) {
      if (!source)
        throw new Error(`the ${label} capture did not report a path`);
      const file = path.join(work, `${label}_${gridW}x${gridH}.jpg`);
      await toGrid(onDisk(source), file, gridW, gridH, {
        width: padWidth,
        height: padHeight,
        x: padX,
        y: padY,
      });
      const adopted = await api("/v1/assets/adopt", { path: file });
      const assetId = String(adopted.asset?.id ?? adopted.id ?? "");
      out.push({ label, assetId, file });
      console.log(`  ${label.padEnd(5)}  ${assetId}  ${path.basename(file)}`);
    }

    console.log(
      `\nready. generate with:\n  npx tsx scripts/animate-golden-to-night.ts ` +
        `--day ${out[0]!.assetId} --night ${out[1]!.assetId} --size ${size} ` +
        `--aspect ${aspect} --dry`,
    );
    console.log(
      `\nand crop the bars back off the result with:\n  ` +
        `--crop ${gridW}x${gridH} -> keep x ${Math.round((gridW * padX) / padWidth)} ` +
        `width ${usefulW}`,
    );
  } finally {
    if (!restored) {
      /*
       * The capture failed somewhere after the layer went on. Putting it back
       * matters more than the error that got us here, so this is attempted and
       * its own failure is reported loudly rather than thrown over the top of
       * the original.
       */
      try {
        await restore();
        console.error(
          `\n(${night.name} restored to off at ${wasOpacity}% after the failure above)`,
        );
      } catch (error) {
        console.error(
          `\n!! ${night.name} IS STILL SWITCHED ON AT 100% and could not be restored: ` +
            `${(error as Error).message}\n!! set it back by hand before saving the project.`,
        );
      }
    }
  }
}
