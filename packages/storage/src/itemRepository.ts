import {
  ItemRevisionSchema,
  ItemSchema,
  ItemVariantSchema,
  SeedError,
  newId,
  nowIso,
  type Item,
  type ItemAuthorisation,
  type ItemDetail,
  type ItemKind,
  type ItemLookBinding,
  type ItemPlate,
  type ItemRevision,
  type ItemTrait,
  type ItemVariant,
  type ResolvedItem,
} from "@seed-ae/domain";
import type { Database } from "./database.js";

/**
 * Items, their variants, and the immutable revisions a generation points at.
 *
 * The split is the whole design: an item is mutable and a revision is not, so
 * an old recipe reopens to exactly the definition it was made with however much
 * the character has changed since. See ADR 0011.
 */

export interface ItemDraft {
  handle: string;
  kind: ItemKind;
  name: string;
  tags?: string[];
  project?: string;
  realPerson?: boolean;
  authorisation?: ItemAuthorisation;
}

export interface RevisionDraft {
  message?: string;
  traits?: ItemTrait[];
  avoid?: string[];
  plates?: ItemPlate[];
  attributes?: Record<string, string>;
  seedHint?: number;
  look?: ItemLookBinding;
}

export interface ListItemsOptions {
  kind?: ItemKind;
  project?: string;
  /** Substring match on handle or name. */
  query?: string;
  limit?: number;
  offset?: number;
}

/** An item resolved to the exact definition a mention points at. */
export interface ResolvedDefinition {
  item: Item;
  variant: ItemVariant;
  revision: ItemRevision;
}

interface ItemRow {
  id: string;
  handle: string;
  kind: string;
  name: string;
  tags_json: string;
  project: string | null;
  real_person: number;
  authorisation: string;
  provider_groups_json: string;
  default_variant_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: string;
  item_id: string;
  slug: string;
  name: string;
  parent_variant_id: string | null;
  created_at: string;
}

interface RevisionRow {
  id: string;
  variant_id: string;
  revision: number;
  created_at: string;
  message: string | null;
  avoid_json: string;
  attributes_json: string;
  seed_hint: number | null;
  look_json: string | null;
}

export class ItemRepository {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------- *
   * Items
   * ---------------------------------------------------------------- */

  create(draft: ItemDraft): ItemDetail {
    const handle = draft.handle.toLowerCase();
    if (this.findByHandle(handle)) {
      throw new SeedError("conflict", `the handle @${handle} is already taken`);
    }
    const now = nowIso();
    const item: Item = {
      id: newId("item"),
      handle,
      kind: draft.kind,
      name: draft.name,
      tags: draft.tags ?? [],
      ...(draft.project ? { project: draft.project } : {}),
      realPerson: draft.realPerson ?? false,
      authorisation:
        draft.authorisation ?? (draft.realPerson ? "pending" : "not-required"),
      providerGroups: {},
      createdAt: now,
      updatedAt: now,
    };
    const parsed = ItemSchema.parse(item);

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO items (id, handle, kind, name, tags_json, project,
             real_person, authorisation, provider_groups_json,
             default_variant_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.handle,
          parsed.kind,
          parsed.name,
          JSON.stringify(parsed.tags),
          parsed.project ?? null,
          parsed.realPerson ? 1 : 0,
          parsed.authorisation,
          JSON.stringify(parsed.providerGroups),
          null,
          parsed.createdAt,
          parsed.updatedAt,
        );
      this.db
        .prepare(
          "INSERT INTO item_handles (item_id, handle, from_at, to_at) VALUES (?, ?, ?, NULL)",
        )
        .run(parsed.id, parsed.handle, now);

      const variant = this.insertVariant(parsed.id, "base", "Base", undefined, now);
      this.db
        .prepare("UPDATE items SET default_variant_id = ? WHERE id = ?")
        .run(variant.id, parsed.id);
      this.insertRevision(variant.id, 1, {}, now);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause instanceof SeedError
        ? cause
        : new SeedError("storage_error", "could not create the item", { cause });
    }

    const created = this.get(parsed.id);
    if (!created) throw new SeedError("storage_error", "the item vanished after creation");
    return created;
  }

  get(id: string): ItemDetail | undefined {
    const row = this.db
      .prepare("SELECT * FROM items WHERE id = ?")
      .get(id) as ItemRow | undefined;
    if (!row) return undefined;
    return this.detailFor(row);
  }

  findByHandle(handle: string): ItemDetail | undefined {
    const row = this.db
      .prepare("SELECT * FROM items WHERE handle = ?")
      .get(handle.toLowerCase()) as ItemRow | undefined;
    if (row) return this.detailFor(row);

    // A handle the item used to have still resolves — old prompts keep working.
    const historic = this.db
      .prepare(
        "SELECT item_id FROM item_handles WHERE handle = ? ORDER BY from_at DESC LIMIT 1",
      )
      .get(handle.toLowerCase()) as { item_id: string } | undefined;
    return historic ? this.get(historic.item_id) : undefined;
  }

  list(options: ListItemsOptions = {}): { items: Item[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.project) {
      where.push("(project = ? OR project IS NULL)");
      params.push(options.project);
    }
    if (options.query) {
      where.push("(handle LIKE ? OR lower(name) LIKE ?)");
      const needle = `%${options.query.toLowerCase()}%`;
      params.push(needle, needle);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...params) as {
        n: number;
      }
    ).n;

    const rows = this.db
      .prepare(
        `SELECT * FROM items ${clause} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit ?? 100, options.offset ?? 0) as unknown as ItemRow[];

    return { items: rows.map(toItem), total };
  }

  update(
    id: string,
    patch: Partial<
      Pick<Item, "name" | "tags" | "kind" | "project" | "realPerson" | "authorisation">
    >,
  ): ItemDetail {
    const current = this.get(id);
    if (!current) throw new SeedError("not_found", `no item ${id}`);
    const next = { ...current.item, ...patch, updatedAt: nowIso() };
    const parsed = ItemSchema.parse(next);
    this.db
      .prepare(
        `UPDATE items SET name = ?, tags_json = ?, kind = ?, project = ?,
           real_person = ?, authorisation = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        parsed.name,
        JSON.stringify(parsed.tags),
        parsed.kind,
        parsed.project ?? null,
        parsed.realPerson ? 1 : 0,
        parsed.authorisation,
        parsed.updatedAt,
        id,
      );
    return this.get(id) as ItemDetail;
  }

  /**
   * Renaming keeps the old handle resolvable.
   *
   * A prompt written six weeks ago should not stop working because a character
   * got a better name, and recipes link by revision id anyway.
   */
  rename(id: string, handle: string): ItemDetail {
    const next = handle.toLowerCase();
    const existing = this.findByHandle(next);
    if (existing && existing.item.id !== id) {
      throw new SeedError("conflict", `the handle @${next} is already taken`);
    }
    const now = nowIso();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE item_handles SET to_at = ? WHERE item_id = ? AND to_at IS NULL")
        .run(now, id);
      this.db
        .prepare(
          "INSERT INTO item_handles (item_id, handle, from_at, to_at) VALUES (?, ?, ?, NULL)",
        )
        .run(id, next, now);
      this.db
        .prepare("UPDATE items SET handle = ?, updated_at = ? WHERE id = ?")
        .run(next, now, id);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw new SeedError("storage_error", "could not rename the item", { cause });
    }
    return this.get(id) as ItemDetail;
  }

  setProviderGroup(id: string, providerId: string, groupId: string): void {
    const current = this.get(id);
    if (!current) throw new SeedError("not_found", `no item ${id}`);
    const groups = { ...current.item.providerGroups, [providerId]: groupId };
    this.db
      .prepare("UPDATE items SET provider_groups_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(groups), nowIso(), id);
  }

  /* ---------------------------------------------------------------- *
   * Variants and revisions
   * ---------------------------------------------------------------- */

  createVariant(
    itemId: string,
    slug: string,
    name: string,
    parentVariantId?: string,
  ): ItemVariant {
    const item = this.get(itemId);
    if (!item) throw new SeedError("not_found", `no item ${itemId}`);
    const parent =
      parentVariantId ?? item.item.defaultVariantId ?? item.variants[0]?.id;

    const now = nowIso();
    this.db.exec("BEGIN");
    try {
      const variant = this.insertVariant(itemId, slug.toLowerCase(), name, parent, now);
      // A variant starts as a copy of what it descends from, so it is an edit
      // of three plates rather than a character rebuilt by hand.
      const inherited = parent ? this.latestRevision(parent) : undefined;
      this.insertRevision(
        variant.id,
        1,
        inherited
          ? {
              traits: inherited.traits,
              avoid: inherited.avoid,
              plates: inherited.plates,
              attributes: inherited.attributes,
              ...(inherited.seedHint !== undefined ? { seedHint: inherited.seedHint } : {}),
              ...(inherited.look ? { look: inherited.look } : {}),
              message: `branched from ${parent}`,
            }
          : {},
        now,
      );
      this.db.exec("COMMIT");
      return variant;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause instanceof SeedError
        ? cause
        : new SeedError("storage_error", "could not create the variant", { cause });
    }
  }

  /** Appends a revision. Nothing is ever edited in place. */
  addRevision(variantId: string, draft: RevisionDraft): ItemRevision {
    const previous = this.latestRevision(variantId);
    const next = (previous?.revision ?? 0) + 1;
    const now = nowIso();
    this.db.exec("BEGIN");
    try {
      const revision = this.insertRevision(variantId, next, draft, now);
      const variant = this.getVariant(variantId);
      if (variant) {
        this.db
          .prepare("UPDATE items SET updated_at = ? WHERE id = ?")
          .run(now, variant.itemId);
      }
      this.db.exec("COMMIT");
      return revision;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause instanceof SeedError
        ? cause
        : new SeedError("storage_error", "could not add the revision", { cause });
    }
  }

  getVariant(id: string): ItemVariant | undefined {
    const row = this.db
      .prepare("SELECT * FROM item_variants WHERE id = ?")
      .get(id) as VariantRow | undefined;
    return row ? toVariant(row) : undefined;
  }

  latestRevision(variantId: string): ItemRevision | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM item_revisions WHERE variant_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(variantId) as RevisionRow | undefined;
    return row ? this.hydrateRevision(row) : undefined;
  }

  getRevision(id: string): ItemRevision | undefined {
    const row = this.db
      .prepare("SELECT * FROM item_revisions WHERE id = ?")
      .get(id) as RevisionRow | undefined;
    return row ? this.hydrateRevision(row) : undefined;
  }

  /**
   * What `@handle` or `@handle/variant` means right now.
   *
   * An unknown handle returns undefined rather than throwing: prose containing
   * an `@` for some other reason is ordinary writing, not an error.
   */
  resolveHandle(handle: string, variantSlug?: string): ResolvedDefinition | undefined {
    const detail = this.findByHandle(handle);
    if (!detail) return undefined;
    const variant = variantSlug
      ? detail.variants.find((entry) => entry.slug === variantSlug.toLowerCase())
      : (detail.variants.find((entry) => entry.id === detail.item.defaultVariantId) ??
        detail.variants[0]);
    if (!variant) return undefined;
    const revision = this.latestRevision(variant.id);
    if (!revision) return undefined;
    return { item: detail.item, variant, revision };
  }

  /** The exact definition a past generation used, however the item has changed. */
  resolveRevision(revisionId: string): ResolvedDefinition | undefined {
    const revision = this.getRevision(revisionId);
    if (!revision) return undefined;
    const variant = this.getVariant(revision.variantId);
    if (!variant) return undefined;
    const detail = this.get(variant.itemId);
    if (!detail) return undefined;
    return { item: detail.item, variant, revision };
  }

  /* ---------------------------------------------------------------- *
   * Generations
   * ---------------------------------------------------------------- */

  recordForGeneration(generationId: string, items: ResolvedItem[]): void {
    const insert = this.db.prepare(
      `INSERT INTO generation_items (generation_id, position, item_id, variant_id,
         revision_id, handle, tier, influence, labels_json, plate_asset_ids_json,
         dropped_plate_asset_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((entry, position) => {
      insert.run(
        generationId,
        position,
        entry.itemId,
        entry.variantId,
        entry.revisionId,
        entry.handle,
        entry.tier,
        entry.influence,
        JSON.stringify(entry.labels),
        JSON.stringify(entry.plateAssetIds),
        JSON.stringify(entry.droppedPlateAssetIds),
      );
    });
  }

  forGeneration(generationId: string): ResolvedItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM generation_items WHERE generation_id = ? ORDER BY position",
      )
      .all(generationId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      itemId: row.item_id as string,
      variantId: row.variant_id as string,
      revisionId: row.revision_id as string,
      handle: row.handle as string,
      labels: JSON.parse(row.labels_json as string) as string[],
      tier: row.tier as ResolvedItem["tier"],
      influence: row.influence as number,
      plateAssetIds: JSON.parse(row.plate_asset_ids_json as string) as string[],
      droppedPlateAssetIds: JSON.parse(
        row.dropped_plate_asset_ids_json as string,
      ) as string[],
    }));
  }

  /** Every generation an item appears in — "where has Sara been used?". */
  generationIdsFor(itemId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT generation_id FROM generation_items WHERE item_id = ?",
      )
      .all(itemId) as Array<{ generation_id: string }>;
    return rows.map((row) => row.generation_id);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private detailFor(row: ItemRow): ItemDetail {
    const variantRows = this.db
      .prepare("SELECT * FROM item_variants WHERE item_id = ? ORDER BY created_at")
      .all(row.id) as unknown as VariantRow[];
    const variants = variantRows.map(toVariant);
    const revisions = variants.flatMap((variant) => {
      const rows = this.db
        .prepare("SELECT * FROM item_revisions WHERE variant_id = ? ORDER BY revision")
        .all(variant.id) as unknown as RevisionRow[];
      return rows.map((entry) => this.hydrateRevision(entry));
    });
    return { item: toItem(row), variants, revisions };
  }

  private insertVariant(
    itemId: string,
    slug: string,
    name: string,
    parentVariantId: string | undefined,
    now: string,
  ): ItemVariant {
    const variant: ItemVariant = {
      id: newId("itemVariant"),
      itemId,
      slug,
      name,
      ...(parentVariantId ? { parentVariantId } : {}),
      createdAt: now,
    };
    const parsed = ItemVariantSchema.parse(variant);
    this.db
      .prepare(
        `INSERT INTO item_variants (id, item_id, slug, name, parent_variant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.itemId,
        parsed.slug,
        parsed.name,
        parsed.parentVariantId ?? null,
        parsed.createdAt,
      );
    return parsed;
  }

  private insertRevision(
    variantId: string,
    revision: number,
    draft: RevisionDraft,
    now: string,
  ): ItemRevision {
    const payload: ItemRevision = ItemRevisionSchema.parse({
      id: newId("itemRevision"),
      variantId,
      revision,
      createdAt: now,
      ...(draft.message ? { message: draft.message } : {}),
      traits: draft.traits ?? [],
      avoid: draft.avoid ?? [],
      plates: draft.plates ?? [],
      attributes: draft.attributes ?? {},
      ...(draft.seedHint !== undefined ? { seedHint: draft.seedHint } : {}),
      ...(draft.look ? { look: draft.look } : {}),
    });

    this.db
      .prepare(
        `INSERT INTO item_revisions (id, variant_id, revision, created_at, message,
           avoid_json, attributes_json, seed_hint, look_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.id,
        payload.variantId,
        payload.revision,
        payload.createdAt,
        payload.message ?? null,
        JSON.stringify(payload.avoid),
        JSON.stringify(payload.attributes),
        payload.seedHint ?? null,
        payload.look ? JSON.stringify(payload.look) : null,
      );

    const plateStatement = this.db.prepare(
      `INSERT INTO item_plates (revision_id, position, asset_id, role, weight, notes, provider_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    payload.plates.forEach((plate, position) => {
      plateStatement.run(
        payload.id,
        position,
        plate.assetId,
        plate.role,
        plate.weight,
        plate.notes ?? null,
        JSON.stringify(plate.providerRefs),
      );
    });

    const traitStatement = this.db.prepare(
      `INSERT INTO item_traits (revision_id, position, text, facet, priority, drift_prone)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    payload.traits.forEach((trait, position) => {
      traitStatement.run(
        payload.id,
        position,
        trait.text,
        trait.facet,
        trait.priority,
        trait.driftProne ? 1 : 0,
      );
    });

    return payload;
  }

  private hydrateRevision(row: RevisionRow): ItemRevision {
    const plateRows = this.db
      .prepare("SELECT * FROM item_plates WHERE revision_id = ? ORDER BY position")
      .all(row.id) as Array<Record<string, unknown>>;
    const traitRows = this.db
      .prepare("SELECT * FROM item_traits WHERE revision_id = ? ORDER BY position")
      .all(row.id) as Array<Record<string, unknown>>;

    return ItemRevisionSchema.parse({
      id: row.id,
      variantId: row.variant_id,
      revision: row.revision,
      createdAt: row.created_at,
      ...(row.message ? { message: row.message } : {}),
      avoid: JSON.parse(row.avoid_json) as string[],
      attributes: JSON.parse(row.attributes_json) as Record<string, string>,
      ...(row.seed_hint !== null ? { seedHint: row.seed_hint } : {}),
      ...(row.look_json ? { look: JSON.parse(row.look_json) } : {}),
      plates: plateRows.map((plate) => ({
        assetId: plate.asset_id as string,
        role: plate.role as ItemPlate["role"],
        weight: plate.weight as number,
        ...(plate.notes ? { notes: plate.notes as string } : {}),
        providerRefs: JSON.parse(plate.provider_refs_json as string) as Record<
          string,
          string
        >,
      })),
      traits: traitRows.map((trait) => ({
        text: trait.text as string,
        facet: trait.facet as ItemTrait["facet"],
        priority: trait.priority as number,
        driftProne: trait.drift_prone === 1,
      })),
    });
  }
}

function toItem(row: ItemRow): Item {
  return ItemSchema.parse({
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    name: row.name,
    tags: JSON.parse(row.tags_json) as string[],
    ...(row.project ? { project: row.project } : {}),
    realPerson: row.real_person === 1,
    authorisation: row.authorisation,
    providerGroups: JSON.parse(row.provider_groups_json) as Record<string, string>,
    ...(row.default_variant_id ? { defaultVariantId: row.default_variant_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toVariant(row: VariantRow): ItemVariant {
  return ItemVariantSchema.parse({
    id: row.id,
    itemId: row.item_id,
    slug: row.slug,
    name: row.name,
    ...(row.parent_variant_id ? { parentVariantId: row.parent_variant_id } : {}),
    createdAt: row.created_at,
  });
}
