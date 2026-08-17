/**
 * Finds out whether Seedance really takes `output_format` and `bitrate_mode`.
 *
 * ByteDance told us a less-compressed MOV can be used instead of the compressed
 * MP4, and third-party documentation names `output_format: "mov"` carrying
 * `yuv444p` or `yuv444p10le`, plus `bitrate_mode` at CRF 18 / CRF 11. None of
 * that is official and `CLAUDE.md` forbids building on an unverified contract —
 * and the same source lists 4K among 2.5's resolutions, which our own probing
 * has already disproved. So it is measured before it is used.
 *
 * If real, this settles something MODEL_API_NOTES currently records as
 * unfixable: 4:2:0 chroma halves the colour resolution, which is why pixel
 * accuracy is not available through an H.264 delivery. yuv444p has no
 * subsampling at all.
 *
 * Method, from `scripts/seedance-references.ts`: every probe carries a duration
 * this model rejects, so validation always fails and no billable task is ever
 * created. The complaint that comes back is the evidence.
 *
 * The informative probe is an unknown **value**, not an unknown field — an
 * unrecognised field is usually ignored in silence, while a recognised field
 * given nonsense gets named. And it is repeated, because when two parameters
 * are invalid the API names only one of them and picks inconsistently: a single
 * silent pass is not evidence of anything.
 *
 *   npx tsx --env-file=.env scripts/probe-output-format.ts
 */

const KEY = process.env.ARK_API_KEY ?? "";
/*
 * SEEDANCE_MODEL_ID may hold a comma-separated list — the service offers each
 * as its own provider. Sending the list is not a model id, and every request
 * dies at model resolution before any parameter is looked at, which produces a
 * page of confident-looking nothing. Take the first, or --model.
 */
const MODEL = (
  process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ??
  process.env.SEEDANCE_MODEL_ID ??
  ""
)
  .split(",")[0]
  ?.trim() ?? "";
const BASE = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";

if (!KEY || !MODEL) {
  console.error("ARK_API_KEY and SEEDANCE_MODEL_ID must be set");
  process.exit(2);
}

/** Enough repetitions that a field read but not named is very unlikely. */
const REPEATS = 8;

/** A duration this model refuses, so validation can never pass. */
const POISON_DURATION = 3;

interface Probe {
  label: string;
  body: Record<string, unknown>;
  /** What a complaint naming this parameter looks like. */
  names: RegExp;
}

const PROBES: Probe[] = [
  /*
   * `file_format` is the real name. `output_format` came from third-party
   * documentation and is not read by this API at all, which is why the first
   * pass of this probe concluded there was no container parameter — it was
   * asking about a field that does not exist, and getting silence.
   *
   * Sweep the plausible names rather than trusting one: the cost is a few
   * unbillable requests and the alternative is a confident negative.
   */
  {
    label: 'file_format: "banana"    (THE REAL FIELD — is it read?)',
    body: { file_format: "banana" },
    names: /file_format/i,
  },
  {
    label: 'file_format: "mov"       (the one that matters)',
    body: { file_format: "mov" },
    names: /file_format/i,
  },
  {
    label: 'file_format: "mp4"       (control)',
    body: { file_format: "mp4" },
    names: /file_format/i,
  },
  {
    label: 'output_format: "banana"  (third-party name — expected dead)',
    body: { output_format: "banana" },
    names: /output_format|output format/i,
  },
  {
    label: 'output_format: "mov"     (is the value accepted?)',
    body: { output_format: "mov" },
    names: /output_format|output format/i,
  },
  {
    label: 'output_format: "mp4"     (control — should be accepted)',
    body: { output_format: "mp4" },
    names: /output_format|output format/i,
  },
  {
    label: 'bitrate_mode: "banana"   (is the field read at all?)',
    body: { bitrate_mode: "banana" },
    names: /bitrate_mode|bitrate|bit rate/i,
  },
  {
    label: 'bitrate_mode: "high"     (is the value accepted?)',
    body: { bitrate_mode: "high" },
    names: /bitrate_mode|bitrate|bit rate/i,
  },
  {
    label: "return_last_frame: true  (a real poster, for nothing?)",
    body: { return_last_frame: true },
    names: /return_last_frame|last frame/i,
  },
  {
    label: 'bitrate_mode: "standard" (the other documented value)',
    body: { bitrate_mode: "standard" },
    names: /bitrate_mode|bitrate|bit rate/i,
  },
  {
    label: 'bitrate_mode: "low"      (undocumented — expected to be refused)',
    body: { bitrate_mode: "low" },
    names: /bitrate_mode|bitrate|bit rate/i,
  },
  {
    label: 'return_last_frame: "x"   (a boolean has no nonsense value; a string does)',
    body: { return_last_frame: "banana" },
    names: /return_last_frame|last frame/i,
  },
  // If output_format existed under another name, one of these would be named.
  {
    label: 'container: "banana"      (alternative name for the same idea)',
    body: { container: "banana" },
    names: /container/i,
  },
  {
    label: 'video_format: "banana"   (alternative name)',
    body: { video_format: "banana" },
    names: /video_format/i,
  },
  {
    label: 'pixel_format: "yuv444p"  (guessed name — expected to be ignored)',
    body: { pixel_format: "yuv444p" },
    names: /pixel.?format/i,
  },
];

/*
 * A reply that never reached parameter validation proves nothing about
 * parameters. Detecting it explicitly, because the alternative is reading eight
 * identical "does not exist" messages as eight measurements.
 */
function isPreValidation(message: string): boolean {
  return /does not exist or you do not have access|invalid api key|unauthor/i.test(message);
}

async function send(extra: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      content: [{ type: "text", text: "a slow push in" }],
      duration: POISON_DURATION,
      ...extra,
    }),
  });

  const text = await response.text();
  if (response.ok) {
    // Should be unreachable. If it happens, a real task exists and it bills.
    return `ACCEPTED (${response.status}) — A TASK MAY HAVE BEEN CREATED: ${text.slice(0, 300)}`;
  }
  return /"message":"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 300);
}

console.log(`model: ${MODEL}`);
console.log(`base:  ${BASE}`);
console.log(
  `\nEvery request carries duration=${POISON_DURATION}, which this model refuses, so nothing here bills.\n`,
);

for (const probe of PROBES) {
  const messages: string[] = [];
  let named = 0;
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const message = await send(probe.body);
    messages.push(message);
    if (probe.names.test(message)) named += 1;
    if (message.startsWith("ACCEPTED")) break;
  }

  const unique = [...new Set(messages)];
  const blocked = messages.some(isPreValidation);
  const verdict = blocked
    ? "INCONCLUSIVE — the request never reached parameter validation"
    : named > 0
      ? `READ — named in ${named}/${messages.length} tries`
      : `never named in ${messages.length} tries — either accepted, or ignored as unknown`;

  console.log(probe.label);
  console.log(`  ${verdict}`);
  for (const message of unique.slice(0, 3)) console.log(`    · ${message}`);
  console.log();
}

console.log(
  [
    "How to read this:",
    "  · a nonsense value that IS named  → the field exists and is validated",
    "  · a nonsense value never named    → the field is unknown and ignored",
    "  · a real value never named, where the nonsense one was → accepted",
    "",
    "Only the third line justifies changing a default. Record the outcome in",
    "docs/research/MODEL_API_NOTES.md with today's date either way.",
  ].join("\n"),
);
