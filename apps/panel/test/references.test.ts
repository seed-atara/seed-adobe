import { describe, expect, it } from "vitest";
import {
  alignRoles,
  isAnchored,
  mixesFrameModes,
  providerForClip,
} from "../src/references.ts";

describe("alignRoles", () => {
  it("fills a short roles array", () => {
    expect(alignRoles(["a", "b"], ["first"])).toEqual(["first", "reference"]);
  });

  it("cuts a roles array that outlived its references", () => {
    // The bug: removing an asset filtered the ids and left the roles, so a
    // "first" survived with no reference under it and disabled Generate.
    expect(alignRoles(["a", "b"], ["reference", "reference", "first"])).toEqual([
      "reference",
      "reference",
    ]);
  });

  it("is empty when there are no references", () => {
    expect(alignRoles([], ["first", "last"])).toEqual([]);
  });
});

describe("mixesFrameModes", () => {
  it("does not fire on a stale role the artist cannot see", () => {
    const roles = alignRoles(["a", "b"], ["reference", "reference", "first"]);
    expect(isAnchored(roles)).toBe(false);
    expect(mixesFrameModes(roles)).toBe(false);
  });

  it("still fires on a genuine mix, which the provider does refuse", () => {
    const roles = alignRoles(["a", "b"], ["first", "reference"]);
    expect(mixesFrameModes(roles)).toBe(true);
  });

  it("allows frames on their own", () => {
    expect(mixesFrameModes(alignRoles(["a", "b"], ["first", "last"]))).toBe(false);
  });
});

describe("providerForClip", () => {
  const look = {
    id: "film-look",
    videoReferences: false,
    operations: ["image.edit"] as const,
  };
  const seedream = {
    id: "seedream",
    videoReferences: false,
    operations: ["image.generate", "image.edit"] as const,
  };
  const seedance = {
    id: "seedance-2-5",
    videoReferences: true,
    operations: ["video.generate"] as const,
  };

  it("moves off a provider that cannot take a clip", () => {
    // The film look accepts one reference and no video, so a clip attached
    // there silently evicts the still captured a moment earlier.
    expect(providerForClip([look, seedream, seedance], "film-look")?.id).toBe(
      "seedance-2-5",
    );
  });

  it("stays put when the current provider already takes clips", () => {
    expect(providerForClip([look, seedance], "seedance-2-5")).toBeUndefined();
  });

  it("leaves the form alone when nothing loaded can take a clip", () => {
    expect(providerForClip([look, seedream], "film-look")).toBeUndefined();
  });
});
