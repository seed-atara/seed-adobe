import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SeedError } from "@seed-ae/domain";
import {
  buildPack,
  packReadme,
  parsePack,
  type ItemPack,
  type PackPlate,
  type PlateMedia,
} from "@seed-ae/items";
import { resolveStorageUri } from "@seed-ae/storage";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";
import { z } from "zod";
import { adoptFileIntoLibrary } from "./assets.js";

/**
 * Item Packs: a character leaving this instance, and arriving in another.
 *
 * The unit is a directory of `item.json` plus content-addressed media, which is
 * what makes an item a studio artefact rather than a row in one SQLite file. It
 * commits to a show's repo and reads without SEED.
 */

const ExportPackRequestSchema = z.object({
  /** Where to write the pack directory. */
  outDir: z.string().min(1),
});

const ImportPackRequestSchema = z.object({
  /** The `.seeditem` directory to read. */
  dir: z.string().min(1),
  /** Take this handle instead of the pack's, when the pack's is taken. */
  handle: z.string().min(1).max(48).optional(),
});

export function exportPackRoute(deps: AppDeps) {
  return async ({ params, req }: RequestContext) => {
    const { outDir } = parseWith(ExportPackRequestSchema, await readJsonBody(req));
    const detail = deps.items.get(params.id as string);
    if (!detail) throw new SeedError("not_found", `no item ${params.id}`);

    // Hash every plate's bytes: the hash is the only address a pack carries.
    const media = new Map<string, PlateMedia>();
    const bytesByHash = new Map<string, Buffer>();
    const assetIds = new Set(
      detail.revisions.flatMap((revision) => revision.plates.map((plate) => plate.assetId)),
    );

    for (const assetId of assetIds) {
      const asset = deps.assets.getById(assetId);
      if (!asset || asset.status === "missing") continue;
      try {
        const bytes = await readFile(resolveStorageUri(deps.workspace, asset.storageUri));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        media.set(assetId, { sha256, filename: asset.filename, mimeType: asset.mimeType });
        bytesByHash.set(sha256, bytes);
      } catch {
        // Left out of `media`, so buildPack reports it as missing rather than
        // writing a pack that quietly lost a plate.
      }
    }

    const { pack, missing } = buildPack(detail, media);
    const packDir = path.join(outDir, `${detail.item.handle}.seeditem`);
    const mediaDir = path.join(packDir, "media");
    await mkdir(mediaDir, { recursive: true });

    for (const [sha256, bytes] of bytesByHash) {
      const extension = path.extname(
        [...media.values()].find((entry) => entry.sha256 === sha256)?.filename ?? "",
      );
      await writeFile(path.join(mediaDir, `${sha256}${extension}`), bytes);
    }
    await writeFile(path.join(packDir, "item.json"), JSON.stringify(pack, null, 2), "utf8");
    await writeFile(path.join(packDir, "README.md"), packReadme(pack), "utf8");

    const warnings = missing.length
      ? [
          `${missing.length} plate${missing.length === 1 ? "" : "s"} had no readable media and were left out of the pack.`,
        ]
      : [];
    return json({ path: packDir, plates: bytesByHash.size, warnings });
  };
}

export function importPackRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(ImportPackRequestSchema, await readJsonBody(req));
    let pack: ItemPack;
    try {
      pack = parsePack(
        JSON.parse(await readFile(path.join(request.dir, "item.json"), "utf8")),
      );
    } catch (cause) {
      throw new SeedError(
        "bad_request",
        `could not read an item pack at ${request.dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    /*
     * A handle collision forks rather than overwrites. Importing a character
     * you already have must never quietly replace the one you have been
     * generating with — and saying which happened is the whole difference
     * between a merge you can reason about and one you discover later.
     */
    const warnings: string[] = [];
    let handle = request.handle ?? pack.handle;
    if (deps.items.findByHandle(handle)) {
      handle = `${handle}_imported`;
      let suffix = 2;
      while (deps.items.findByHandle(handle)) {
        handle = `${pack.handle}_imported_${suffix++}`;
      }
      warnings.push(`@${pack.handle} already exists, so this imported as @${handle}.`);
    }

    // Register any media the library does not already hold, by content hash.
    const assetByHash = new Map<string, string>();
    for (const variant of pack.variants) {
      for (const revision of variant.revisions) {
        for (const plate of revision.plates) {
          if (assetByHash.has(plate.sha256)) continue;
          const extension = path.extname(plate.filename);
          const source = path.join(request.dir, "media", `${plate.sha256}${extension}`);
          try {
            const asset = await adoptFileIntoLibrary(deps, source);
            assetByHash.set(plate.sha256, asset.id);
          } catch {
            warnings.push(
              `plate ${plate.sha256.slice(0, 8)} (${plate.filename}) could not be read and was skipped.`,
            );
          }
        }
      }
    }

    const created = deps.items.create({
      handle,
      kind: pack.kind,
      name: pack.name,
      tags: pack.tags,
      realPerson: pack.realPerson,
    });

    if (pack.realPerson) {
      warnings.push(
        `@${handle} is a real likeness. The pack does not carry authorisation — that has to be granted again here by the person themselves.`,
      );
    }

    const variantIdBySlug = new Map<string, string>([
      ["base", created.variants[0]?.id as string],
    ]);

    for (const variant of pack.variants) {
      let variantId = variantIdBySlug.get(variant.slug);
      if (!variantId) {
        variantId = deps.items.createVariant(created.item.id, variant.slug, variant.name).id;
        variantIdBySlug.set(variant.slug, variantId);
      }
      for (const revision of variant.revisions) {
        deps.items.addRevision(variantId, {
          ...(revision.message ? { message: revision.message } : {}),
          traits: revision.traits,
          avoid: revision.avoid,
          attributes: revision.attributes,
          ...(revision.seedHint !== undefined ? { seedHint: revision.seedHint } : {}),
          ...(revision.look ? { look: revision.look } : {}),
          plates: revision.plates
            .map((plate: PackPlate) => ({
              assetId: assetByHash.get(plate.sha256) ?? "",
              role: plate.role,
              weight: plate.weight,
              ...(plate.notes ? { notes: plate.notes } : {}),
              providerRefs: {},
            }))
            .filter((plate: { assetId: string }) => plate.assetId !== ""),
        });
      }
    }

    return json({ item: deps.items.get(created.item.id), warnings }, 201);
  };
}
