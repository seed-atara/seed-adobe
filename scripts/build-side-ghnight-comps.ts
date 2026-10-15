/**
 * Builds the two side comps for the golden-hour-to-night transition.
 *
 *   npx tsx scripts/build-side-ghnight-comps.ts            # report what it would do
 *   npx tsx scripts/build-side-ghnight-comps.ts --apply
 *
 * The PROS transition lives in comp 2053 as a stack: the golden-hour plate at
 * the bottom, the night plate above it, the generated clip between them, and
 * the foreground object on top. The sides get the same shape, one comp each,
 * so a side can be judged, re-rolled and re-timed without touching the other.
 *
 * ## There is no createComp host command, and precompose is one
 *
 * Nothing in the host makes a composition from nothing. `precompose` does: it
 * groups layers of the *active* comp into a new comp that inherits the active
 * comp's width, height, frame rate and duration. So a 6688x1912 30s side comp
 * is made by inserting the golden plate into any existing 6688x1912 30s comp,
 * precomposing that one layer, and then removing the precomp layer the
 * operation left behind in the host comp.
 *
 * The host is deliberately a comp in `_INBOX` rather than one in `00_DELIVERY`:
 * the layer is added and removed again so the net change is nothing, but the
 * net change being nothing is a claim about correctness and the delivery comps
 * are not where to test it.
 *
 * ## What it does NOT do
 *
 * It does not place a transition clip, because at the time of writing none has
 * been generated. The comps are built plates-only and in the right order, so a
 * clip drops in as a new top layer with no re-layout. `insert-daynight-
 * transition.ts` is the script that does that for the proscenium.
 */
import path from "node:path";

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
const apply = process.argv.includes("--apply");
const root = path.resolve(process.cwd());

/** A 6688x1912 30s comp in _INBOX, used only as a host for the precompose. */
const HOST_COMP = "1720";

interface Side {
  name: string;
  comp: string;
  golden: string;
  night: string;
}

const SIDES: Side[] = [
  {
    name: "LEFT",
    comp: "GYG_SIDES_LEFT_gh_to_night",
    golden: ".work/ghsides/GYG_02_GOLDEN_HOUR_LEFT_WALL.png",
    // Registered, not as delivered: the delivered night left wall is drawn
    // 0.941x the golden one vertically, measured at 0.72-0.95 patch
    // correlation across five heights and five widths. Transitioning between
    // them as delivered would squash the arcade 6% over the shot.
    night: ".work/ghsides/LEFT_night_registered.png",
  },
  {
    name: "RIGHT",
    comp: "GYG_SIDES_RIGHT_gh_to_night",
    golden: ".work/ghsides/GYG_02_GOLDEN_HOUR_RIGHT_WALL.png",
    night: ".work/sides/RIGHT_night.png", // already in register, 0.998x
  },
];

async function api(route: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${route}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

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
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(raw) as {
    ok?: boolean;
    error?: unknown;
    value?: unknown;
  };
  if (parsed.ok === false)
    throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return (parsed.value ?? parsed) as any;
}

if (!apply) {
  console.log("would build, from the plates on disk:\n");
  for (const side of SIDES) {
    console.log(`  ${side.comp}  6688x1912, 30s`);
    console.log(`    layer 2  ${path.basename(side.golden)}   (held, the shot starts here)`);
    console.log(`    layer 1  ${path.basename(side.night)}   (held, the shot ends here)`);
  }
  console.log(`\nhost comp for the precompose: ${HOST_COMP}`);
  console.log("\n--apply to build them.");
  process.exit(0);
}

if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

for (const side of SIDES) {
  console.log(`\n=== ${side.name}`);

  // There is no importMedia host command; the service adopts the file into the
  // asset library and insertIntoComp takes the asset id from there.
  const golden = await api("/v1/assets/adopt", {
    path: path.join(root, side.golden),
  });
  const night = await api("/v1/assets/adopt", {
    path: path.join(root, side.night),
  });
  const goldenId = String(golden.asset?.id ?? golden.id ?? "");
  const nightId = String(night.asset?.id ?? night.id ?? "");
  console.log(
    `  adopted ${path.basename(side.golden)} -> ${goldenId}
` +
      `          ${path.basename(side.night)} -> ${nightId}`,
  );

  await host("setActiveComp", { compId: HOST_COMP });
  const placed = await host("insertIntoComp", {
    assetId: goldenId,
    startSeconds: 0,
    fit: "none",
    name: `${side.name}_golden`,
  });
  const created = await host("precompose", {
    layerIndexes: [placed.layer?.index ?? 1],
    name: side.comp,
    moveAllAttributes: true,
  });
  console.log(
    `  precomposed -> comp ${created.comp.id} "${created.comp.name}" ` +
      `${created.comp.width}x${created.comp.height} ${created.comp.durationSeconds}s`,
  );

  // Take the precomp layer back out of the host comp, so the host is unchanged.
  await host("deleteLayer", {
    layerIndex: created.placedAtIndex ?? 1,
    expectName: created.comp.name,
    compId: HOST_COMP,
  });

  await host("setActiveComp", { compId: created.comp.id });
  await host("insertIntoComp", {
    assetId: nightId,
    startSeconds: 0,
    fit: "none",
    name: `${side.name}_night`,
  });

  const tree = await host("compTree", { compId: created.comp.id, maxDepth: 1 });
  for (const layer of tree.layers ?? [])
    console.log(`    ${layer.index}  ${layer.name}`);
}

console.log(
  "\nBuilt. Both comps hold the two plates in the right order; the generated\n" +
    "transition goes in as a new top layer.",
);
