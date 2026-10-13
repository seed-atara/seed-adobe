/**
 * Puts the open After Effects project on a shelf, and keeps putting it there.
 *
 *   npx tsx scripts/tidy-project.ts            prints the plan, moves nothing
 *   npx tsx scripts/tidy-project.ts --apply     makes the folders and moves
 *   npx tsx scripts/tidy-project.ts --apply --save   and saves a new version
 *
 * A dry run by default because this rearranges somebody's project, and a
 * plan that cannot be read before it is applied is a plan nobody should run.
 * Every line it prints names the rule that placed the item, so a wrong rule
 * is visible as a wrong reason rather than as a surprise next week.
 *
 * Re-running it is the point. The shelf is a function of the inventory
 * (`planProjectShelf`), so the second run on a sorted project asks for
 * nothing, and the run after the next batch of imports files only the new
 * arrivals. The alternative — tidying by hand — lasts until the next import.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planProjectShelf,
  STATE_INBOX,
  STATES,
  type ProjectItem,
} from "../packages/domain/src/projectShelf.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const save = process.argv.includes("--save");

/*
 * Which state loose items belong to. Only consulted for items that are not
 * already inside a state folder -- anything under STATE2/ is STATE2's
 * whatever this says, because the project is a better record of what an item
 * is for than a flag typed at a shell.
 */
const stateArg = process.argv.indexOf("--state");
const state = stateArg >= 0 ? process.argv[stateArg + 1] : undefined;
if (state !== undefined && !STATES.includes(state as never)) {
  console.error(`--state must be one of ${STATES.join(", ")}`);
  process.exit(2);
}

const env = Object.fromEntries(
  (await readFile(path.join(root, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const base = `http://${env.SEED_AE_HOST ?? "127.0.0.1"}:${env.SEED_AE_PORT ?? "47831"}`;
const token = env.SEED_AE_SESSION_TOKEN;
if (!token) {
  console.error("SEED_AE_SESSION_TOKEN is not in .env");
  process.exit(1);
}

/** One host command, failing loudly rather than returning something unusable. */
async function host(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const payload = (await response.json()) as { ok?: boolean; value?: unknown; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(`${name}: ${payload.error ?? response.statusText}`);
  }
  return payload.value;
}

const inventory = (await host("projectItems")) as { count: number; items: ProjectItem[] };
const plan = planProjectShelf(inventory.items, state ? { state } : {});

const atRoot = inventory.items.filter((item) => item.folder === "").length;
console.log(
  `${inventory.count} items, ${atRoot} of them loose in the root.\n` +
    `${plan.folders.length} folders, ${plan.moves.length} moves, ` +
    `${plan.alreadySorted} already in place, ${plan.leftInPlace} left in drawers ` +
    `somebody else made, ${plan.unsorted.length} unsorted.\n`,
);

/** The plan as a tree, which is the shape the Project panel will be in. */
const byFolder = new Map<string, string[]>();
for (const move of plan.moves) {
  const into = byFolder.get(move.folder) ?? [];
  into.push(`${move.expectName}   — ${move.reason}`);
  byFolder.set(move.folder, into);
}
for (const folder of plan.folders) {
  const contents = byFolder.get(folder);
  const depth = folder.split("/").length - 1;
  console.log(`${"    ".repeat(depth)}${folder.split("/").pop()}/`);
  for (const line of contents ?? []) console.log(`${"    ".repeat(depth + 1)}${line}`);
}

if (plan.unsorted.length) {
  console.log("\nLeft where they are, because no rule claimed them:");
  for (const item of plan.unsorted) console.log(`    ${item.kind.padEnd(12)} ${item.name}`);
}

console.log(
  `\nNew artwork for a state goes in its ${STATE_INBOX}: ` +
    `${STATES.map((s) => `${s}/${STATE_INBOX}`).join(", ")}. ` +
    `Import into one of those and re-run — the state is read from the folder ` +
    `it is in, not from a flag, so nothing can be filed into the wrong look ` +
    `by forgetting an argument.`,
);

if (!apply) {
  console.log(`\nNothing was moved. Re-run with --apply${state ? ` --state ${state}` : ""}.`);
  process.exit(0);
}

const made = (await host("createFolders", { paths: plan.folders })) as {
  made: unknown[];
  existing: unknown[];
};
console.log(`\n${made.made.length} folders made, ${made.existing.length} already there.`);

if (plan.moves.length) {
  const result = (await host("moveItems", {
    moves: plan.moves.map(({ itemId, folder, expectName }) => ({ itemId, folder, expectName })),
  })) as {
    movedCount: number;
    refusedCount: number;
    alreadyThere: number;
    refused: Array<{ name?: string; reason: string }>;
  };
  console.log(
    `${result.movedCount} moved, ${result.alreadyThere} already there, ` +
      `${result.refusedCount} refused.`,
  );
  for (const refusal of result.refused) {
    console.log(`    refused: ${refusal.name ?? "?"} — ${refusal.reason}`);
  }
}

// Re-read rather than trust the move report: the only claim worth making is
// what the project looks like now.
const after = planProjectShelf(
  ((await host("projectItems")) as { items: ProjectItem[] }).items,
);
const looseAfter = ((await host("projectItems")) as { items: ProjectItem[] }).items.filter(
  (item) => item.folder === "" && item.kind !== "folder",
).length;
console.log(
  `\nAfter: ${after.moves.length} moves still wanted, ` +
    `${looseAfter} non-folder items left in the root.`,
);

if (save) {
  const version = (await host("saveVersion", { label: "tidy" })) as { path?: string };
  console.log(`Saved ${version.path ?? "a new version"}`);
}
