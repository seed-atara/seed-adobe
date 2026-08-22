import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ItemResponseSchema, ResolvePromptResponseSchema } from "@seed-ae/domain";
import { encodePng } from "@seed-ae/media";
import { readJson, startTestService, type TestService } from "./helpers.js";

/**
 * A real file on disk, adopted into the library.
 *
 * Packs carry bytes, so a plate whose media is only a database row exports as
 * nothing — which is exactly the case a synthetic registration would hide.
 */
async function adoptRealAsset(seed: number): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const rgba = new Uint8Array(4 * 4 * 4).fill(seed % 256);
  const dir = await mkdtemp(nodePath.join(tmpdir(), "seed-plate-"));
  const file = nodePath.join(dir, `plate_${seed}.png`);
  await writeFile(file, encodePng(4, 4, rgba));
  const response = await post("/v1/assets/adopt", { path: file });
  expect(response.status).toBe(201);
  return (await readJson(response)).asset.id;
}

let service: TestService;

beforeAll(async () => {
  service = await startTestService();
});

afterAll(async () => {
  await service.close();
});

async function registerAsset(filename: string): Promise<string> {
  const response = await service.call("/v1/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "image",
      filename,
      mimeType: "image/png",
      storageUri: `assets/originals/${filename}`,
      source: { type: "imported", originalPath: `/tmp/${filename}` },
    }),
  });
  expect(response.status).toBe(201);
  return (await readJson(response)).asset.id;
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return service.call(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("adopting an item from the library", () => {
  it("creates the item, its base variant and a revision holding the plates", async () => {
    const face = await registerAsset("sara_face.png");
    const body = await registerAsset("sara_body.png");

    const response = await post("/v1/items/adopt", {
      handle: "sara",
      kind: "character",
      name: "Sara Kim",
      plates: [
        { assetId: body, role: "full-body" },
        { assetId: face, role: "face" },
      ],
      traits: [
        { text: "faint scar through the left eyebrow", facet: "face", priority: 0, driftProne: true },
      ],
    });

    expect(response.status).toBe(201);
    const { item } = ItemResponseSchema.parse(await readJson(response));
    expect(item.item.handle).toBe("sara");
    const latest = item.revisions.at(-1);
    expect(latest?.plates.map((plate) => plate.role)).toEqual(["full-body", "face"]);
    // Drag order is the artist saying what matters most; weight is what the
    // resolver spends the budget by.
    expect(latest?.plates.map((plate) => plate.weight)).toEqual([0, 1]);
    expect(latest?.traits[0]?.driftProne).toBe(true);
  });

  it("refuses to adopt an asset that does not exist, without creating the item", async () => {
    const response = await post("/v1/items/adopt", {
      handle: "ghost",
      kind: "prop",
      name: "Ghost",
      plates: [{ assetId: "ast_missing", role: "detail" }],
    });
    expect(response.status).toBe(404);

    const listed = await service.call("/v1/items?query=ghost");
    expect((await readJson(listed)).items).toHaveLength(0);
  });

  it("refuses a handle that is taken", async () => {
    const asset = await registerAsset("dup.png");
    const payload = {
      handle: "duplicate",
      kind: "prop" as const,
      name: "Duplicate",
      plates: [{ assetId: asset, role: "detail" as const }],
    };
    expect((await post("/v1/items/adopt", payload)).status).toBe(201);
    const second = await post("/v1/items/adopt", payload);
    expect(second.status).toBe(409);
  });
});

describe("revisions through the API", () => {
  it("appends a revision and leaves the previous one intact", async () => {
    const asset = await registerAsset("prop.png");
    const created = await post("/v1/items/adopt", {
      handle: "lantern",
      kind: "prop",
      name: "Lantern",
      plates: [{ assetId: asset, role: "detail" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));
    const before = item.revisions.length;

    const revised = await post(`/v1/items/${item.item.id}/revisions`, {
      message: "tightened the description",
      traits: [{ text: "brass, dented", facet: "material", priority: 0, driftProne: false }],
    });
    expect(revised.status).toBe(201);
    const { item: after } = ItemResponseSchema.parse(await readJson(revised));
    expect(after.revisions).toHaveLength(before + 1);
    expect(after.revisions[before - 1]?.traits).toHaveLength(0);
  });

  it("reports a shot as stale once the item it used has been revised", async () => {
    /*
     * The conform pass. A character gets a new costume and every shot made
     * before that is now inconsistent with every shot made after — and until
     * this query nothing could say which, so the choice was to remember or to
     * regenerate everything.
     *
     * A real asset, not a registered filename: the generation has to actually
     * succeed, because a failed shot has nothing to conform.
     */
    const asset = await adoptRealAsset(77);
    const created = await post("/v1/items/adopt", {
      handle: "conform_shot",
      kind: "character",
      name: "Hero",
      plates: [{ assetId: asset, role: "face" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const { job } = (await readJson(
      await post("/v1/generations", {
        providerId: "mock-image",
        operation: "image.generate",
        prompt: "@conform_shot on a rooftop",
        size: "64x64",
        inputAssetIds: [],
        itemMentions: [
          { token: "conform_shot", itemId: item.item.id, influence: 60, tier: "brief" },
        ],
      }),
    )) as { job: { id: string } };
    await service.deps.generation.whenSettled(job.id);

    const jobView = (await readJson(await service.call(`/v1/jobs/${job.id}`))) as {
      job: { generationId?: string };
    };
    const generationId = jobView.job.generationId ?? "";
    expect(service.deps.generations.requireById(generationId).status).toBe("succeeded");

    // Nothing has changed yet, so nothing is stale.
    const before = (await readJson(await service.call("/v1/items/stale"))) as {
      stale: unknown[];
    };
    expect(before.stale).toHaveLength(0);

    await post(`/v1/items/${item.item.id}/revisions`, {
      message: "new coat",
      traits: [
        { text: "long grey coat", facet: "wardrobe", priority: 0, driftProne: true },
      ],
    });

    const after = (await readJson(await service.call("/v1/items/stale"))) as {
      stale: Array<{
        generationId: string;
        items: Array<{ handle: string; usedRevision: number; currentRevision: number }>;
      }>;
    };
    expect(after.stale).toHaveLength(1);
    expect(after.stale[0]?.generationId).toBe(generationId);

    const entry = after.stale[0]?.items[0];
    expect(entry?.handle).toBe("conform_shot");
    expect(entry?.currentRevision).toBeGreaterThan(entry?.usedRevision ?? 0);
  });

  it("does not call a failed shot stale — there is nothing to conform", async () => {
    // A generation that never produced anything cannot be inconsistent with
    // the ones that did, and listing it would bury the shots that matter.
    const created = await post("/v1/items/adopt", {
      handle: "conform_ghost",
      kind: "character",
      name: "Ghost",
      // Registered but with no bytes on disk, so the generation fails.
      plates: [{ assetId: await registerAsset("ghost.png"), role: "face" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const { job } = (await readJson(
      await post("/v1/generations", {
        providerId: "mock-image",
        operation: "image.generate",
        prompt: "@conform_ghost on a rooftop",
        size: "64x64",
        inputAssetIds: [],
        itemMentions: [
          { token: "conform_ghost", itemId: item.item.id, influence: 60 },
        ],
      }),
    )) as { job: { id: string } };
    await service.deps.generation.whenSettled(job.id);

    await post(`/v1/items/${item.item.id}/revisions`, { message: "moved on" });

    const listed = (await readJson(
      await service.call(`/v1/items/stale?itemId=${item.item.id}`),
    )) as { stale: unknown[] };
    expect(listed.stale).toHaveLength(0);
  });

  it("creates a variant that inherits from its parent", async () => {
    const asset = await registerAsset("bar.png");
    const created = await post("/v1/items/adopt", {
      handle: "bar",
      kind: "location",
      name: "The Bar",
      plates: [{ assetId: asset, role: "establishing" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const variant = await post(`/v1/items/${item.item.id}/variants`, {
      slug: "night",
      name: "Night",
    });
    expect(variant.status).toBe(201);

    const detail = await service.call(`/v1/items/${item.item.id}`);
    const { item: full } = ItemResponseSchema.parse(await readJson(detail));
    const nightVariant = full.variants.find((entry) => entry.slug === "night");
    const nightRevision = full.revisions.find(
      (entry) => entry.variantId === nightVariant?.id,
    );
    expect(nightRevision?.plates).toHaveLength(1);
  });
});

describe("renaming", () => {
  it("keeps the old handle resolving", async () => {
    const asset = await registerAsset("rename.png");
    const created = await post("/v1/items/adopt", {
      handle: "oldname",
      kind: "character",
      name: "Old Name",
      plates: [{ assetId: asset, role: "face" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const renamed = await post(`/v1/items/${item.item.id}/rename`, { handle: "newname" });
    expect(renamed.status).toBe(200);

    const listed = await service.call("/v1/items?query=newname");
    expect((await readJson(listed)).items[0]?.handle).toBe("newname");
  });
});

describe("previewing what a prompt would send", () => {
  it("returns the plates, the binding text and the budget without generating", async () => {
    const face = await registerAsset("preview_face.png");
    const created = await post("/v1/items/adopt", {
      handle: "hero",
      kind: "character",
      name: "Hero",
      plates: [{ assetId: face, role: "face" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const response = await post("/v1/items/resolve", {
      prompt: "Wide shot, @hero crossing the bar",
      providerId: "mock-image",
      itemMentions: [{ token: "hero", itemId: item.item.id, influence: 100, muteText: false }],
    });

    expect(response.status).toBe(200);
    const { bundle } = ResolvePromptResponseSchema.parse(await readJson(response));
    expect(bundle.inputAssetIds).toEqual([face]);
    expect(bundle.prompt).toContain("Image 1 crossing the bar");
    expect(bundle.items[0]?.revisionId).toBe(item.revisions.at(-1)?.id);
    expect(bundle.budget.referencesUsed).toBe(1);
  });

  it("says so rather than failing when a mention names an item that is gone", async () => {
    const response = await post("/v1/items/resolve", {
      prompt: "@ghost walks in",
      providerId: "mock-image",
      itemMentions: [{ token: "ghost", itemId: "itm_gone", influence: 100, muteText: false }],
    });
    expect(response.status).toBe(200);
    const { bundle } = ResolvePromptResponseSchema.parse(await readJson(response));
    expect(bundle.warnings.join(" ")).toContain("no longer exists");
    expect(bundle.prompt).toBe("@ghost walks in");
  });
});

describe("generating with an item", () => {
  it("expands the mention, records the revision, and keeps it in the recipe", async () => {
    const face = await registerAsset("gen_face.png");
    const created = await post("/v1/items/adopt", {
      handle: "lead",
      kind: "character",
      name: "Lead",
      plates: [{ assetId: face, role: "face" }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));
    const revisionId = item.revisions.at(-1)?.id as string;

    const started = await post("/v1/generations", {
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "@lead at the window",
      size: "64x64",
      itemMentions: [{ token: "lead", itemId: item.item.id, influence: 100, muteText: false }],
    });
    expect(started.status).toBe(202);
    const { generation } = await readJson(started);

    // The prompt that reached the provider is the expanded one.
    expect(generation.prompt).toContain("Image 1 at the window");
    expect(generation.inputAssetIds).toEqual([face]);
    // And the mentions as typed survive, so a reopened recipe shows @lead.
    expect(generation.parameters.itemMentions[0].token).toBe("lead");
    expect(generation.parameters.itemBundle.items[0].revisionId).toBe(revisionId);

    const usage = await service.call(`/v1/items/${item.item.id}/generations`);
    expect((await readJson(usage)).generations[0]?.id).toBe(generation.id);
  });

  it("refuses rather than quietly dropping an item it cannot resolve", async () => {
    // A prompt that names three characters and sends two is a generation the
    // artist would accept and then wonder about, having paid for it.
    const response = await post("/v1/generations", {
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "@vanished at the window",
      size: "64x64",
      itemMentions: [
        { token: "vanished", itemId: "itm_nope", influence: 100, muteText: false },
      ],
    });
    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toContain("@vanished");
  });
});

describe("item packs", () => {
  it("round-trips a character through a pack, and forks on a handle collision", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");

    const plate = await adoptRealAsset(7);
    const created = await post("/v1/items/adopt", {
      handle: "packed",
      kind: "character",
      name: "Packed",
      plates: [{ assetId: plate, role: "face" }],
      traits: [{ text: "green eyes", facet: "face", priority: 0, driftProne: true }],
    });
    const { item } = ItemResponseSchema.parse(await readJson(created));

    const outDir = await mkdtemp(nodePath.join(tmpdir(), "seed-pack-"));
    const exported = await post(`/v1/items/${item.item.id}/export`, { outDir });
    expect(exported.status).toBe(200);
    const { path: packDir, plates } = await readJson(exported);
    expect(plates).toBe(1);

    // The manifest addresses media by hash, never by a local asset id — and it
    // must not carry an asset:// id, which would export the ability to
    // generate with that likeness.
    const manifest = JSON.parse(await readFile(nodePath.join(packDir, "item.json"), "utf8"));
    expect(manifest.handle).toBe("packed");
    expect(manifest.variants[0].revisions.at(-1).plates[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("asset://");
    expect(JSON.stringify(manifest)).not.toContain(plate);

    const imported = await post("/v1/items/import", { dir: packDir });
    expect(imported.status).toBe(201);
    const body = await readJson(imported);
    // The handle is taken here, so it forks and says so rather than overwriting
    // the character already being generated with.
    expect(body.item.item.handle).toBe("packed_imported");
    expect(body.warnings.join(" ")).toContain("already exists");
    expect(body.item.revisions.at(-1).traits[0].text).toBe("green eyes");
    expect(body.item.revisions.at(-1).plates).toHaveLength(1);
  });

  it("refuses something that is not a pack", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const empty = await mkdtemp(nodePath.join(tmpdir(), "seed-nopack-"));
    const response = await post("/v1/items/import", { dir: empty });
    expect(response.status).toBe(400);
  });
});

describe("reading the plates", () => {
  it("says the feature is unavailable rather than failing obscurely without a key", async () => {
    // The test service has no ANTHROPIC_API_KEY, which is the common case.
    const plate = await adoptRealAsset(21);
    const response = await post("/v1/items/describe", {
      kind: "character",
      plates: [{ assetId: plate, role: "face" }],
    });
    expect(response.status).toBe(422);
    const body = await readJson(response);
    expect(body.error.code).toBe("unsupported_capability");
    // And it says what still works, rather than only what does not.
    expect(body.error.message).toContain("by hand");
  });

  it("refuses a plate that is not in the library", async () => {
    const response = await post("/v1/items/describe", {
      kind: "prop",
      plates: [{ assetId: "ast_nope", role: "detail" }],
    });
    expect([404, 422]).toContain(response.status);
  });
});
