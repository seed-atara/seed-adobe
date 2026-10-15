/**
 * Names the five states after the five scenes, and files each comp under its own.
 *
 *   npx tsx scripts/organise-gyg-scenes.ts            # print the plan
 *   npx tsx scripts/organise-gyg-scenes.ts --apply
 *   npx tsx scripts/organise-gyg-scenes.ts --apply --save
 *
 * `tidy-project.ts` builds the shelf -- 00_DELIVERY, 10_ELEMENTS, 20_GENERIC,
 * 90_ARCHIVE, _INBOX inside each state -- and it did its job: the project root
 * holds nothing but `SEED` and the five states. What it could not do is say
 * what a state IS, because the states were created as STATE1..STATE5 before
 * anybody knew how many scenes there would be, and a folder called STATE3 tells
 * a reader nothing about whether the night transition is in it.
 *
 * The delivery folder is the authority on that. It holds exactly five scenes:
 *
 *     01_ANNUAL_SUMMIT  02_GOLDEN_HOUR  03_GOLDEN_HOUR_SPEECH
 *     04_TRANSITION_NIGHT  05_PARTY_CITY
 *
 * so the project uses those names, and a comp goes in the scene it belongs to
 * rather than the scene whose comp it was precomposed out of -- which is how
 * two golden-hour-to-night side comps ended up living under party city.
 *
 * ## Why the state numbers do not simply shift up
 *
 * STATE3 already holds the night transition and STATE4 already holds party
 * city, so renaming them 03 and 04 would have meant moving both scenes' worth
 * of artwork to keep the numbers honest. STATE5 was empty. Giving the empty
 * one to the golden-hour speech and naming the other four after what they
 * already contain moves two comps instead of forty, and the Project panel
 * sorts by name regardless of which folder was made first.
 *
 * ## Renames need a panel that knows `renameItems`
 *
 * The host command is new. After Effects runs a *copy* of the panel, so until
 * `npm run install:extension` has run and the panel has been reopened, the
 * renames are refused with "the panel has no handler for renameItems". That is
 * reported and the moves still apply -- the two halves are independent, and
 * half a tidy that says which half it did is better than a tidy that stops.
 */
import path from "node:path";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const save = argv.includes("--save");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;

interface HostResult {
  ok?: boolean;
  error?: unknown;
  value?: unknown;
}

/** Returns the error instead of throwing, so one missing command is survivable. */
async function tryHost(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ value?: any; error?: string }> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const raw = await response.text();
  if (!response.ok) return { error: `${name}: ${raw.slice(0, 300)}` };
  const parsed = JSON.parse(raw) as HostResult;
  if (parsed.ok === false)
    return { error: typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error) };
  return { value: parsed.value ?? parsed };
}

async function host(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { value, error } = await tryHost(name, args);
  if (error) throw new Error(`${name}: ${error}`);
  return value;
}

/** STATE folder -> the scene it is being named after, and why that one. */
const SCENES: Array<{ was: string; now: string; because: string }> = [
  { was: "STATE1", now: "01_ANNUAL_SUMMIT", because: "holds the summit artwork and every animated entity" },
  { was: "STATE2", now: "02_GOLDEN_HOUR", because: "holds the golden-hour proscenium" },
  { was: "STATE5", now: "03_GOLDEN_HOUR_SPEECH", because: "was empty; the speech scene goes here" },
  { was: "STATE3", now: "04_TRANSITION_NIGHT", because: "already holds the night proscenium" },
  { was: "STATE4", now: "05_PARTY_CITY", because: "already holds the party city sides" },
];

/**
 * Comps, by the name they have now, with the scene and the name they should have.
 *
 * `gyg_SIDESpartycity2_left6` is a real comp name in this project and says
 * nothing true about what it is: it is the left wall of party city, and the 2
 * and the 6 are the number of times somebody duplicated something. The scheme
 * is `GYG_<scene number>_<SCENE>_<SURFACE>[_<what it does>]`, which sorts into
 * show order and reads in one glance.
 *
 * `folder` is relative to the scene, so the rename and the move are described
 * once each and cannot disagree.
 */
const COMPS: Array<{
  id: string;
  was: string;
  now?: string;
  scene: string;
  folder: string;
  note?: string;
}> = [
  // 01 ANNUAL SUMMIT -- the delivered side walls, newest first.
  { id: "1081", was: "GYG_Sides-Left_v002", now: "GYG_01_SUMMIT_LEFT_v002", scene: "STATE1", folder: "00_DELIVERY" },
  { id: "636", was: "GYG_Sides-Right_v001", now: "GYG_01_SUMMIT_RIGHT_v001", scene: "STATE1", folder: "00_DELIVERY" },
  { id: "503", was: "GYG_Sides-Left_v001", now: "GYG_01_SUMMIT_LEFT_v001", scene: "STATE1", folder: "90_ARCHIVE", note: "superseded by v002, kept" },
  { id: "157", was: "GYG_RIGHT_PSD", now: "GYG_01_SUMMIT_RIGHT_psd", scene: "STATE1", folder: "20_GENERIC/plates", note: "the PSD as imported, not a delivery comp" },

  // 02 GOLDEN HOUR
  { id: "1398", was: "gyg_gh_pros_pano_3", now: "GYG_02_GOLDEN_PROS", scene: "STATE2", folder: "00_DELIVERY" },
  { id: "1397", was: "gyg_gh_pros_pano_3 Layers", scene: "STATE2", folder: "20_GENERIC/plates", note: "After Effects named this; left alone" },

  // 03 GOLDEN HOUR SPEECH
  { id: "1373", was: "gyg_ghspeech_pros_pano", now: "GYG_03_SPEECH_PROS", scene: "STATE5", folder: "00_DELIVERY" },
  { id: "1372", was: "gyg_ghspeech_pros_pano Layers", scene: "STATE5", folder: "20_GENERIC/plates" },

  // 04 TRANSITION NIGHT -- the three walls of the golden-hour-to-night shot.
  { id: "2053", was: "gyg_gh_pros_pano_3__NIGHT_TRANS", now: "GYG_04_NIGHT_PROS_gh_to_night", scene: "STATE3", folder: "00_DELIVERY" },
  { id: "2092", was: "GYG_SIDES_LEFT_gh_to_night", now: "GYG_04_NIGHT_LEFT_gh_to_night", scene: "STATE3", folder: "00_DELIVERY" },
  { id: "2129", was: "GYG_SIDES_RIGHT_gh_to_night", now: "GYG_04_NIGHT_RIGHT_gh_to_night", scene: "STATE3", folder: "00_DELIVERY" },
  { id: "2005", was: "gyg_PROS_transnight1", now: "GYG_04_NIGHT_PROS_hold", scene: "STATE3", folder: "00_DELIVERY", note: "the night hold the transition lands on" },
  { id: "2004", was: "gyg_PROS_transnight1 Layers", scene: "STATE3", folder: "20_GENERIC/plates" },

  // 05 PARTY CITY
  { id: "1720", was: "gyg_SIDESpartycity2_left6", now: "GYG_05_PARTY_LEFT", scene: "STATE4", folder: "00_DELIVERY" },
  { id: "1719", was: "gyg_SIDESpartycity2_left6 Layers", scene: "STATE4", folder: "20_GENERIC/plates" },
];

if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

const inventory = await host("projectItems");
const byId = new Map<string, { id: string; name: string; folder: string; kind: string }>();
for (const item of inventory.items ?? []) byId.set(String(item.id), item);

/** Current state name -> the name it is being given, for rewriting folder paths. */
const renamedTo = new Map(SCENES.map((s) => [s.was, s.now]));

console.log(`=== the five scenes\n`);
const folderRenames: Array<{ itemId: string; name: string; expectName: string }> = [];
for (const scene of SCENES) {
  const here = [...byId.values()].find(
    (i) => i.kind === "folder" && i.folder === "" && i.name === scene.was,
  );
  const already = [...byId.values()].find(
    (i) => i.kind === "folder" && i.folder === "" && i.name === scene.now,
  );
  if (already && !here) {
    console.log(`  ${scene.now.padEnd(24)} already named  (${scene.because})`);
    continue;
  }
  if (!here) {
    console.log(`  ! no folder called ${scene.was} at the project root — skipped`);
    continue;
  }
  console.log(`  ${scene.was.padEnd(8)} -> ${scene.now.padEnd(24)} ${scene.because}`);
  folderRenames.push({ itemId: here.id, name: scene.now, expectName: scene.was });
}

console.log(`\n=== the comps, and where each one belongs\n`);
const compRenames: Array<{ itemId: string; name: string; expectName: string }> = [];
const moves: Array<{ itemId: string; folder: string; expectName: string }> = [];
for (const comp of COMPS) {
  const item = byId.get(comp.id);
  if (!item) {
    console.log(`  ! id ${comp.id} (${comp.was}) is not in this project any more — skipped`);
    continue;
  }
  /*
   * The destination is written against the state's NEW name. The renames are
   * applied first, so by the time a move runs the path exists; and if the
   * renames were refused, `createFolders` would make the new tree beside the
   * old one, which is why a failed rename stops the moves below.
   */
  const scene = renamedTo.get(comp.scene) ?? comp.scene;
  const want = `${scene}/${comp.folder}`;
  const nameNow = String(item.name);
  const nameWanted = comp.now ?? comp.was;

  const needsRename = comp.now !== undefined && nameNow !== comp.now;
  const needsMove = item.folder !== want;
  console.log(
    `  ${String(comp.id).padStart(5)}  ${nameNow.slice(0, 34).padEnd(34)}` +
      `${needsRename ? ` -> ${comp.now}` : ""}`,
  );
  console.log(
    `         ${item.folder || "(root)"}\n` +
      `      -> ${want}${needsMove ? "" : "   (already there)"}` +
      `${comp.note ? `\n         ${comp.note}` : ""}`,
  );
  if (needsRename)
    compRenames.push({ itemId: comp.id, name: comp.now!, expectName: nameNow });
  if (needsMove) moves.push({ itemId: comp.id, folder: want, expectName: nameWanted });
}

const folders = [...new Set(moves.map((m) => m.folder))].sort();
console.log(
  `\n=== ${folderRenames.length} folder renames, ${compRenames.length} comp renames, ` +
    `${moves.length} moves into ${folders.length} folders`,
);

if (!apply) {
  console.log("\n--apply to do it. --save writes a project version first.");
  process.exit(0);
}

if (save) {
  const saved = await host("saveVersion");
  console.log(`\nsaved ${path.basename(String(saved.savedAs ?? saved.name ?? ""))}`);
}

/*
 * Renames first, because every move below names its destination by the new
 * folder name. A refused rename therefore has to stop the moves: otherwise
 * `moveItems` would call `createFolders` on `04_TRANSITION_NIGHT/00_DELIVERY`,
 * get a brand-new empty tree beside `STATE3`, and file the comps into a scene
 * folder that is not the scene folder.
 */
const allRenames = [...folderRenames, ...compRenames];
let renamesOk = allRenames.length === 0;
if (allRenames.length) {
  const { value, error } = await tryHost("renameItems", { renames: allRenames });
  if (error) {
    console.log(`\nrenameItems: ${error}`);
    console.log(
      "  The panel After Effects is running is a copy. Run `npm run install:extension`,\n" +
        "  then close and reopen Window > Extensions > SEED / AE, then run this again.",
    );
  } else {
    renamesOk = true;
    console.log(`\nrenamed ${value.renamedCount}, unchanged ${value.unchanged}, refused ${value.refusedCount}`);
    for (const r of value.renamed ?? []) console.log(`  ${r.from}  ->  ${r.to}`);
    for (const r of value.refused ?? []) console.log(`  ! ${r.name ?? r.itemId}: ${r.reason}`);
    if (value.refusedCount > 0) renamesOk = false;
  }
}

if (!renamesOk) {
  console.log("\nNothing moved: the moves are addressed to the new folder names.");
  process.exit(1);
}

await host("createFolders", { paths: folders });
const moved = await host("moveItems", { moves });
console.log(
  `\nmoved ${moved.movedCount}, already there ${moved.alreadyThere}, refused ${moved.refusedCount}`,
);
for (const m of moved.moved ?? []) console.log(`  ${m.name}\n    ${m.from || "(root)"} -> ${m.to}`);
for (const m of moved.refused ?? []) console.log(`  ! ${m.name ?? m.itemId}: ${m.reason}`);

console.log("\nDone. `npx tsx scripts/tidy-project.ts` keeps the shelf inside each scene.");
