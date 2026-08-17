/**
 * Items from the command line — what a pipeline needs, rather than what a
 * person needs.
 *
 *   npx tsx scripts/item.ts list
 *   npx tsx scripts/item.ts new sara --kind character --name "Sara Kim"
 *   npx tsx scripts/item.ts trait sara "faint scar left eyebrow" --drifts
 *   npx tsx scripts/item.ts plate sara ast_1234 --role face
 *   npx tsx scripts/item.ts export sara --out ./cast
 *   npx tsx scripts/item.ts import ./cast/sara.seeditem
 *   npx tsx scripts/item.ts resolve "wide of @sara in @bar" --provider seedream
 *
 * `resolve` is the important one. It prints the exact bundle a prompt would
 * produce — plates chosen, plates dropped, tier per item, the final text,
 * the word count — and spends nothing. When a shot comes back wrong this is
 * the first command to run, and it is the difference between a system you can
 * debug and one you argue with.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ItemKind, ItemMention, PlateRole } from "@seed-ae/domain";
import {
  buildPack,
  packReadme,
  parsePack,
  parseMentions,
  resolveBundle,
  type MentionBinding,
  type PlateMedia,
} from "@seed-ae/items";
import { resolveStorageUri } from "@seed-ae/storage";
import { bootstrap } from "../apps/service/src/bootstrap.ts";
import { loadConfig, loadDotEnv } from "../apps/service/src/config.ts";
import { silentLogger } from "../apps/service/src/logger.ts";

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
}
function has(name: string): boolean {
  return rest.includes(`--${name}`);
}
/** Positional arguments, with flags and their values removed. */
function positionals(): string[] {
  const out: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] as string;
    if (value.startsWith("--")) {
      // Boolean flags take no value; the known value-flags do.
      if (["kind", "name", "role", "provider", "out", "handle"].includes(value.slice(2))) {
        index += 1;
      }
      continue;
    }
    out.push(value);
  }
  return out;
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  item.ts list [--kind character]",
      "  item.ts show <handle>",
      "  item.ts new <handle> --kind <kind> [--name <name>]",
      "  item.ts trait <handle> <text> [--drifts]",
      "  item.ts plate <handle> <assetId> [--role <role>]",
      "  item.ts export <handle> --out <dir>",
      "  item.ts import <packDir> [--handle <handle>]",
      '  item.ts resolve "<prompt>" [--provider <id>]',
    ].join("\n"),
  );
  process.exit(2);
}

loadDotEnv();
const deps = await bootstrap({ config: loadConfig(), logger: silentLogger });
const { items, assets, workspace, registry } = deps;

switch (command) {
  case "list": {
    const kind = flag("kind") as ItemKind | undefined;
    const listed = items.list({ ...(kind ? { kind } : {}) });
    if (listed.items.length === 0) {
      console.log("no items yet");
      break;
    }
    for (const item of listed.items) {
      const marker = item.realPerson && item.authorisation !== "authorised" ? ` [${item.authorisation}]` : "";
      console.log(`@${item.handle.padEnd(20)} ${item.kind.padEnd(10)} ${item.name}${marker}`);
    }
    break;
  }

  case "show": {
    const handle = positionals()[0];
    if (!handle) usage();
    const detail = items.findByHandle(handle);
    if (!detail) {
      console.error(`no item @${handle}`);
      process.exit(1);
    }
    console.log(JSON.stringify(detail, null, 2));
    break;
  }

  case "new": {
    const handle = positionals()[0];
    const kind = (flag("kind") ?? "character") as ItemKind;
    if (!handle) usage();
    const created = items.create({
      handle,
      kind,
      name: flag("name") ?? handle,
      realPerson: has("real-person"),
    });
    console.log(`created @${created.item.handle} (${created.item.id})`);
    break;
  }

  case "trait": {
    const [handle, ...words] = positionals();
    const text = words.join(" ");
    if (!handle || !text) usage();
    const resolved = items.resolveHandle(handle);
    if (!resolved) {
      console.error(`no item @${handle}`);
      process.exit(1);
    }
    items.addRevision(resolved.variant.id, {
      message: `added trait: ${text}`,
      plates: resolved.revision.plates,
      avoid: resolved.revision.avoid,
      attributes: resolved.revision.attributes,
      traits: [
        ...resolved.revision.traits,
        {
          text,
          facet: "other",
          priority: resolved.revision.traits.length,
          driftProne: has("drifts"),
        },
      ],
    });
    console.log(`@${handle} is now revision ${resolved.revision.revision + 1}`);
    break;
  }

  case "plate": {
    const [handle, assetId] = positionals();
    if (!handle || !assetId) usage();
    const resolved = items.resolveHandle(handle);
    if (!resolved) {
      console.error(`no item @${handle}`);
      process.exit(1);
    }
    assets.requireById(assetId);
    items.addRevision(resolved.variant.id, {
      message: `added plate ${assetId}`,
      traits: resolved.revision.traits,
      avoid: resolved.revision.avoid,
      attributes: resolved.revision.attributes,
      plates: [
        ...resolved.revision.plates,
        {
          assetId,
          role: (flag("role") ?? "reference") as PlateRole,
          weight: resolved.revision.plates.length,
          providerRefs: {},
        },
      ],
    });
    console.log(`@${handle} is now revision ${resolved.revision.revision + 1}`);
    break;
  }

  case "export": {
    const handle = positionals()[0];
    const outDir = flag("out");
    if (!handle || !outDir) usage();
    const detail = items.findByHandle(handle);
    if (!detail) {
      console.error(`no item @${handle}`);
      process.exit(1);
    }

    const media = new Map<string, PlateMedia>();
    const bytesByHash = new Map<string, Buffer>();
    for (const assetId of new Set(
      detail.revisions.flatMap((revision) => revision.plates.map((plate) => plate.assetId)),
    )) {
      const asset = assets.getById(assetId);
      if (!asset) continue;
      try {
        const bytes = await readFile(resolveStorageUri(workspace, asset.storageUri));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        media.set(assetId, { sha256, filename: asset.filename, mimeType: asset.mimeType });
        bytesByHash.set(sha256, bytes);
      } catch {
        // Reported below as a missing plate rather than silently omitted.
      }
    }

    const { pack, missing } = buildPack(detail, media);
    const packDir = path.join(outDir, `${detail.item.handle}.seeditem`);
    await mkdir(path.join(packDir, "media"), { recursive: true });
    for (const [sha256, bytes] of bytesByHash) {
      const entry = [...media.values()].find((value) => value.sha256 === sha256);
      await writeFile(
        path.join(packDir, "media", `${sha256}${path.extname(entry?.filename ?? "")}`),
        bytes,
      );
    }
    await writeFile(path.join(packDir, "item.json"), JSON.stringify(pack, null, 2), "utf8");
    await writeFile(path.join(packDir, "README.md"), packReadme(pack), "utf8");
    console.log(`wrote ${packDir} (${bytesByHash.size} plates)`);
    if (missing.length > 0) {
      console.log(`  ${missing.length} plate(s) had no readable media and were left out`);
    }
    break;
  }

  case "import": {
    const dir = positionals()[0];
    if (!dir) usage();
    const pack = parsePack(JSON.parse(await readFile(path.join(dir, "item.json"), "utf8")));
    console.log(`${pack.name} (@${pack.handle}, ${pack.kind})`);
    console.log(
      `  ${pack.variants.length} variant(s), ${pack.variants.reduce((total, variant) => total + variant.revisions.length, 0)} revision(s)`,
    );
    console.log("  import through the service: POST /v1/items/import { dir }");
    break;
  }

  case "resolve": {
    const prompt = positionals()[0];
    if (!prompt) usage();
    const providerId = flag("provider") ?? (await registry.describeAll())[0]?.id;
    if (!providerId) {
      console.error("no providers are configured");
      process.exit(1);
    }
    const capabilities = await registry.get(providerId).capabilities();

    const bindings: MentionBinding[] = [];
    for (const parsed of parseMentions(prompt)) {
      const definition = items.resolveHandle(parsed.handle, parsed.variantSlug);
      if (!definition) continue;
      const mention: ItemMention = {
        token: parsed.token,
        itemId: definition.item.id,
        variantId: definition.variant.id,
        influence: 70,
        muteText: false,
      };
      if (!bindings.some((entry) => entry.mention.itemId === mention.itemId)) {
        bindings.push({ mention, definition });
      }
    }

    const bundle = resolveBundle({ prompt, bindings, capabilities });

    console.log(`provider: ${providerId} (${capabilities.mentionSyntax})`);
    console.log(
      `budget:   ${bundle.budget.referencesUsed} refs used, ${bundle.budget.referencesStable} is the reliable range, ${bundle.budget.referencesAvailable} would be accepted`,
    );
    console.log(`words:    ${bundle.budget.promptWords}\n`);
    console.log("--- prompt ---");
    console.log(bundle.prompt);
    if (bundle.negativePrompt) console.log(`\n--- avoid ---\n${bundle.negativePrompt}`);
    console.log("\n--- items ---");
    for (const item of bundle.items) {
      console.log(
        `@${item.handle}: tier ${item.tier}, ${item.plateAssetIds.length} plate(s) sent` +
          (item.droppedPlateAssetIds.length > 0
            ? `, ${item.droppedPlateAssetIds.length} dropped`
            : "") +
          (item.labels.length > 0 ? ` — ${item.labels.join(", ")}` : ""),
      );
    }
    if (bundle.warnings.length > 0) {
      console.log("\n--- warnings ---");
      for (const warning of bundle.warnings) console.log(`! ${warning}`);
    }
    break;
  }

  default:
    usage();
}

process.exit(0);
