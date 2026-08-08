import { beforeEach, describe, expect, it } from "vitest";
import type { AssetDraft } from "@seed-ae/domain";
import { AssetRepository, openMigratedDatabase, type Database } from "../src/index.js";

let db: Database;
let assets: AssetRepository;

const draft = (overrides: Partial<AssetDraft> = {}): AssetDraft => ({
  kind: "image",
  filename: "HERO_f00060.png",
  mimeType: "image/png",
  storageUri: "assets/originals/HERO_f00060.png",
  width: 1920,
  height: 1080,
  byteSize: 2048,
  source: {
    type: "after-effects",
    context: {
      compName: "HERO_SHOT_v003",
      width: 1920,
      height: 1080,
      fps: 24,
      frameNumber: 60,
      timeSeconds: 2.5,
    },
    captureFormat: "png",
  },
  ...overrides,
});

beforeEach(() => {
  db = openMigratedDatabase({ path: ":memory:" });
  assets = new AssetRepository(db);
});

describe("AssetRepository", () => {
  it("assigns id, status and createdAt on registration", () => {
    const asset = assets.create(draft());
    expect(asset.id).toMatch(/^ast_/);
    expect(asset.status).toBe("ready");
    expect(Date.parse(asset.createdAt)).not.toBeNaN();
  });

  it("round-trips AE provenance through SQLite", () => {
    const created = assets.create(draft());
    const loaded = assets.requireById(created.id);
    expect(loaded).toEqual(created);
    if (loaded.source.type !== "after-effects") throw new Error("wrong source");
    expect(loaded.source.context.compName).toBe("HERO_SHOT_v003");
    expect(loaded.source.context.frameNumber).toBe(60);
  });

  it("omits absent optional fields rather than returning nulls", () => {
    const asset = assets.create(
      draft({ width: undefined, height: undefined, byteSize: undefined }),
    );
    const loaded = assets.requireById(asset.id);
    expect("width" in loaded).toBe(false);
    expect(loaded.thumbnailUri).toBeUndefined();
  });

  it("lists newest first with paging and a kind filter", () => {
    const first = assets.create(draft({ filename: "a.png" }));
    const second = assets.create(draft({ filename: "b.png" }));
    const video = assets.create(
      draft({
        kind: "video",
        filename: "c.mp4",
        mimeType: "video/mp4",
        storageUri: "assets/generated/c.mp4",
        durationSeconds: 5,
        fps: 24,
      }),
    );

    const all = assets.list();
    expect(all.total).toBe(3);
    expect(all.assets.map((a) => a.id)).toContain(first.id);
    expect(all.assets[0]?.id).toBe(video.id); // newest first

    const page = assets.list({ limit: 1, offset: 1 });
    expect(page.assets).toHaveLength(1);
    expect(page.total).toBe(3);

    const videos = assets.list({ kind: "video" });
    expect(videos.total).toBe(1);
    expect(videos.assets[0]?.id).toBe(video.id);
    expect(second.id).not.toBe(video.id);
  });

  it("orders same-millisecond registrations by insertion, newest first", () => {
    // A burst of captures shares one millisecond; ordering must not depend on
    // how the random ids happen to sort.
    const created = Array.from({ length: 8 }, (_, i) =>
      assets.create(draft({ filename: `burst-${i}.png` })),
    );
    const listed = assets.list().assets.map((a) => a.id);
    expect(listed).toEqual([...created].reverse().map((a) => a.id));
  });

  it("refuses to delete an asset row", () => {
    const asset = assets.create(draft());
    expect(() =>
      db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id),
    ).toThrow(/append-only/);
  });

  it("throws a not_found SeedError for an unknown id", () => {
    expect(() => assets.requireById("ast_missing")).toThrow(/not found/);
    expect(assets.getById("ast_missing")).toBeUndefined();
  });

  it("allows status and thumbnail updates", () => {
    const asset = assets.create(draft());
    expect(assets.updateStatus(asset.id, "missing").status).toBe("missing");
    expect(
      assets.setThumbnail(asset.id, "assets/thumbnails/x.png").thumbnailUri,
    ).toBe("assets/thumbnails/x.png");
  });

  it("refuses to mutate asset identity or provenance", () => {
    const asset = assets.create(draft());
    expect(() =>
      db
        .prepare("UPDATE assets SET storage_uri = ? WHERE id = ?")
        .run("assets/originals/other.png", asset.id),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("UPDATE assets SET source_json = '{}' WHERE id = ?").run(asset.id),
    ).toThrow(/immutable/);
  });

  it("rejects an asset pointing at a generation that does not exist", () => {
    expect(() => assets.create(draft({ generationId: "gen_nope" }))).toThrow(
      /could not register asset/,
    );
  });
});
