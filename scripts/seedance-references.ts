/**
 * Finds out how many image references Seedance actually accepts.
 *
 * Seedance 2.5's multi-reference support is described in launch material but
 * not in any API reference we can read, and `CLAUDE.md` forbids hard-coding a
 * contract that has not been verified. So it is measured instead.
 *
 * Every probe carries `duration: 3`, which this model is known to reject. A
 * request that fails validation never becomes a task, so nothing here is
 * billable — and whichever complaint comes back tells us what we need:
 *
 *   - a complaint about duration  → the reference count got that far unopposed
 *   - a complaint about the images → that count is over the limit
 *
 *   npx tsx --env-file=.env scripts/seedance-references.ts
 */

const KEY = process.env.ARK_API_KEY ?? "";
const MODEL = process.env.SEEDANCE_MODEL_ID ?? "";
const BASE = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";

if (!KEY || !MODEL) {
  console.error("ARK_API_KEY and SEEDANCE_MODEL_ID must be set");
  process.exit(2);
}

/** A 1x1 PNG — the smallest thing that is unarguably an image. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const COUNTS = [1, 2, 4, 8, 12, 16, 24, 30, 40];

async function probe(count: number): Promise<string> {
  const content: unknown[] = [{ type: "text", text: "a slow push in" }];
  for (let i = 0; i < count; i += 1) {
    content.push({ type: "image_url", image_url: { url: PIXEL } });
  }

  const response = await fetch(`${BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    // 3 seconds is refused by this model, so validation can never pass.
    body: JSON.stringify({ model: MODEL, content, duration: 3 }),
  });

  const text = await response.text();
  if (response.ok) {
    // Should be unreachable; if it ever happens, say so loudly — that is a
    // real task, and it bills.
    return `ACCEPTED (${response.status}) — a task may have been created: ${text.slice(0, 200)}`;
  }

  const message = /"message":"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 200);
  return `${response.status} ${message}`;
}

for (const count of COUNTS) {
  const result = await probe(count);
  const verdict = /duration|frames|3s|second/i.test(result)
    ? "references OK"
    : "← reference count refused";
  console.log(String(count).padStart(3), "refs:", result);
  console.log("     ", verdict);
}
