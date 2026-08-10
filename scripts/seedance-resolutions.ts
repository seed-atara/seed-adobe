/**
 * Establishes which resolutions each Seedance model accepts.
 *
 * Every probe carries `duration: 3`, which is rejected, so validation always
 * fails and no billable task is created. The catch is that when two parameters
 * are both invalid the API reports only one of them, and *which* one varies
 * between identical requests — a nonsense resolution came back as a duration
 * complaint 3 times in 10.
 *
 * So each combination is asked repeatedly. A resolution the model does not
 * accept will be named sooner or later; one that is never named across N tries
 * is accepted. Raise ATTEMPTS to tighten the confidence.
 *
 *   npx tsx --env-file=.env scripts/seedance-resolutions.ts
 */

const KEY = process.env.ARK_API_KEY ?? "";
const BASE = process.env.ARK_BASE_URL ?? "";

if (!KEY || !BASE) {
  console.error("ARK_API_KEY and ARK_BASE_URL must be set");
  process.exit(2);
}

const MODELS = (
  process.env.SEEDANCE_MODEL_ID ??
  "dreamina-seedance-2-5-260628,dreamina-seedance-2-0-260128"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const CANDIDATES = ["480p", "720p", "1080p", "1440p", "2160p", "2k", "2K", "4k", "4K"];
const ATTEMPTS = 8;

/** A 1x1 PNG — the smallest thing that is unarguably an image. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function complaint(model: string, resolution: string): Promise<string> {
  const response = await fetch(`${BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      content: [
        { type: "text", text: "a slow push in" },
        { type: "image_url", image_url: { url: PIXEL }, role: "first_frame" },
      ],
      duration: 3,
      resolution,
    }),
  });

  if (response.ok) return "accepted-task";
  const text = await response.text();
  const message = (/"message":"([^"]+)"/.exec(text) ?? [, ""])[1] ?? "";
  if (/resolution/i.test(message)) return "resolution";
  if (/duration/i.test(message)) return "duration";
  return "other";
}

for (const model of MODELS) {
  const accepted: string[] = [];
  const refused: string[] = [];

  for (const resolution of CANDIDATES) {
    let named = false;
    for (let attempt = 0; attempt < ATTEMPTS && !named; attempt += 1) {
      const result = await complaint(model, resolution);
      if (result === "accepted-task") {
        console.error(`!! ${model} ${resolution} created a task — this bills`);
        named = true;
      }
      if (result === "resolution") named = true;
    }
    (named ? refused : accepted).push(resolution);
  }

  console.log(model);
  console.log("  accepted:", accepted.join(", ") || "(none)");
  console.log("  refused: ", refused.join(", ") || "(none)");
}
