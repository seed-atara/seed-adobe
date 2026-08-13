/**
 * Does Seedance take an audio reference, and in what form?
 *
 * The adapter builds an `audio_url` part with role `reference_audio` because
 * the API named those types when other roles were rejected — but nothing has
 * ever sent one, so `audioReferences: true` in the capabilities is a claim
 * about a part shape rather than a measured behaviour, and the panel offers it
 * on that basis.
 *
 * This asks with a real hosted file. The contract question comes first: an
 * inline data URL is refused for video, so audio probably needs hosting too,
 * and the answer decides whether the capability should be advertised at all.
 *
 * Generates its own tone rather than needing a file to hand — a WAV header and
 * some samples is arithmetic, and what is being tested is the contract, not
 * the music.
 *
 *   npx tsx --env-file=.env scripts/probe-audio-reference.ts [audio.wav|.mp3]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const base = process.env.ARK_BASE_URL ?? "";
const key = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";

if (!base || !key || !model) {
  console.error("Needs ARK_BASE_URL, ARK_API_KEY and SEEDANCE_MODEL_ID.");
  process.exit(1);
}

/** A five-second 220Hz tone: 16-bit mono PCM in a canonical WAV wrapper. */
function tone(seconds = 5, rate = 44100): Buffer {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // Fades in and out so it is not a click at either end.
    const envelope = Math.min(1, i / (rate * 0.1), (samples - i) / (rate * 0.1));
    const value = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.4 * envelope;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const local = process.argv[2];
const bytes = local ? await readFile(local) : tone();
const filename = local ? path.basename(local) : "probe-tone.wav";
const mimeType = filename.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
console.log(`${filename}: ${(bytes.length / 1024).toFixed(0)}KB, ${mimeType}`);

const publisher = new R2Publisher({
  endpoint: process.env.SEED_R2_ENDPOINT ?? "",
  bucket: process.env.SEED_R2_BUCKET ?? "",
  accessKeyId: process.env.SEED_R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.SEED_R2_SECRET_ACCESS_KEY ?? "",
});
const { url } = await publisher.publish({ bytes, filename, mimeType });
console.log("hosted.\n");

const attempts = [
  {
    label: "audio_url + reference_audio, hosted",
    content: [
      { type: "text", text: "a figure walking through an empty hall, in step with the sound" },
      { type: "audio_url", audio_url: { url }, role: "reference_audio" },
    ],
  },
  {
    label: "audio_url + reference_audio, inline data URL",
    content: [
      { type: "text", text: "a figure walking through an empty hall, in step with the sound" },
      {
        type: "audio_url",
        audio_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
        role: "reference_audio",
      },
    ],
  },
  {
    label: "audio_url with no role",
    content: [
      { type: "text", text: "a figure walking through an empty hall" },
      { type: "audio_url", audio_url: { url } },
    ],
  },
];

for (const attempt of attempts) {
  const response = await fetch(`${base}/contents/generations/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      content: attempt.content,
      duration: 5,
      resolution: "480p",
    }),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { id?: string; error?: { code?: string; message?: string } }
    | undefined;

  if (response.ok && payload?.id) {
    console.log(`${attempt.label}: ACCEPTED as ${payload.id}`);
    console.log("  (it passed validation — a running task will be billed)");
  } else {
    const message = (payload?.error?.message ?? "").replace(/\s*Request id:.*$/i, "");
    console.log(`${attempt.label}: HTTP ${response.status} — ${payload?.error?.code}: ${message}`);
  }
}
