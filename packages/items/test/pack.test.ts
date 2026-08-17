import { describe, expect, it } from "vitest";
import type { ItemDetail } from "@seed-ae/domain";
import {
  PACK_FORMAT_VERSION,
  buildPack,
  packReadme,
  parsePack,
  type PlateMedia,
} from "../src/pack.js";

const STAMP = "2026-08-17T09:00:00.000Z";

function detail(overrides: Partial<ItemDetail["item"]> = {}): ItemDetail {
  return {
    item: {
      id: "itm_1",
      handle: "sara",
      kind: "character",
      name: "Sara Kim",
      tags: ["lead"],
      realPerson: false,
      authorisation: "not-required",
      providerGroups: { seedance: "grp_secret" },
      defaultVariantId: "itv_base",
      createdAt: STAMP,
      updatedAt: STAMP,
      ...overrides,
    },
    variants: [
      { id: "itv_base", itemId: "itm_1", slug: "base", name: "Base", createdAt: STAMP },
      {
        id: "itv_night",
        itemId: "itm_1",
        slug: "night",
        name: "Night",
        parentVariantId: "itv_base",
        createdAt: STAMP,
      },
    ],
    revisions: [
      {
        id: "itr_1",
        variantId: "itv_base",
        revision: 1,
        createdAt: STAMP,
        traits: [{ text: "faint scar", facet: "face", priority: 0, driftProne: true }],
        avoid: ["sunglasses"],
        plates: [
          {
            assetId: "ast_face",
            role: "face",
            weight: 0,
            providerRefs: { seedance: "asset://secret-id" },
          },
        ],
        attributes: { hair: "dark bob" },
      },
      {
        id: "itr_2",
        variantId: "itv_night",
        revision: 1,
        createdAt: STAMP,
        traits: [],
        avoid: [],
        plates: [{ assetId: "ast_missing", role: "detail", weight: 0, providerRefs: {} }],
        attributes: {},
      },
    ],
  };
}

const media = new Map<string, PlateMedia>([
  ["ast_face", { sha256: "a".repeat(64), filename: "face.png", mimeType: "image/png" }],
]);

describe("building a pack", () => {
  it("addresses plates by content hash, never by a local asset id", () => {
    const { pack } = buildPack(detail(), media);
    const plate = pack.variants[0]?.revisions[0]?.plates[0];
    expect(plate?.sha256).toBe("a".repeat(64));
    expect(JSON.stringify(pack)).not.toContain("ast_face");
  });

  it("never carries a provider asset id", () => {
    /*
     * An asset:// id is not individually authenticated: anyone holding one can
     * generate with that likeness. Exporting a character must not export the
     * ability to impersonate someone.
     */
    const { pack } = buildPack(detail(), media);
    const serialised = JSON.stringify(pack);
    expect(serialised).not.toContain("asset://");
    expect(serialised).not.toContain("grp_secret");
  });

  it("reports a plate whose media is unreadable instead of dropping it silently", () => {
    // A pack missing a plate imports as a subtly different character.
    const { pack, missing } = buildPack(detail(), media);
    expect(missing).toEqual(["ast_missing"]);
    expect(pack.variants[1]?.revisions[0]?.plates).toHaveLength(0);
  });

  it("keeps variant lineage by slug, since ids do not survive the trip", () => {
    const { pack } = buildPack(detail(), media);
    expect(pack.variants[1]?.parentSlug).toBe("base");
  });

  it("collects each distinct hash once, however many plates share it", () => {
    const shared = detail();
    shared.revisions[0]?.plates.push({
      assetId: "ast_face",
      role: "front",
      weight: 1,
      providerRefs: {},
    });
    const { hashes } = buildPack(shared, media);
    expect(hashes.size).toBe(1);
  });

  it("carries the real-person flag, which the importer must act on", () => {
    const { pack } = buildPack(detail({ realPerson: true }), media);
    expect(pack.realPerson).toBe(true);
  });
});

describe("reading a pack", () => {
  it("round-trips what it wrote", () => {
    const { pack } = buildPack(detail(), media);
    expect(parsePack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
  });

  it("refuses a format version it does not understand", () => {
    const { pack } = buildPack(detail(), media);
    expect(() => parsePack({ ...pack, format: PACK_FORMAT_VERSION + 1 })).toThrow(
      /not supported/,
    );
  });

  it("refuses something that is not a pack at all", () => {
    expect(() => parsePack(null)).toThrow(/not an item pack/);
    expect(() => parsePack({ format: PACK_FORMAT_VERSION })).toThrow(/missing/);
  });
});

describe("the generated sheet", () => {
  it("reads as a character sheet, and names the media by hash", () => {
    const { pack } = buildPack(detail(), media);
    const readme = packReadme(pack);
    expect(readme).toContain("# Sara Kim");
    expect(readme).toContain("`@sara`");
    expect(readme).toContain("faint scar");
    expect(readme).toContain("_(drifts)_");
    expect(readme).toContain(`media/${"a".repeat(64)}`);
    expect(readme).toContain("**Avoid:** sunglasses");
  });

  it("says plainly that authorisation did not travel with a real likeness", () => {
    const readme = packReadme(buildPack(detail({ realPerson: true }), media).pack);
    expect(readme).toContain("Real likeness");
    expect(readme).toContain("does not carry that authorisation");
  });
});
