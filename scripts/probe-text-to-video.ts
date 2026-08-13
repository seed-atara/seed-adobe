/**
 * What does Seedance accept with no reference at all?
 *
 * Text-to-video is implemented and has never been run: every live check so far
 * went through a frame or a clip, and the API validates parameters per mode.
 * The open questions are whether `ratio` is accepted where no image anchors
 * the shape, whether an ordinary `duration` is taken, and whether the result
 * comes back the shape that was asked for.
 *
 * Costs one generation.
 *
 *   npx tsx --env-file=.env scripts/probe-text-to-video.ts ["prompt"]
 */
const base = process.env.ARK_BASE_URL ?? "";
const key = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";

if (!base || !key || !model) {
  console.error("Needs ARK_BASE_URL, ARK_API_KEY and SEEDANCE_MODEL_ID.");
  process.exit(1);
}

const prompt =
  process.argv[2] ??
  "a slow push through morning fog in a pine forest, low sun, handheld";
const duration = Number(process.argv[3] ?? 5);
const ratio = process.argv[4] ?? "9:16";
const resolution = process.argv[5] ?? "480p";

const body = {
  model,
  content: [{ type: "text", text: prompt }],
  duration,
  ratio,
  resolution,
};
console.log(`duration ${duration}, ratio ${ratio}, resolution ${resolution}`);
console.log(`prompt: ${prompt}\n`);

const response = await fetch(`${base}/contents/generations/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const payload = (await response.json().catch(() => undefined)) as
  | { id?: string; error?: { code?: string; message?: string } }
  | undefined;

console.log(`HTTP ${response.status}`);
if (!response.ok || !payload?.id) {
  console.log(
    `${payload?.error?.code}: ${(payload?.error?.message ?? "").replace(/Request id:.*/i, "")}`,
  );
  process.exit(1);
}

console.log(`task ${payload.id} accepted — polling`);
const startedAt = Date.now();
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const poll = await fetch(`${base}/contents/generations/tasks/${payload.id}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const task = (await poll.json()) as {
    status?: string;
    content?: { video_url?: string };
    error?: { message?: string };
  };
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`  ${elapsed}s ${task.status}`);

  if (task.status === "succeeded") {
    const url = task.content?.video_url as string;
    // Download enough to read the sample description, so the shape it actually
    // came back as is measured rather than assumed from what was asked for.
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const { readMp4Size } = await import("../packages/media/src/mp4.js");
    const size = readMp4Size(bytes);
    console.log(
      `\n${(bytes.length / 1048576).toFixed(2)}MB — ${size?.width}x${size?.height}, ` +
        `${size?.durationSeconds}s`,
    );
    console.log(
      `asked for ratio ${ratio} at ${resolution} for ${duration}s; ` +
        `got ${size ? (size.width / size.height).toFixed(3) : "?"} ` +
        `vs ${(Number(ratio.split(":")[0]) / Number(ratio.split(":")[1])).toFixed(3)}`,
    );
    break;
  }
  if (task.status === "failed" || task.status === "cancelled") {
    console.log(`\n${task.status}: ${(task.error?.message ?? "").replace(/Request id:.*/i, "")}`);
    process.exit(1);
  }
  if (elapsed > 900) {
    console.log("\ngave up after 15 minutes");
    process.exit(1);
  }
}
