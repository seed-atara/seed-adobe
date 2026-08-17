/**
 * Verifies what `output_format` and `resolution` actually deliver.
 *
 * **This one bills.** Every other probe in this repo poisons `duration` so
 * validation fails and no task is created — and that is exactly why it could
 * not answer this question. ByteDance confirmed that `output_format` is acted
 * on at *execution*, never by the request validator, so a nonsense value is
 * never named and a real value is never seen. The only way to know what comes
 * back is to generate something and look at it.
 *
 *   npx tsx --env-file=.env scripts/probe-output-quality.ts --yes
 *   npx tsx --env-file=.env scripts/probe-output-quality.ts --yes --cells 1080p:mov
 *
 * Each cell is one short clip at the cheapest duration. Results are ffprobed
 * and printed as a table to compare against what we were told.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const KEY = process.env.ARK_API_KEY ?? "";
const BASE = process.env.ARK_BASE_URL ?? "";
const MODEL =
  (process.argv.find((a) => a.startsWith("--model="))?.slice(8) ??
    process.env.SEEDANCE_MODEL_ID ??
    "")
    .split(",")[0]
    ?.trim() ?? "";

const args = process.argv.slice(2);
if (!args.includes("--yes")) {
  console.error(
    [
      "This probe creates REAL generations and costs money.",
      "",
      "Every other probe here fails validation on purpose so nothing bills.",
      "That cannot work for output_format, which is acted on at execution.",
      "",
      "Re-run with --yes when you mean it.",
    ].join("\n"),
  );
  process.exit(2);
}
if (!KEY || !BASE || !MODEL) {
  console.error("ARK_API_KEY, ARK_BASE_URL and SEEDANCE_MODEL_ID must be set");
  process.exit(2);
}

/** Cheapest that still exercises the claim: shortest duration, plain prompt. */
const DURATION = 4;
const PROMPT = "a slow push in on a still object, locked off";

const requested =
  args.includes("--cells") ? (args[args.indexOf("--cells") + 1] ?? "") : "";
const CELLS = (requested
  ? requested.split(",")
  : ["1080p:mov", "1080p:mp4", "720p:mov"]
).map((cell) => {
  const [resolution, format] = cell.split(":");
  return { resolution: resolution as string, format: format as string };
});

const outDir = path.join(process.cwd(), ".seed-probes", "output-quality");

async function create(resolution: string, outputFormat: string): Promise<string> {
  const response = await fetch(`${BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      content: [{ type: "text", text: PROMPT }],
      duration: DURATION,
      resolution,
      output_format: outputFormat,
      bitrate_mode: "high",
      generate_audio: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(/"message":"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 200));
  }
  const id = JSON.parse(text)?.id as string | undefined;
  if (!id) throw new Error(`no task id: ${text.slice(0, 200)}`);
  return id;
}

async function await_(taskId: string): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const response = await fetch(`${BASE}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    const payload = (await response.json()) as {
      status?: string;
      content?: { video_url?: string };
      error?: { message?: string };
    };
    if (payload.status === "succeeded" && payload.content?.video_url) {
      return payload.content.video_url;
    }
    if (payload.status === "failed" || payload.status === "cancelled") {
      throw new Error(payload.error?.message ?? `task ${payload.status}`);
    }
  }
  throw new Error("timed out waiting for the task");
}

interface Probed {
  codec: string;
  profile: string;
  pixFmt: string;
  bitDepth: string;
  range: string;
  primaries: string;
  transfer: string;
  matrix: string;
  bitrateMbs: string;
  container: string;
}

async function probe(file: string): Promise<Probed> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries",
    "stream=codec_name,profile,pix_fmt,bits_per_raw_sample,color_range,color_primaries,color_transfer,color_space:format=format_name,bit_rate",
    "-of", "json",
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const stream = parsed.streams?.[0] ?? {};
  const bits = Number(parsed.format?.bit_rate ?? 0);
  const unset = (value: unknown) =>
    value === undefined || value === null || value === "unknown" ? "unset" : String(value);
  return {
    codec: String(stream.codec_name ?? "?"),
    profile: String(stream.profile ?? "?"),
    pixFmt: String(stream.pix_fmt ?? "?"),
    bitDepth: String(stream.bits_per_raw_sample ?? "?"),
    range: unset(stream.color_range),
    primaries: unset(stream.color_primaries),
    transfer: unset(stream.color_transfer),
    matrix: unset(stream.color_space),
    bitrateMbs: bits ? `${(bits / 1_000_000).toFixed(2)} Mb/s` : "?",
    container: String(parsed.format?.format_name ?? "?"),
  };
}

await mkdir(outDir, { recursive: true });
console.log(`model: ${MODEL}`);
console.log(`cells: ${CELLS.map((c) => `${c.resolution}:${c.format}`).join(", ")}`);
console.log(`These are real generations at ${DURATION}s each.\n`);

const rows: Array<{ cell: string; probed?: Probed; error?: string }> = [];

for (const { resolution, format } of CELLS) {
  const cell = `${resolution}:${format}`;
  try {
    console.log(`${cell} — creating…`);
    const taskId = await create(resolution, format);
    console.log(`${cell} — task ${taskId}, waiting…`);
    const url = await await_(taskId);
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const file = path.join(outDir, `${resolution}_${format}.${format}`);
    await writeFile(file, bytes);
    const probed = await probe(file);
    rows.push({ cell, probed });
    console.log(
      `${cell} — ${probed.codec} ${probed.profile}, ${probed.pixFmt}, ${probed.bitrateMbs}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rows.push({ cell, error: message });
    console.log(`${cell} — FAILED: ${message}`);
  }
}

console.log("\n| cell | container | codec / profile | chroma | depth | range / prim / trc / matrix | bitrate |");
console.log("|---|---|---|---|---|---|---|");
for (const row of rows) {
  if (!row.probed) {
    console.log(`| ${row.cell} | — | ${row.error} | | | | |`);
    continue;
  }
  const p = row.probed;
  console.log(
    `| ${row.cell} | ${p.container} | ${p.codec} ${p.profile} | ${p.pixFmt} | ${p.bitDepth} | ${p.range} / ${p.primaries} / ${p.transfer} / ${p.matrix} | ${p.bitrateMbs} |`,
  );
}
console.log(`\nFiles: ${outDir}`);
