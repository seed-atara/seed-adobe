import { describe, expect, it } from "vitest";
import type {
  Item,
  ItemKind,
  ItemMention,
  ItemPlate,
  ItemRevision,
  ItemTrait,
  ItemVariant,
  PlateRole,
  ReferenceCapabilities,
} from "@seed-ae/domain";
import { resolveBundle, type MentionBinding } from "../src/resolve.js";
import { plateCapFor } from "../src/budget.js";

const STAMP = "2026-08-17T09:00:00.000Z";

function item(handle: string, kind: ItemKind = "character", extra: Partial<Item> = {}): Item {
  return {
    id: `itm_${handle}`,
    handle,
    kind,
    name: handle,
    tags: [],
    realPerson: false,
    authorisation: "not-required",
    providerGroups: {},
    createdAt: STAMP,
    updatedAt: STAMP,
    ...extra,
  };
}

function variant(itemId: string): ItemVariant {
  return { id: `itv_${itemId}`, itemId, slug: "base", name: "Base", createdAt: STAMP };
}

function plate(assetId: string, role: PlateRole = "reference", weight = 0): ItemPlate {
  return { assetId, role, weight, providerRefs: {} };
}

function trait(text: string, driftProne = false, priority = 0): ItemTrait {
  return { text, facet: "other", priority, driftProne };
}

function revision(
  variantId: string,
  plates: ItemPlate[],
  traits: ItemTrait[] = [],
  extra: Partial<ItemRevision> = {},
): ItemRevision {
  return {
    id: `itr_${variantId}`,
    variantId,
    revision: 1,
    createdAt: STAMP,
    traits,
    avoid: [],
    plates,
    attributes: {},
    ...extra,
  };
}

function mention(handle: string, extra: Partial<ItemMention> = {}): ItemMention {
  return {
    token: handle,
    itemId: `itm_${handle}`,
    influence: 100,
    muteText: false,
    ...extra,
  };
}

function bind(
  handle: string,
  plates: ItemPlate[],
  options: {
    kind?: ItemKind;
    traits?: ItemTrait[];
    mention?: Partial<ItemMention>;
    item?: Partial<Item>;
    revision?: Partial<ItemRevision>;
  } = {},
): MentionBinding {
  const subject = item(handle, options.kind ?? "character", options.item ?? {});
  const subjectVariant = variant(subject.id);
  return {
    mention: mention(handle, options.mention ?? {}),
    definition: {
      item: subject,
      variant: subjectVariant,
      revision: revision(subjectVariant.id, plates, options.traits ?? [], options.revision ?? {}),
    },
  };
}

const SEEDREAM: ReferenceCapabilities = {
  maxImageReferences: 14,
  stableImageReferences: 8,
  addressing: ["hosted-url"],
  nativeGrouping: false,
  requiresBindingText: false,
  mentionSyntax: "positional-en",
  supportsNegativePrompt: false,
  startEndFrames: false,
  framesExcludeReferences: false,
};

const SEEDANCE: ReferenceCapabilities = {
  maxImageReferences: 30,
  stableImageReferences: 8,
  addressing: ["provider-asset-id", "hosted-url"],
  nativeGrouping: true,
  requiresBindingText: true,
  mentionSyntax: "ark-cn",
  supportsNegativePrompt: false,
  startEndFrames: true,
  framesExcludeReferences: true,
};

describe("reference budgeting", () => {
  it("allocates round-robin across items rather than depth-first", () => {
    // The failure this prevents: three characters named in the prompt, all
    // three plates spent on the first, two people described but never shown.
    const bundle = resolveBundle({
      prompt: "@a meets @b and @c",
      bindings: [
        bind("a", [plate("a1"), plate("a2"), plate("a3")]),
        bind("b", [plate("b1"), plate("b2"), plate("b3")]),
        bind("c", [plate("c1"), plate("c2"), plate("c3")]),
      ],
      capabilities: { ...SEEDREAM, stableImageReferences: 3 },
    });

    expect(bundle.inputAssetIds).toEqual(["a1", "b1", "c1"]);
    for (const resolved of bundle.items) {
      expect(resolved.plateAssetIds).toHaveLength(1);
    }
  });

  it("never demotes what the artist attached", () => {
    const bundle = resolveBundle({
      prompt: "@a in the doorway",
      bindings: [bind("a", [plate("a1"), plate("a2")])],
      capabilities: { ...SEEDREAM, stableImageReferences: 2 },
      attachedAssetIds: ["frame"],
      attachedRoles: ["reference"],
    });

    expect(bundle.inputAssetIds[0]).toBe("frame");
    expect(bundle.inputAssetIds).toHaveLength(2);
    expect(bundle.warnings.join(" ")).toContain("already attached");
  });

  it("gives a style item its first plate before a character gets its second", () => {
    /*
     * A look with no plate is a look that does nothing but take up words. What
     * a style item loses is its *second* plate, not its only one — deferring
     * them wholesale was depth-first behaviour wearing a different hat.
     */
    const bundle = resolveBundle({
      prompt: "@hero lit like @look",
      bindings: [
        bind("hero", [plate("h1"), plate("h2")]),
        bind("look", [plate("l1")], { kind: "style" }),
      ],
      capabilities: { ...SEEDREAM, stableImageReferences: 2 },
    });

    expect(bundle.inputAssetIds).toEqual(["h1", "l1"]);
  });

  it("makes the style item lose the next plate once everyone has one", () => {
    const bundle = resolveBundle({
      prompt: "@hero lit like @look",
      bindings: [
        bind("hero", [plate("h1"), plate("h2")]),
        bind("look", [plate("l1"), plate("l2")], { kind: "style" }),
      ],
      capabilities: { ...SEEDREAM, stableImageReferences: 3 },
    });
    // Round one: one each. Round two: the character, not the look.
    expect(bundle.inputAssetIds).toEqual(["h1", "l1", "h2"]);
  });

  it("sorts plates by weight before spending the budget", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("low", "reference", 9), plate("high", "reference", 1)])],
      capabilities: { ...SEEDREAM, stableImageReferences: 1 },
    });
    expect(bundle.inputAssetIds).toEqual(["high"]);
  });

  it("builds the budget against the stable range, not the accepted maximum", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", Array.from({ length: 20 }, (_, i) => plate(`p${i}`)))],
      capabilities: SEEDANCE,
    });
    // Seedance validates 30 and even 64; the published working range is 1-8.
    expect(bundle.inputAssetIds).toHaveLength(8);
    expect(bundle.budget.referencesStable).toBe(8);
    expect(bundle.budget.referencesAvailable).toBe(30);
  });

  it("reaches the hard maximum only when asked knowingly", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", Array.from({ length: 20 }, (_, i) => plate(`p${i}`)))],
      capabilities: SEEDANCE,
      allowBeyondStable: true,
    });
    expect(bundle.inputAssetIds).toHaveLength(20);
  });
});

describe("influence", () => {
  it("scales how many plates an item wins", () => {
    expect(plateCapFor(100, 4)).toBe(4);
    expect(plateCapFor(50, 4)).toBe(2);
    expect(plateCapFor(0, 4)).toBe(0);
    // Any influence at all is worth at least one plate.
    expect(plateCapFor(5, 4)).toBe(1);
  });

  it("at zero sends no plates and lets the text carry the item", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1")], { mention: { influence: 0 }, traits: [trait("green eyes")] })],
      capabilities: SEEDREAM,
    });
    expect(bundle.inputAssetIds).toEqual([]);
    expect(bundle.items[0]?.tier).toBe("full");
    expect(bundle.prompt).toContain("green eyes");
  });
});

describe("text tiers", () => {
  it("drops description when every plate fitted, but keeps what a plate loses", () => {
    /*
     * A scar is exactly what a model drops when it reconstructs from a
     * reference, and no number of plates fixes that — so the tier with every
     * plate is the last place a drift-prone trait should be cut.
     */
    const bundle = resolveBundle({
      prompt: "@a walks in",
      bindings: [
        bind("a", [plate("a1")], {
          traits: [trait("a scar", true), trait("olive jacket", false)],
        }),
      ],
      capabilities: SEEDREAM,
    });
    expect(bundle.items[0]?.tier).toBe("none");
    expect(bundle.prompt).toContain("a scar");
    // What the plate already shows is still never repeated.
    expect(bundle.prompt).not.toContain("olive jacket");
  });

  it("caps `none` tighter than `anchor`, since the references are complete", () => {
    const traits = [
      trait("scar", true, 0),
      trait("tattoo", true, 1),
      trait("gold tooth", true, 2),
    ];
    const complete = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1")], { traits })],
      capabilities: SEEDREAM,
    });
    expect(complete.prompt).toContain("scar, tattoo");
    expect(complete.prompt).not.toContain("gold tooth");

    const partial = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1"), plate("a2")], { traits })],
      capabilities: { ...SEEDREAM, stableImageReferences: 1 },
    });
    expect(partial.items[0]?.tier).toBe("anchor");
    expect(partial.prompt).toContain("gold tooth");
  });

  it("says nothing at all when an item has no drift-prone traits", () => {
    const bundle = resolveBundle({
      prompt: "@a walks in",
      bindings: [bind("a", [plate("a1")], { traits: [trait("olive jacket", false)] })],
      capabilities: SEEDREAM,
    });
    expect(bundle.prompt).not.toContain("olive jacket");
    expect(bundle.prompt).not.toContain("Notes");
  });

  it("keeps only drift-prone traits at anchor", () => {
    const bundle = resolveBundle({
      prompt: "@a walks in",
      bindings: [
        bind("a", [plate("a1"), plate("a2")], {
          traits: [trait("faint scar", true), trait("olive jacket", false)],
        }),
      ],
      capabilities: { ...SEEDREAM, stableImageReferences: 1 },
    });
    expect(bundle.items[0]?.tier).toBe("anchor");
    expect(bundle.prompt).toContain("faint scar");
    expect(bundle.prompt).not.toContain("olive jacket");
  });

  it("falls back to the whole sheet when no plate travelled", () => {
    const bundle = resolveBundle({
      prompt: "@a walks in",
      bindings: [
        bind("a", [], { traits: [trait("faint scar", true), trait("olive jacket")] }),
      ],
      capabilities: SEEDREAM,
    });
    expect(bundle.items[0]?.tier).toBe("full");
    expect(bundle.prompt).toContain("olive jacket");
  });

  it("honours an explicit override and a text mute", () => {
    const overridden = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1")], { mention: { tier: "full" }, traits: [trait("olive jacket")] })],
      capabilities: SEEDREAM,
    });
    expect(overridden.prompt).toContain("olive jacket");

    // Mute is absolute: plates only, whatever the traits are marked.
    const muted = resolveBundle({
      prompt: "@a",
      bindings: [
        bind("a", [], {
          mention: { muteText: true },
          traits: [trait("olive jacket"), trait("a scar", true)],
        }),
      ],
      capabilities: SEEDREAM,
    });
    expect(muted.prompt).not.toContain("olive jacket");
    expect(muted.prompt).not.toContain("a scar");
  });
});

describe("prompt assembly", () => {
  it("puts the artist's direction first and never rewrites it", () => {
    const bundle = resolveBundle({
      prompt: "Wide shot, @a crossing the bar toward camera, handheld.",
      bindings: [bind("a", [plate("a1")], { item: { name: "Sara" } })],
      capabilities: SEEDREAM,
    });
    expect(bundle.prompt.startsWith("Wide shot, Image 1 crossing the bar toward camera, handheld.")).toBe(true);
  });

  it("writes the material mapping where the provider requires it", () => {
    // Ark: 素材映射关系必须写进提示词 — and it must say what not to take.
    const bundle = resolveBundle({
      prompt: "@a at the bar",
      bindings: [bind("a", [plate("a1", "face")], { item: { name: "Sara" } })],
      capabilities: SEEDANCE,
    });
    expect(bundle.prompt).toContain("【素材职责】");
    expect(bundle.prompt).toContain("@图片1 — SARA: face and features.");
    expect(bundle.prompt).toContain("Not its background.");
  });

  it("tells a style plate to give colour and grain only", () => {
    const bundle = resolveBundle({
      prompt: "the alley, @look",
      bindings: [bind("look", [plate("l1", "style-plate")], { kind: "style" })],
      capabilities: SEEDANCE,
    });
    expect(bundle.prompt).toContain("colour, grain and lighting only");
    expect(bundle.prompt).toContain("Not its subject or composition.");
  });

  it("uses positional English where that is the provider's vocabulary", () => {
    const bundle = resolveBundle({
      prompt: "@a and @b",
      bindings: [bind("a", [plate("a1")]), bind("b", [plate("b1")])],
      capabilities: { ...SEEDREAM, requiresBindingText: true },
    });
    expect(bundle.prompt).toContain("Materials:");
    expect(bundle.prompt).toContain("Image 1 — A:");
    expect(bundle.prompt).toContain("Image 2 — B:");
  });

  it("counts the words it is actually sending", () => {
    const bundle = resolveBundle({
      prompt: "one two three",
      bindings: [],
      capabilities: SEEDREAM,
    });
    expect(bundle.budget.promptWords).toBe(3);
  });
});

describe("provider constraints", () => {
  it("drops every plate when a frame anchors the shot, and says so", () => {
    const bundle = resolveBundle({
      prompt: "@a turns to camera",
      bindings: [bind("a", [plate("a1"), plate("a2")], { traits: [trait("olive jacket")] })],
      capabilities: SEEDANCE,
      attachedAssetIds: ["frame"],
      attachedRoles: ["first"],
    });

    expect(bundle.inputAssetIds).toEqual(["frame"]);
    expect(bundle.items[0]?.tier).toBe("full");
    expect(bundle.prompt).toContain("olive jacket");
    expect(bundle.warnings.join(" ")).toContain("will not mix a first or last frame");
  });

  it("sends avoid terms as a negative prompt where one exists", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1")], { revision: { avoid: ["sunglasses", "logos"] } })],
      capabilities: { ...SEEDREAM, supportsNegativePrompt: true },
    });
    expect(bundle.negativePrompt).toBe("sunglasses, logos");
  });

  it("refuses to silently discard avoid terms where there is no negative prompt", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [bind("a", [plate("a1")], { revision: { avoid: ["sunglasses"] } })],
      capabilities: SEEDREAM,
    });
    expect(bundle.negativePrompt).toBeUndefined();
    expect(bundle.warnings.join(" ")).toContain("no negative prompt");
  });

  it("warns before generating with an unauthorised real person", () => {
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [
        bind("a", [plate("a1")], { item: { realPerson: true, authorisation: "pending" } }),
      ],
      capabilities: SEEDANCE,
    });
    expect(bundle.warnings.join(" ")).toContain("real person and is not authorised");
  });
});

describe("reproducibility", () => {
  it("records the exact revision each mention resolved to", () => {
    const binding = bind("a", [plate("a1")]);
    const bundle = resolveBundle({
      prompt: "@a",
      bindings: [binding],
      capabilities: SEEDREAM,
    });
    expect(bundle.items[0]).toMatchObject({
      itemId: binding.definition.item.id,
      variantId: binding.definition.variant.id,
      revisionId: binding.definition.revision.id,
    });
  });

  it("is a pure function of its inputs", () => {
    const request = {
      prompt: "@a meets @b",
      bindings: [bind("a", [plate("a1"), plate("a2")]), bind("b", [plate("b1")])],
      capabilities: { ...SEEDREAM, stableImageReferences: 2 },
    };
    expect(resolveBundle(request)).toEqual(resolveBundle(request));
  });

  it("carries a style item's look binding through to the bundle", () => {
    const bundle = resolveBundle({
      prompt: "@look",
      bindings: [
        bind("look", [plate("l1", "style-plate")], {
          kind: "style",
          revision: { look: { preset: "show-stock", parameters: { grain: 0.4 } } },
        }),
      ],
      capabilities: SEEDREAM,
    });
    expect(bundle.look).toEqual({ preset: "show-stock", parameters: { grain: 0.4 } });
  });
});

describe("mentions in prose", () => {
  it("leaves an unresolvable @ alone", () => {
    const bundle = resolveBundle({
      prompt: "shot at 5pm @ the bar",
      bindings: [],
      capabilities: SEEDREAM,
    });
    expect(bundle.prompt).toBe("shot at 5pm @ the bar");
  });

  it("replaces every occurrence of a mention, including a variant token", () => {
    const binding = bind("a", [plate("a1")]);
    binding.mention.token = "a/night";
    const bundle = resolveBundle({
      prompt: "@a/night walks past @a/night again",
      bindings: [binding],
      capabilities: SEEDREAM,
    });
    expect(bundle.prompt.startsWith("Image 1 walks past Image 1 again")).toBe(true);
  });
});

describe("a crowded shot", () => {
  /** A location, four props, a character and a look — seven identities. */
  function crowd() {
    // Realistic length: a real trait reads "faint scar through the left
    // eyebrow", not "detail one". Length is what makes the shared budget bite.
    const wordy = (name: string) => [
      trait(`${name} has a faint mark across one edge`, true, 0),
      trait(`${name} carries a small stamped brass label`, true, 1),
      trait(`${name} shows one corner worn back to metal`, true, 2),
    ];
    return [
      bind("bar", [plate("bar1"), plate("bar2")], { kind: "location", traits: wordy("bar") }),
      bind("lantern", [plate("l1"), plate("l2")], { kind: "prop", traits: wordy("lantern") }),
      bind("knife", [plate("k1"), plate("k2")], { kind: "prop", traits: wordy("knife") }),
      bind("coat", [plate("c1"), plate("c2")], { kind: "prop", traits: wordy("coat") }),
      bind("glass", [plate("g1"), plate("g2")], { kind: "prop", traits: wordy("glass") }),
      bind("sara", [plate("s1"), plate("s2")], { traits: wordy("sara") }),
      bind("look", [plate("lk1")], { kind: "style", traits: wordy("look") }),
    ];
  }

  it("gives every item a plate before any item gets a second", () => {
    const bundle = resolveBundle({
      prompt: "@bar with @lantern, @knife, @coat, @glass, @sara, @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
      attachedAssetIds: ["frame"],
      attachedRoles: ["reference"],
    });
    // Seven items, eight stable references, one taken by the artist's frame.
    for (const resolved of bundle.items) {
      expect(resolved.plateAssetIds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("still says something about every item when each has only one plate", () => {
    // The case that matters: text has to carry what the plates no longer can,
    // and an item named in the prompt but described nowhere is the worst
    // outcome — the model invents whatever was not said.
    const bundle = resolveBundle({
      prompt: "@bar with @lantern, @knife, @coat, @glass, @sara, @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
    });
    for (const resolved of bundle.items) {
      expect(bundle.prompt).toContain(resolved.handle.toUpperCase());
    }
  });

  it("caps the descriptive text however many items are in the shot", () => {
    /*
     * Binding lines legitimately scale — every material has to be mapped, and
     * that is one line each. What must NOT scale is the descriptive text, so
     * that is what this measures, against the same shot with the budget
     * effectively removed.
     */
    const notes = (bundle: { prompt: string }) => {
      // SEEDANCE declares the ark-cn vocabulary, so the heading is 【细节】.
      const heading = bundle.prompt.includes("Notes:") ? "Notes:" : "【细节】";
      const at = bundle.prompt.indexOf(heading);
      return at < 0
        ? 0
        : bundle.prompt.slice(at + heading.length).trim().split(/\s+/).length;
    };

    const budgeted = resolveBundle({
      prompt: "@bar @lantern @knife @coat @glass @sara @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
    });
    const unbounded = resolveBundle({
      prompt: "@bar @lantern @knife @coat @glass @sara @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
      traitWordBudget: 10_000,
    });

    expect(notes(budgeted)).toBeLessThan(notes(unbounded));
    // Inside the default budget, allowing for the one-trait-each floor.
    expect(notes(budgeted)).toBeLessThanOrEqual(90);
  });

  it("says which traits went unsaid rather than dropping them in silence", () => {
    const bundle = resolveBundle({
      prompt: "@bar @lantern @knife @coat @glass @sara @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
      traitWordBudget: 12,
    });
    expect(bundle.warnings.join(" ")).toContain("left unsaid");
    expect(bundle.warnings.join(" ")).toContain("12-word budget");
  });

  it("gives one trait to every item even under an impossible budget", () => {
    const bundle = resolveBundle({
      prompt: "@bar @lantern @knife @coat @glass @sara @look",
      bindings: crowd(),
      capabilities: SEEDANCE,
      traitWordBudget: 1,
    });
    for (const resolved of bundle.items) {
      expect(bundle.prompt).toContain(resolved.handle.toUpperCase());
    }
  });
});

describe("a looping graphic", () => {
  it("excludes item plates as firmly as any other frame", () => {
    // A loop is both frames at once, so it is still frame mode — and Ark will
    // not mix frames with references.
    const bundle = resolveBundle({
      prompt: "@logo spinning",
      bindings: [bind("logo", [plate("p1")], { kind: "prop", traits: [trait("brass rim", true)] })],
      capabilities: SEEDANCE,
      attachedAssetIds: ["card"],
      attachedRoles: ["loop"],
    });

    expect(bundle.inputAssetIds).toEqual(["card"]);
    expect(bundle.inputRoles).toEqual(["loop"]);
    expect(bundle.items[0]?.tier).toBe("full");
    expect(bundle.warnings.join(" ")).toContain("will not mix a first or last frame");
    // And the item still says its piece, in words.
    expect(bundle.prompt).toContain("brass rim");
  });
});
