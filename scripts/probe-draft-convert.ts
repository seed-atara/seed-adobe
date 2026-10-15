/**
 * What is the real contract for turning a Seedance draft into the full render?
 *
 *   npx tsx --env-file=.env scripts/probe-draft-convert.ts <draft-task-id>
 *
 * Draft mode is real and we had been defaulting it off: every Seedance task
 * response this project has stored echoes `"draft": false` at the top level,
 * beside `resolution`, `seed`, `service_tier` and `priority`. The API has been
 * telling us the field exists since the first generation.
 *
 * What the echo does not give is the *second* half — the call that takes a
 * finished draft and renders it at full resolution with the same content. A
 * third-party reference describes it as needing `model` and `source_task_id`,
 * but that reference documents its own wrapper API (it calls the resolution
 * field `quality` and the aspect `aspect_ratio`, where Ark uses `resolution`
 * and `ratio`), so its field names cannot be trusted for this endpoint.
 * ModelArk's own pages render their parameter tables with JavaScript and a
 * fetch returns only navigation.
 *
 * So ask the API. An unknown path, an unknown field and a known field with a
 * bad value all answer differently, and the error text is the documentation.
 * Nothing here can start a billable render: every candidate either names a path
 * that does not exist, or references a draft task id, which costs nothing until
 * a conversion is actually accepted — and the one that IS accepted is reported
 * rather than confirmed, so this never spends by accident.
 */
const key = process.env.ARK_API_KEY;
const base = process.env.ARK_BASE_URL ?? "https://ark.ap-southeast.bytepluses.com/api/v3";
const draftId = process.argv[2];

if (!key) throw new Error("ARK_API_KEY is not set");
if (!draftId) {
  console.error("usage: probe-draft-convert.ts <draft-task-id>  (e.g. cgt-2026...)");
  process.exit(2);
}

/*
 * SEEDANCE_MODEL_ID holds a comma-separated LIST of the models the service
 * offers, not one id. Sending the whole string asks Ark for a model whose name
 * is four names, and it answers InvalidEndpointOrModel.NotFound -- a real error
 * about the wrong thing, which would have been easy to read as "the endpoint
 * does not exist".
 */
const MODEL =
  (process.env.SEEDANCE_MODEL_ID ?? "dreamina-seedance-2-5-260628").split(",")[0]!.trim();

/**
 * Candidates, cheapest-to-be-wrong first.
 *
 * `dryRun` marks the ones that would actually start a render if the contract is
 * right. Those are listed but NOT sent unless `--spend` is passed, because the
 * point of this probe is to learn the shape without paying for it.
 */
const candidates: Array<{
  what: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  spends: boolean;
}> = [
  {
    what: "GET the draft task, to see what fields it reports when finished",
    method: "GET",
    path: `/contents/generations/tasks/${draftId}`,
    spends: false,
  },
  {
    what: "POST tasks with source_task_id (the shape the third-party doc describes)",
    method: "POST",
    path: "/contents/generations/tasks",
    body: { model: MODEL, source_task_id: draftId },
    spends: true,
  },
  {
    what: "POST tasks with draft_task_id instead",
    method: "POST",
    path: "/contents/generations/tasks",
    body: { model: MODEL, draft_task_id: draftId },
    spends: true,
  },
  {
    what: "POST a dedicated convert path under the task",
    method: "POST",
    path: `/contents/generations/tasks/${draftId}/convert`,
    body: { model: MODEL },
    spends: true,
  },
  {
    what: "POST a drafts collection convert path",
    method: "POST",
    path: `/contents/generations/drafts/${draftId}/convert`,
    body: { model: MODEL },
    spends: true,
  },
  {
    what: "POST tasks with an obviously bad source id, to read the field's own error",
    method: "POST",
    path: "/contents/generations/tasks",
    body: { model: MODEL, source_task_id: "cgt-does-not-exist-000000" },
    spends: false,
  },
];

const spend = process.argv.includes("--spend");
console.log(`base ${base}`);
console.log(`model ${MODEL}`);
console.log(`draft ${draftId}`);
console.log(spend ? "\n--spend: billable candidates WILL be sent\n" : "\nread-only candidates only; pass --spend to try the rest\n");

for (const candidate of candidates) {
  if (candidate.spends && !spend) {
    console.log(`SKIP  ${candidate.method} ${candidate.path}`);
    console.log(`      ${candidate.what} (would start a render; --spend to try)\n`);
    continue;
  }
  try {
    const response = await fetch(`${base}${candidate.path}`, {
      method: candidate.method,
      headers: {
        // Never logged. CLAUDE.md: redact Authorization headers.
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(candidate.body ? { body: JSON.stringify(candidate.body) } : {}),
    });
    const text = await response.text();
    console.log(`${String(response.status).padEnd(4)} ${candidate.method} ${candidate.path}`);
    console.log(`      ${candidate.what}`);
    console.log(`      ${text.slice(0, 600).replace(/\s+/g, " ")}\n`);
  } catch (error) {
    console.log(`ERR  ${candidate.method} ${candidate.path}`);
    console.log(`      ${(error as Error).message}\n`);
  }
}
