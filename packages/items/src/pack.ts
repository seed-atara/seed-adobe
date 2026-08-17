import type { ItemDetail, ItemPlate, ItemRevision } from "@seed-ae/domain";

/**
 * The Item Pack — what makes this a studio format rather than a SEED feature.
 *
 * A pack is a directory (or a zip of one) holding `item.json` and
 * content-addressed media. Plates are named by **sha256 plus the original
 * filename**, never by a local asset id, so a pack means the same thing in
 * every instance, commits to a show's repo, and is readable without SEED,
 * without SQLite and without Adobe. If this product is replaced, the cast is
 * not.
 *
 * ```
 * sara.seeditem/
 *   item.json
 *   media/3f9a…c1.png
 *   README.md
 * ```
 *
 * This module is the pure half: turning an `ItemDetail` into a manifest and
 * back. Reading and writing files belongs to whatever is hosting it.
 */

export const PACK_FORMAT_VERSION = 1;

export interface PackPlate {
  /** sha256 of the media, lowercase hex. The only address a pack contains. */
  sha256: string;
  filename: string;
  mimeType: string;
  role: ItemPlate["role"];
  weight: number;
  notes?: string;
}

export interface PackRevision {
  revision: number;
  createdAt: string;
  message?: string;
  traits: ItemRevision["traits"];
  avoid: string[];
  attributes: Record<string, string>;
  seedHint?: number;
  look?: ItemRevision["look"];
  plates: PackPlate[];
}

export interface PackVariant {
  slug: string;
  name: string;
  parentSlug?: string;
  revisions: PackRevision[];
}

export interface ItemPack {
  format: typeof PACK_FORMAT_VERSION;
  handle: string;
  kind: ItemDetail["item"]["kind"];
  name: string;
  tags: string[];
  realPerson: boolean;
  createdAt: string;
  variants: PackVariant[];
}

/** How the exporter tells us what an asset id actually is, on disk. */
export interface PlateMedia {
  sha256: string;
  filename: string;
  mimeType: string;
}

/**
 * Builds a pack manifest.
 *
 * Anything whose media we cannot describe is dropped and named. A pack that
 * silently lost a plate would import as a subtly different character, which is
 * the one failure this whole design exists to prevent.
 *
 * Note what is *not* here: local asset ids, provider groups, and above all
 * `asset://` ids. Those are described as needing to be treated as secrets —
 * they are not individually authenticated, so anyone holding one can generate
 * with that likeness. Exporting a character must not export the ability to
 * impersonate someone, so ids stay local and are re-registered on import.
 */
export function buildPack(
  detail: ItemDetail,
  media: Map<string, PlateMedia>,
): { pack: ItemPack; missing: string[]; hashes: Set<string> } {
  const missing: string[] = [];
  const hashes = new Set<string>();
  const bySlug = new Map(detail.variants.map((variant) => [variant.id, variant]));

  const variants: PackVariant[] = detail.variants.map((variant) => {
    const revisions = detail.revisions
      .filter((revision) => revision.variantId === variant.id)
      .sort((a, b) => a.revision - b.revision)
      .map((revision) => {
        const plates: PackPlate[] = [];
        for (const plate of revision.plates) {
          const entry = media.get(plate.assetId);
          if (!entry) {
            missing.push(plate.assetId);
            continue;
          }
          hashes.add(entry.sha256);
          plates.push({
            sha256: entry.sha256,
            filename: entry.filename,
            mimeType: entry.mimeType,
            role: plate.role,
            weight: plate.weight,
            ...(plate.notes ? { notes: plate.notes } : {}),
          });
        }
        return {
          revision: revision.revision,
          createdAt: revision.createdAt,
          ...(revision.message ? { message: revision.message } : {}),
          traits: revision.traits,
          avoid: revision.avoid,
          attributes: revision.attributes,
          ...(revision.seedHint !== undefined ? { seedHint: revision.seedHint } : {}),
          ...(revision.look ? { look: revision.look } : {}),
          plates,
        };
      });

    const parent = variant.parentVariantId
      ? bySlug.get(variant.parentVariantId)?.slug
      : undefined;
    return {
      slug: variant.slug,
      name: variant.name,
      ...(parent ? { parentSlug: parent } : {}),
      revisions,
    };
  });

  return {
    pack: {
      format: PACK_FORMAT_VERSION,
      handle: detail.item.handle,
      kind: detail.item.kind,
      name: detail.item.name,
      tags: detail.item.tags,
      realPerson: detail.item.realPerson,
      createdAt: detail.item.createdAt,
      variants,
    },
    missing,
    hashes,
  };
}

export function parsePack(raw: unknown): ItemPack {
  const pack = raw as ItemPack;
  if (!pack || typeof pack !== "object") {
    throw new Error("this is not an item pack");
  }
  if (pack.format !== PACK_FORMAT_VERSION) {
    throw new Error(
      `item pack format ${String(pack.format)} is not supported (this build reads ${PACK_FORMAT_VERSION})`,
    );
  }
  if (!pack.handle || !pack.kind || !Array.isArray(pack.variants)) {
    throw new Error("this item pack is missing a handle, a kind, or its variants");
  }
  return pack;
}

/** The human-readable sheet that ships beside the manifest. */
export function packReadme(pack: ItemPack): string {
  const lines = [`# ${pack.name}`, "", `\`@${pack.handle}\` · ${pack.kind}`, ""];
  if (pack.realPerson) {
    lines.push(
      "> **Real likeness.** Using this needs authorisation from the person",
      "> themselves; importing the pack does not carry that authorisation with it.",
      "",
    );
  }
  for (const variant of pack.variants) {
    const latest = variant.revisions.at(-1);
    lines.push(`## ${variant.name} (\`${variant.slug}\`)`, "");
    if (!latest) {
      lines.push("_No revisions._", "");
      continue;
    }
    if (latest.traits.length > 0) {
      lines.push("**Traits**", "");
      for (const trait of latest.traits) {
        lines.push(`- ${trait.text}${trait.driftProne ? " _(drifts)_" : ""}`);
      }
      lines.push("");
    }
    if (latest.plates.length > 0) {
      lines.push("**Plates**", "");
      for (const plate of latest.plates) {
        lines.push(`- \`${plate.role}\` — \`media/${plate.sha256}\` (${plate.filename})`);
      }
      lines.push("");
    }
    if (latest.avoid.length > 0) {
      lines.push(`**Avoid:** ${latest.avoid.join(", ")}`, "");
    }
  }
  return lines.join("\n");
}
