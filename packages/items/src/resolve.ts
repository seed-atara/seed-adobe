import type {
  BundleBudget,
  Item,
  ItemLookBinding,
  ItemMention,
  ItemPlate,
  ItemRevision,
  ItemTextTier,
  ItemVariant,
  ReferenceCapabilities,
  ResolvedBundle,
  ResolvedItem,
} from "@seed-ae/domain";
import {
  bindingLine,
  candidateTraits,
  countWords,
  referenceLabel,
  traitCapForTier,
  traitLine,
  type PlateBinding,
} from "./binding.js";
import {
  DEFAULT_TRAIT_WORD_BUDGET,
  allocatePlates,
  allocateTraits,
  type AllocationInput,
  type TraitAllocationInput,
} from "./budget.js";
import { parseMentions, replaceMentions } from "./mentions.js";
import { orderPlatesForShot, readShotIntent } from "./shot.js";

/**
 * Expanding `@sara` into a provider-ready request.
 *
 * Pure by design and by rule: no network, no database, no Adobe, and — the part
 * that matters — **no provider ids**. Everything a provider does differently
 * arrives as declared `ReferenceCapabilities`, so per-model behaviour is data
 * rather than conditionals and this package stays liftable into a studio-wide
 * service. See ADR 0011.
 */

/** An Item resolved to the exact definition a mention points at. */
export interface ResolvableItem {
  item: Item;
  variant: ItemVariant;
  revision: ItemRevision;
}

export interface MentionBinding {
  mention: ItemMention;
  definition: ResolvableItem;
}

export interface ResolveRequest {
  /** The artist's words, containing `@handle` runs. Never rewritten. */
  prompt: string;
  bindings: MentionBinding[];
  capabilities: ReferenceCapabilities;
  /** What the artist attached themselves. Always kept; never demoted. */
  attachedAssetIds?: string[];
  attachedRoles?: Array<"first" | "last" | "reference" | "loop">;
  /** Raise the ceiling from the stable range to the hard maximum, knowingly. */
  allowBeyondStable?: boolean;
  /**
   * How many words every item together may add.
   *
   * Shared rather than per-item, so seven items do not make a prompt seven
   * times longer. See `DEFAULT_TRAIT_WORD_BUDGET`.
   */
  traitWordBudget?: number;
}

const MANIFEST_HEADING = { "positional-en": "Materials:", "ark-cn": "【素材职责】" };
const NOTES_HEADING = { "positional-en": "Notes:", "ark-cn": "【细节】" };

export function resolveBundle(request: ResolveRequest): ResolvedBundle {
  const { capabilities: caps } = request;
  const warnings: string[] = [];
  const attachedAssetIds = request.attachedAssetIds ?? [];
  const attachedRoles = attachedAssetIds.map(
    (_, index) => request.attachedRoles?.[index] ?? "reference",
  );

  /*
   * A first or last frame is the shot's own geometry; a plate is identity. Ark
   * refuses to mix them at all — "first/last frame content cannot be mixed with
   * reference media content" — so when the artist has anchored the shot to a
   * frame, no plate can travel and the Items have to speak entirely in text.
   * This is the tiering rule doing its most useful work.
   */
  // A loop is both frames at once, so it excludes references just as firmly.
  const hasFrame = attachedRoles.some(
    (role) => role === "first" || role === "last" || role === "loop",
  );
  const framesBlockPlates = hasFrame && caps.framesExcludeReferences;

  const ceiling = request.allowBeyondStable
    ? caps.maxImageReferences
    : Math.min(caps.maxImageReferences, caps.stableImageReferences || caps.maxImageReferences);

  const attachedReferenceCount = attachedRoles.filter((role) => role === "reference").length;
  let available = Math.max(0, ceiling - attachedReferenceCount);
  if (framesBlockPlates) {
    available = 0;
    warnings.push(
      "This shot is anchored to a frame, and the provider will not mix a first or last frame with references. No item plates were sent; every item is describing itself in text instead.",
    );
  }

  /*
   * What the prompt says about the shot, so each Item can send the plates that
   * suit it rather than the first ones in its list. An unrecognised prompt
   * yields nothing and plate order falls back to weight, exactly as before.
   */
  const intent = readShotIntent(request.prompt);

  const allocationInputs: AllocationInput[] = request.bindings.map((binding, index) => ({
    itemIndex: index,
    plates: orderPlatesForShot(binding.definition.revision.plates, intent),
    influence: binding.mention.influence,
    deferred: binding.definition.item.kind === "style",
  }));

  const { taken, droppedByItem } = allocatePlates(allocationInputs, available);

  // The artist's own inputs come first; plates follow in allocation order.
  const inputAssetIds = [...attachedAssetIds, ...taken.map((entry) => entry.plate.assetId)];
  const inputRoles: Array<"first" | "last" | "reference" | "loop"> = [
    ...attachedRoles,
    ...taken.map(() => "reference" as const),
  ];

  const platesByItem = new Map<number, Array<{ plate: ItemPlate; position: number }>>();
  taken.forEach((entry, order) => {
    const position = attachedAssetIds.length + order + 1;
    const list = platesByItem.get(entry.itemIndex) ?? [];
    list.push({ plate: entry.plate, position });
    platesByItem.set(entry.itemIndex, list);
  });

  /*
   * Tiers first, then words — because how much an item may say depends on how
   * many of its plates travelled, and how much it *actually* says depends on
   * what every other item in the shot is also trying to say.
   */
  const tiers = request.bindings.map((binding, index) =>
    tierFor(
      binding.mention,
      binding.definition.revision.plates.length,
      (platesByItem.get(index) ?? []).length,
    ),
  );
  const traitInputs: TraitAllocationInput[] = request.bindings.map((binding, index) => ({
    itemIndex: index,
    candidates: binding.mention.muteText
      ? []
      : candidateTraits(binding.definition.revision.traits, tiers[index] as ItemTextTier),
    cap: traitCapForTier(tiers[index] as ItemTextTier),
  }));
  const traitsByItem = allocateTraits(
    traitInputs,
    request.traitWordBudget ?? DEFAULT_TRAIT_WORD_BUDGET,
  );

  const spans = spansFor(request.prompt, request.bindings);
  const manifestLines: string[] = [];
  const noteLines: string[] = [];
  const avoid: string[] = [];
  const resolvedItems: ResolvedItem[] = [];
  const replacements: Array<{ start: number; end: number; label: string }> = [];
  let look: ItemLookBinding | undefined;

  request.bindings.forEach((binding, index) => {
    const { item, variant, revision } = binding.definition;
    const fitted = platesByItem.get(index) ?? [];
    const dropped = droppedByItem.get(index) ?? [];
    const tier = tiers[index] as ItemTextTier;
    const labels = fitted.map((entry) =>
      referenceLabel(caps.mentionSyntax, entry.position, plateMediaKind(entry.plate)),
    );
    const displayName = item.name.toUpperCase();

    if (tier !== "none" || caps.requiresBindingText) {
      const bindings: PlateBinding[] = fitted.map((entry, at) => ({
        label: labels[at] as string,
        role: entry.plate.role,
      }));
      const line = bindingLine(displayName, item.kind, bindings);
      if (line) manifestLines.push(line);
    }

    /*
     * Already cut to the shared budget, and already empty when the artist
     * ticked "plates only" — that box means the item contributes no words at
     * all, which stopped being the same thing as the `none` tier once
     * drift-prone traits started surviving it.
     */
    const traits = traitsByItem.get(index) ?? [];
    const note = traitLine(displayName, traits);
    if (note) noteLines.push(note);
    avoid.push(...revision.avoid);

    if (revision.look) {
      if (look) {
        warnings.push(
          `@${item.handle} also carries look settings; the first style item's look is used and this one is ignored.`,
        );
      } else {
        look = revision.look;
      }
    }

    if (item.realPerson && item.authorisation !== "authorised") {
      warnings.push(
        `@${item.handle} is a real person and is not authorised yet (${item.authorisation}). The provider is likely to refuse this generation.`,
      );
    }

    const wantedTraits = traitInputs[index]?.candidates.length ?? 0;
    if (wantedTraits > traits.length && !binding.mention.muteText) {
      const unsaid = wantedTraits - traits.length;
      warnings.push(
        `@${item.handle}: ${unsaid} trait${unsaid === 1 ? "" : "s"} left unsaid — ${request.bindings.length} item${request.bindings.length === 1 ? "" : "s"} are sharing a ${request.traitWordBudget ?? DEFAULT_TRAIT_WORD_BUDGET}-word budget so the direction still leads.`,
      );
    }

    if (dropped.length > 0) {
      warnings.push(
        `@${item.handle}: ${revision.plates.length} plate${revision.plates.length === 1 ? "" : "s"} declared, ${fitted.length} fitted — ${describeShortfall(caps, attachedReferenceCount, framesBlockPlates)}. Text raised to \`${tier}\` to compensate.`,
      );
    }

    // The prompt refers to the item by its first label, never by a raw id.
    const primaryLabel = labels[0] ?? displayName;
    for (const span of spans.get(index) ?? []) {
      replacements.push({ ...span, label: primaryLabel });
    }

    resolvedItems.push({
      itemId: item.id,
      variantId: variant.id,
      revisionId: revision.id,
      handle: item.handle,
      labels,
      tier,
      influence: binding.mention.influence,
      plateAssetIds: fitted.map((entry) => entry.plate.assetId),
      droppedPlateAssetIds: dropped.map((plate) => plate.assetId),
    });
  });

  const direction = replaceMentions(request.prompt, replacements).trim();
  const sections = [direction];
  if (manifestLines.length > 0) {
    sections.push(`${MANIFEST_HEADING[caps.mentionSyntax]}\n${manifestLines.join("\n")}`);
  }
  if (noteLines.length > 0) {
    sections.push(`${NOTES_HEADING[caps.mentionSyntax]}\n${noteLines.join("\n")}`);
  }
  const prompt = sections.filter(Boolean).join("\n\n");

  let negativePrompt: string | undefined;
  const uniqueAvoid = [...new Set(avoid)];
  if (uniqueAvoid.length > 0) {
    if (caps.supportsNegativePrompt) {
      negativePrompt = uniqueAvoid.join(", ");
    } else {
      warnings.push(
        `This provider has no negative prompt, so ${uniqueAvoid.length} "avoid" term${uniqueAvoid.length === 1 ? "" : "s"} could not be sent: ${uniqueAvoid.join(", ")}.`,
      );
    }
  }

  const budget: BundleBudget = {
    referencesUsed: inputAssetIds.length,
    referencesAvailable: caps.maxImageReferences,
    referencesStable: caps.stableImageReferences || caps.maxImageReferences,
    promptWords: countWords(prompt),
  };

  return {
    prompt,
    ...(negativePrompt ? { negativePrompt } : {}),
    inputAssetIds,
    inputRoles,
    items: resolvedItems,
    warnings,
    budget,
    ...(look ? { look } : {}),
  };
}

/**
 * How much text an Item contributes.
 *
 * Description shrinks as plates fit, because the plate carries appearance
 * better than a sentence does. Binding does not shrink — nothing else can say
 * which material is for what.
 */
export function tierFor(
  mention: ItemMention,
  declared: number,
  fitted: number,
): ItemTextTier {
  if (mention.tier) return mention.tier;
  if (mention.muteText) return "none";
  if (declared === 0 || fitted === 0) return "full";
  if (fitted >= declared) return "none";
  if (fitted >= Math.ceil(declared / 2)) return "anchor";
  return "brief";
}



function plateMediaKind(plate: ItemPlate): "image" | "video" {
  return plate.role === "motion" ? "video" : "image";
}

function describeShortfall(
  caps: ReferenceCapabilities,
  attached: number,
  framesBlocked: boolean,
): string {
  if (framesBlocked) return "a first or last frame excludes references entirely";
  const ceiling = caps.stableImageReferences || caps.maxImageReferences;
  if (attached > 0) {
    return `the provider works reliably with ${ceiling} reference${ceiling === 1 ? "" : "s"} and ${attached} ${attached === 1 ? "was" : "were"} already attached`;
  }
  return `the provider works reliably with ${ceiling} reference${ceiling === 1 ? "" : "s"}`;
}

/** Where each binding's token appears in the prompt, matched by token text. */
function spansFor(
  prompt: string,
  bindings: MentionBinding[],
): Map<number, Array<{ start: number; end: number }>> {
  const parsed = parseMentions(prompt);
  const spans = new Map<number, Array<{ start: number; end: number }>>();
  bindings.forEach((binding, index) => {
    const token = binding.mention.token.toLowerCase();
    const matches = parsed
      .filter((mention) => mention.token.toLowerCase() === token)
      .map((mention) => ({ start: mention.start, end: mention.end }));
    if (matches.length > 0) spans.set(index, matches);
  });
  return spans;
}
