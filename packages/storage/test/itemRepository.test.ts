import { beforeEach, describe, expect, it } from "vitest";
import type { AssetDraft } from "@seed-ae/domain";
import {
  AssetRepository,
  ItemRepository,
  openMigratedDatabase,
  type Database,
} from "../src/index.js";

let db: Database;
let items: ItemRepository;
let assets: AssetRepository;

const assetDraft = (filename: string): AssetDraft => ({
  kind: "image",
  filename,
  mimeType: "image/png",
  storageUri: `assets/originals/${filename}`,
  source: { type: "imported", originalPath: `/tmp/${filename}` },
});

function plateAsset(filename: string): string {
  return assets.create(assetDraft(filename)).id;
}

beforeEach(() => {
  db = openMigratedDatabase({ path: ":memory:" });
  items = new ItemRepository(db);
  assets = new AssetRepository(db);
});

describe("creating an item", () => {
  it("comes with a base variant and a first revision", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara Kim" });

    expect(detail.item.id).toMatch(/^itm_/);
    expect(detail.variants).toHaveLength(1);
    expect(detail.variants[0]?.slug).toBe("base");
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]?.revision).toBe(1);
    expect(detail.item.defaultVariantId).toBe(detail.variants[0]?.id);
  });

  it("refuses a handle that is already taken", () => {
    items.create({ handle: "sara", kind: "character", name: "Sara" });
    expect(() => items.create({ handle: "sara", kind: "prop", name: "Other" })).toThrow(
      /already taken/,
    );
  });

  it("marks a real person as needing authorisation without being told", () => {
    const detail = items.create({
      handle: "actor",
      kind: "character",
      name: "Actor",
      realPerson: true,
    });
    expect(detail.item.authorisation).toBe("pending");
  });

  it("defaults to studio-wide rather than a project", () => {
    const detail = items.create({ handle: "bar", kind: "location", name: "The Bar" });
    expect(detail.item.project).toBeUndefined();
  });
});

describe("revisions", () => {
  it("appends rather than editing, and numbers monotonically", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const variantId = detail.variants[0]?.id as string;

    const second = items.addRevision(variantId, {
      message: "added a profile plate",
      plates: [{ assetId: plateAsset("profile.png"), role: "profile", weight: 0, providerRefs: {} }],
      traits: [{ text: "faint scar", facet: "face", priority: 0, driftProne: true }],
    });

    expect(second.revision).toBe(2);
    expect(items.latestRevision(variantId)?.id).toBe(second.id);
    // The first revision is still exactly what it was.
    expect(items.get(detail.item.id)?.revisions).toHaveLength(2);
  });

  it("refuses to let a revision be edited in place", () => {
    // A generation points at a revision id. Rewriting one would change the
    // meaning of every shot that already resolved to it.
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const revisionId = detail.revisions[0]?.id as string;
    expect(() =>
      db.prepare("UPDATE item_revisions SET message = ? WHERE id = ?").run("nope", revisionId),
    ).toThrow(/immutable/);
  });

  it("refuses to let a revision be deleted", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    expect(() =>
      db
        .prepare("DELETE FROM item_revisions WHERE id = ?")
        .run(detail.revisions[0]?.id as string),
    ).toThrow(/append-only/);
  });

  it("round-trips plates and traits through storage", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const variantId = detail.variants[0]?.id as string;
    const front = plateAsset("front.png");

    items.addRevision(variantId, {
      plates: [
        { assetId: front, role: "full-body", weight: 1, notes: "neutral light", providerRefs: { ark: "asset://x" } },
      ],
      traits: [{ text: "olive jacket", facet: "wardrobe", priority: 2, driftProne: false }],
      avoid: ["sunglasses"],
      seedHint: 1234,
    });

    const latest = items.latestRevision(variantId);
    expect(latest?.plates[0]).toEqual({
      assetId: front,
      role: "full-body",
      weight: 1,
      notes: "neutral light",
      providerRefs: { ark: "asset://x" },
    });
    expect(latest?.traits[0]?.driftProne).toBe(false);
    expect(latest?.avoid).toEqual(["sunglasses"]);
    expect(latest?.seedHint).toBe(1234);
  });
});

describe("variants", () => {
  it("branches from its parent rather than starting empty", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const base = detail.variants[0]?.id as string;
    items.addRevision(base, {
      plates: [{ assetId: plateAsset("front.png"), role: "front", weight: 0, providerRefs: {} }],
      traits: [{ text: "dark bob", facet: "hair", priority: 0, driftProne: false }],
    });

    const wet = items.createVariant(detail.item.id, "wet", "Wet");
    const inherited = items.latestRevision(wet.id);

    expect(inherited?.plates).toHaveLength(1);
    expect(inherited?.traits[0]?.text).toBe("dark bob");
    expect(wet.parentVariantId).toBe(base);
  });

  it("refuses two variants with the same slug on one item", () => {
    const detail = items.create({ handle: "bar", kind: "location", name: "Bar" });
    items.createVariant(detail.item.id, "night", "Night");
    expect(() => items.createVariant(detail.item.id, "night", "Night again")).toThrow();
  });
});

describe("resolving a handle", () => {
  it("resolves to the default variant and its latest revision", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const variantId = detail.variants[0]?.id as string;
    const second = items.addRevision(variantId, { message: "second" });

    const resolved = items.resolveHandle("sara");
    expect(resolved?.item.id).toBe(detail.item.id);
    expect(resolved?.revision.id).toBe(second.id);
  });

  it("resolves a named variant", () => {
    const detail = items.create({ handle: "bar", kind: "location", name: "Bar" });
    const night = items.createVariant(detail.item.id, "night", "Night");
    expect(items.resolveHandle("bar", "night")?.variant.id).toBe(night.id);
  });

  it("returns nothing for an unknown handle rather than throwing", () => {
    // Prose containing an @ for some other reason is ordinary writing.
    expect(items.resolveHandle("nobody")).toBeUndefined();
  });

  it("keeps an old handle working after a rename", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    items.rename(detail.item.id, "sara_kim");

    expect(items.resolveHandle("sara_kim")?.item.id).toBe(detail.item.id);
    expect(items.resolveHandle("sara")?.item.id).toBe(detail.item.id);
    expect(items.get(detail.item.id)?.item.handle).toBe("sara_kim");
  });

  it("refuses to rename onto a handle another item holds", () => {
    const sara = items.create({ handle: "sara", kind: "character", name: "Sara" });
    items.create({ handle: "bar", kind: "location", name: "Bar" });
    expect(() => items.rename(sara.item.id, "bar")).toThrow(/already taken/);
  });
});

describe("generations", () => {
  it("records the revision a generation resolved, and finds it again", () => {
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const revisionId = detail.revisions[0]?.id as string;

    db.prepare(
      `INSERT INTO generations (id, provider, model, operation, prompt, job_id, status, created_at)
       VALUES ('gen_1', 'seedream', 'm', 'image.generate', 'p', 'job_1', 'succeeded', '2026-08-17T09:00:00.000Z')`,
    ).run();

    items.recordForGeneration("gen_1", [
      {
        itemId: detail.item.id,
        variantId: detail.variants[0]?.id as string,
        revisionId,
        handle: "sara",
        labels: ["Image 1"],
        tier: "anchor",
        influence: 70,
        plateAssetIds: [],
        droppedPlateAssetIds: [],
      },
    ]);

    expect(items.forGeneration("gen_1")[0]?.revisionId).toBe(revisionId);
    expect(items.generationIdsFor(detail.item.id)).toEqual(["gen_1"]);
  });

  it("recovers the exact definition a past generation used", () => {
    // The whole point of revisions: the item has moved on, the recipe has not.
    const detail = items.create({ handle: "sara", kind: "character", name: "Sara" });
    const variantId = detail.variants[0]?.id as string;
    const original = items.addRevision(variantId, {
      traits: [{ text: "olive jacket", facet: "wardrobe", priority: 0, driftProne: false }],
    });
    items.addRevision(variantId, {
      traits: [{ text: "red coat", facet: "wardrobe", priority: 0, driftProne: false }],
    });

    const recovered = items.resolveRevision(original.id);
    expect(recovered?.revision.traits[0]?.text).toBe("olive jacket");
    expect(items.resolveHandle("sara")?.revision.traits[0]?.text).toBe("red coat");
  });
});

describe("listing", () => {
  it("filters by kind and by a search over handle and name", () => {
    items.create({ handle: "sara", kind: "character", name: "Sara Kim" });
    items.create({ handle: "bar", kind: "location", name: "The Bar" });
    items.create({ handle: "kodak_night", kind: "style", name: "Kodak Night" });

    expect(items.list({ kind: "location" }).items).toHaveLength(1);
    expect(items.list({ query: "kim" }).items[0]?.handle).toBe("sara");
    expect(items.list({ query: "kodak" }).items[0]?.kind).toBe("style");
    expect(items.list().total).toBe(3);
  });

  it("shows studio-wide items alongside a project's own", () => {
    items.create({ handle: "sara", kind: "character", name: "Sara" });
    items.create({ handle: "hero", kind: "prop", name: "Hero", project: "ShowA" });
    items.create({ handle: "other", kind: "prop", name: "Other", project: "ShowB" });

    const listed = items.list({ project: "ShowA" }).items.map((entry) => entry.handle);
    expect(listed).toContain("sara");
    expect(listed).toContain("hero");
    expect(listed).not.toContain("other");
  });
});
