/**
 * Lays each party-city loop into its region, three times, to tile the 30s comp.
 *
 *   npx tsx scripts/insert-partycity-loops.ts "SEED Region 5=ast_abc" ...
 *   npx tsx scripts/insert-partycity-loops.ts "SEED Region 6=ast_a@0,ast_b@10,ast_a@20"
 *
 * One asset means the same ten seconds three times. The `@` form places named
 * clips at named starts, which is what an A-B-A thirty seconds needs: the
 * gentle pass on 0-10 and 20-30 with the big dim on 10-20, so the dim is a
 * deliberate beat in the middle rather than the character of the whole loop.
 * Every pass has to close on the plate for that to work -- each does, since
 * `loop` puts the same still in both frame slots -- which is what makes the
 * joins at 10s and 20s and the wrap at 30s all land on the same frame.
 *
 * `insertRegion` adds one layer at one start time and re-places the composite in
 * the parent, so three calls per region give the three passes at 0s, 10s and
 * 20s. It needs `gyg_SIDESpartycity2_left6` to be the active comp — it resolves
 * the region by name against whatever is in front — and that comp is 6688x1912,
 * so this does NOT set it: if it is not already active the host says so and
 * nothing is changed. Opening it is a render, and the whole point of the
 * `compId` work was to stop needing one.
 *
 * ## Feather
 *
 * These regions are opaque windows of a painting, not elements with alpha, so
 * the only thing hiding the join is the composite's feather. Too little and the
 * generated rectangle reads as a patch; too much and the static plate bleeds
 * back over the lanterns nearest the edge and damps the flicker that was paid
 * for. 24px on the three large regions, 12px on region 8 at 742px wide — the
 * same fraction of the shorter side, give or take.
 */
const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;

if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

const pairs = process.argv.slice(2).filter((a) => a.includes("="));
if (!pairs.length) {
  console.error('usage: insert-partycity-loops.ts "SEED Region 5=ast_..." ...');
  process.exit(2);
}

/** The three passes that tile 30 seconds. */
const STARTS = [0, 10, 20] as const;

/** `ast_a@0,ast_b@10,ast_a@20` -> the passes to place, in order. */
function passesOf(spec: string): Array<{ assetId: string; startSeconds: number }> {
  if (!spec.includes("@")) {
    return STARTS.map((startSeconds) => ({ assetId: spec, startSeconds }));
  }
  return spec.split(",").map((part) => {
    const at = part.lastIndexOf("@");
    const assetId = part.slice(0, at).trim();
    const startSeconds = Number(part.slice(at + 1));
    if (!assetId || !Number.isFinite(startSeconds)) {
      throw new Error(`cannot read "${part}" as asset@seconds`);
    }
    return { assetId, startSeconds };
  });
}

async function host(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(raw) as { ok?: boolean; error?: unknown; value?: unknown };
  /*
   * The host answers HTTP 200 with its own envelope, so a refused command and a
   * successful one arrive with the same status. Checking only the status is how
   * an insert of an asset id that does not exist printed "placed" three times.
   */
  if (parsed.ok === false) {
    throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  }
  return parsed;
}

for (const pair of pairs) {
  const at = pair.indexOf("=");
  const regionName = pair.slice(0, at).trim();
  const passes = passesOf(pair.slice(at + 1).trim());
  // The smallest regions get proportionally less, so the static plate does not
  // bleed back over the lanterns nearest their edge and damp the flicker.
  const feather = /Region (8|9)$/.test(regionName) ? 12 : 24;

  console.log(`\n${regionName}  ${passes.length} passes  feather ${feather}px`);
  for (const { assetId, startSeconds } of passes) {
    try {
      const placed = (await host("insertRegion", {
        assetId,
        regionName,
        featherPixels: feather,
        startSeconds,
      })) as { value?: { layer?: { index?: number }; composite?: unknown } };
      const index = placed.value?.layer?.index;
      console.log(
        `  ${String(startSeconds).padStart(2)}s  ${assetId.slice(0, 12)}  ` +
          `placed${index ? ` at index ${index}` : ""}`,
      );
    } catch (error) {
      console.error(`  ${String(startSeconds).padStart(2)}s  FAILED: ${(error as Error).message}`);
    }
  }
}
