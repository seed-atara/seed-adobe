/**
 * Does an English materials manifest work as well as ByteDance's Chinese one?
 *
 * This is the assumption the whole tiering model in `docs/product/ITEMS.md`
 * rests on. Ark's published guide writes the material mapping in Chinese, under
 * 【素材职责】, using `@图片N`; SEED writes it in English under "Materials:",
 * using "Image N", because our own measured note says inputs are referred to by
 * position. Both cannot be equally right, and nobody here knows which is.
 *
 * **This one is not free.** Unlike the parameter probes, quality cannot be read
 * off a validation error — it needs real generations. Seedream is used rather
 * than Seedance: it is synchronous and seconds rather than minutes, so the same
 * budget buys many more samples, and the question is about prompt language
 * rather than about video.
 *
 * The design is a paired A/B. Every pair shares a reference plate, a shot
 * prompt and a seed, and differs only in the language of the manifest — so a
 * difference between the two images is attributable to that and nothing else.
 *
 *   npx tsx --env-file=.env scripts/probe-manifest-language.ts --shots 4
 *   npx tsx --env-file=.env scripts/probe-manifest-language.ts --dry-run
 *
 * Output: a directory of images plus `contact-sheet.html`, because identity
 * retention is a visual judgement and this script does not pretend otherwise.
 * What it *can* measure objectively it reports as numbers, clearly labelled as
 * a proxy rather than an answer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeJpegPreview, decodePng, resize, type RasterImage } from "@seed-ae/media";

const KEY = process.env.ARK_API_KEY ?? "";
const MODEL = (process.env.SEEDREAM_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";
const BASE = process.env.ARK_BASE_URL ?? "";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
/** Recompute the numbers and the sheet over images already paid for. */
const FROM = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
const SHOTS = Number(args[args.indexOf("--shots") + 1]) || 4;

if (!DRY && !FROM && (!KEY || !MODEL || !BASE)) {
  console.error("ARK_API_KEY, SEEDREAM_MODEL_ID and ARK_BASE_URL must be set");
  process.exit(2);
}

/** The character the probe holds constant. Deliberately specific and unusual. */
const CHARACTER = {
  name: "SARA",
  plate:
    "Studio portrait photograph of a woman in her late thirties, Korean-American, " +
    "dark bob haircut cut to the jaw, a faint vertical scar through her left eyebrow, " +
    "wearing an olive canvas field jacket over a grey henley. Neutral expression, " +
    "even soft lighting, plain mid-grey background, sharp focus, full colour.",
  /** The drift-prone details — what a reference reliably loses. */
  driftProne: "dark bob to the jaw, faint scar through the left eyebrow",
};

/** Four shots that change everything except who she is. */
const SHOTS_ALL = [
  "Wide shot, {L} walking away from camera down a wet alley at night, neon signs, handheld.",
  "Close-up, {L} laughing, warm tungsten light from a lamp off to the left.",
  "Low angle, {L} standing on a rooftop at dawn, city skyline behind, wind in her hair.",
  "Medium shot, {L} seated at a diner counter, morning light through a window, looking down.",
  "{L} running through a crowded market, motion blur, midday sun.",
  "{L} lit only by a phone screen in a dark car interior.",
];

/**
 * The two manifests under test.
 *
 * Both say the same thing: image 1 provides this person's face and clothing,
 * and its background must not be used. Only the language and the labelling
 * convention differ.
 */
function englishManifest(): { label: string; block: string } {
  return {
    label: "Image 1",
    block:
      `Materials:\nImage 1 — ${CHARACTER.name}: face and features, and wardrobe. ` +
      `Not its background.\n\nNotes:\n${CHARACTER.name}: ${CHARACTER.driftProne}.`,
  };
}

function chineseManifest(): { label: string; block: string } {
  return {
    label: "@图片1",
    block:
      `【素材职责】\n@图片1用于${CHARACTER.name}的外貌、五官与服装。不采用图片背景。\n\n` +
      `【细节】\n${CHARACTER.name}：${CHARACTER.driftProne}。`,
  };
}

interface Sample {
  shot: number;
  language: "en" | "zh";
  seed: number;
  prompt: string;
  file?: string;
  error?: string;
  distance?: number;
}

async function generate(
  prompt: string,
  seed: number,
  reference?: string,
): Promise<{ bytes: Buffer; url: string }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    prompt,
    seed,
    size: "2K",
    response_format: "url",
    watermark: false,
    sequential_image_generation: "disabled",
  };
  if (reference) body.image = reference;

  const response = await fetch(`${BASE}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(/"message":"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 200));
  }
  const url = JSON.parse(text)?.data?.[0]?.url as string | undefined;
  if (!url) throw new Error(`no url in response: ${text.slice(0, 200)}`);
  const media = await fetch(url);
  return { bytes: Buffer.from(await media.arrayBuffer()), url };
}

/** Bytes decide the format: Ark returns JPEG through a response that never says so. */
function decode(bytes: Buffer): RasterImage | undefined {
  return decodePng(bytes) ?? decodeJpegPreview(bytes);
}

/**
 * A crude appearance distance to the reference plate.
 *
 * Mean absolute difference over a 32x32 downsample, in RGB. This is emphatically
 * **not** an identity metric — it will report a night alley as far from a studio
 * portrait no matter whose face is in it. It is here for one narrow purpose: to
 * compare the EN and ZH images *of the same shot at the same seed* against each
 * other, where lighting and composition are held constant and a difference is
 * more likely to mean something. Even then it is a hint, not a verdict.
 */
function distance(a: RasterImage, b: RasterImage): number {
  const size = 32;
  const left = resize(a, size, size);
  const right = resize(b, size, size);
  let total = 0;
  for (let i = 0; i < size * size * 4; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      total += Math.abs((left.rgba[i + c] ?? 0) - (right.rgba[i + c] ?? 0));
    }
  }
  return total / (size * size * 3);
}

const outDir =
  FROM ??
  path.join(
    process.cwd(),
    ".seed-probes",
    `manifest-language-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

const shots = SHOTS_ALL.slice(0, Math.min(SHOTS, SHOTS_ALL.length));
const samples: Sample[] = [];

console.log(`model:  ${MODEL || "(dry run)"}`);
console.log(`shots:  ${shots.length}`);
console.log(`images: ${shots.length * 2 + 1} (1 plate + ${shots.length} paired A/Bs)`);
console.log(`out:    ${outDir}\n`);

if (DRY) {
  console.log("--- English manifest ---");
  console.log(`${shots[0]?.replace("{L}", englishManifest().label)}\n\n${englishManifest().block}\n`);
  console.log("--- Chinese manifest ---");
  console.log(`${shots[0]?.replace("{L}", chineseManifest().label)}\n\n${chineseManifest().block}\n`);
  console.log("Dry run: nothing was generated and nothing was spent.");
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

if (FROM) {
  /*
   * Rescore. The first run of this probe generated nine correct images and
   * then threw in the distance metric — RasterImage's field is `rgba`, not
   * `data`, and scripts/ was outside the typecheck include so nothing said so.
   * Paying twice for a typo would have been the actual failure.
   */
  const { readFile, readdir } = await import("node:fs/promises");
  const plateBytes = await readFile(path.join(FROM, "plate.jpg"));
  const plateRef = decode(plateBytes);
  const files = await readdir(FROM);
  for (const file of files.filter((name) => /^shot\d+_(en|zh)\.jpg$/.test(name))) {
    const match = /^shot(\d+)_(en|zh)\.jpg$/.exec(file);
    const bytes = await readFile(path.join(FROM, file));
    const image = decode(bytes);
    samples.push({
      shot: Number(match?.[1] ?? 0),
      language: (match?.[2] ?? "en") as "en" | "zh",
      seed: 100_000 + Number(match?.[1] ?? 0),
      prompt: "(rescored)",
      file,
      ...(image && plateRef ? { distance: distance(plateRef, image) } : {}),
    });
  }
  samples.sort((a, b) => a.shot - b.shot || a.language.localeCompare(b.language));
} else {

// The plate. Text-to-image, so the character is the same one every run given
// the same seed, and no external asset is needed.
console.log("generating the reference plate…");
const plate = await generate(CHARACTER.plate, 20260817);
await writeFile(path.join(outDir, "plate.jpg"), plate.bytes);
const plateImage = decode(plate.bytes);
console.log(`  plate.jpg (${plate.bytes.length} bytes)\n`);

for (const [index, shot] of shots.entries()) {
  const seed = 100_000 + index;
  for (const language of ["en", "zh"] as const) {
    const manifest = language === "en" ? englishManifest() : chineseManifest();
    const prompt = `${shot.replace("{L}", manifest.label)}\n\n${manifest.block}`;
    const sample: Sample = { shot: index, language, seed, prompt };
    try {
      const result = await generate(prompt, seed, plate.url);
      const file = `shot${index}_${language}.jpg`;
      await writeFile(path.join(outDir, file), result.bytes);
      sample.file = file;
      const image = decode(result.bytes);
      if (image && plateImage) sample.distance = distance(plateImage, image);
      console.log(`  shot ${index} ${language}: ${file}`);
    } catch (error) {
      sample.error = error instanceof Error ? error.message : String(error);
      console.log(`  shot ${index} ${language}: FAILED — ${sample.error}`);
    }
    samples.push(sample);
  }
}
}

await writeFile(
  path.join(outDir, "samples.json"),
  JSON.stringify({ model: MODEL, character: CHARACTER, samples }, null, 2),
  "utf8",
);

const rows = shots
  .map((shot, index) => {
    const en = samples.find((s) => s.shot === index && s.language === "en");
    const zh = samples.find((s) => s.shot === index && s.language === "zh");
    const cell = (s?: Sample) =>
      s?.file
        ? `<figure><img src="${s.file}"><figcaption>${s.language} · seed ${s.seed}${
            s.distance !== undefined ? ` · Δ${s.distance.toFixed(1)}` : ""
          }</figcaption></figure>`
        : `<figure class="failed">${s?.error ?? "not generated"}</figure>`;
    return `<section><h2>Shot ${index + 1}</h2><p class="shot">${shot.replace(
      "{L}",
      "&lt;label&gt;",
    )}</p><div class="pair">${cell(en)}${cell(zh)}</div></section>`;
  })
  .join("\n");

await writeFile(
  path.join(outDir, "contact-sheet.html"),
  `<!doctype html><meta charset="utf-8"><title>Manifest language A/B</title>
<style>
 body{font:14px/1.5 system-ui;margin:24px;background:#111;color:#eee}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 figure{margin:0}img{width:100%;display:block;border:1px solid #333}
 figcaption{font:12px/1.4 monospace;color:#aaa;padding-top:4px}
 .failed{background:#300;padding:12px;font:12px monospace}
 .shot{color:#9c9;font-style:italic}
 .plate img{max-width:360px}
 h1{font-size:18px} h2{font-size:14px;color:#9cf;margin-bottom:2px}
</style>
<h1>Does an English materials manifest work as well as the Chinese one?</h1>
<p>Left is English (<code>Materials:</code> / <code>Image 1</code>), right is
ByteDance's form (<code>【素材职责】</code> / <code>@图片1</code>). Each pair shares a
reference plate, a shot and a seed, so the language is the only difference.
<b>Δ is a colour-distance proxy, not an identity score</b> — judge the faces
yourself.</p>
<section class="plate"><h2>Reference plate</h2><img src="plate.jpg"></section>
${rows}`,
  "utf8",
);

const ok = samples.filter((s) => s.file).length;
console.log(`\n${ok}/${samples.length} generated`);
console.log(`contact sheet: ${path.join(outDir, "contact-sheet.html")}`);
console.log(
  "\nΔ compares each result to the studio plate and mostly measures lighting,\n" +
    "not identity. Compare the EN and ZH numbers *within* a shot, and trust your\n" +
    "eyes over both. Record the verdict in docs/research/CONSISTENCY_PLATFORMS.md.",
);
