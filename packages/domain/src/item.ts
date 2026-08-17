import { z } from "zod";
import { isIsoTimestamp } from "./time.js";

/**
 * Items are the consistency layer: a named identity — a person, a place, a
 * prop, a look — that must appear the same way across many generations.
 *
 * The discipline is deliberately the opposite of an Asset's. An Asset is
 * immutable media; an Item is an identity that evolves, gaining plates and
 * losing them and getting rewritten mid-show. Reproducibility is preserved by
 * splitting the two: the Item is mutable, and every definition it has ever had
 * survives as an immutable `ItemRevision` that a generation records by id.
 *
 * See `docs/product/ITEMS.md` and ADR 0011.
 */

const IsoTimestampSchema = z
  .string()
  .refine(isIsoTimestamp, "expected ISO-8601 UTC timestamp");

export const ItemKindSchema = z.enum([
  "character",
  "location",
  "prop",
  /**
   * A look is an Item too. Midjourney's `--sref`/`--sw` is a structural
   * parallel of `--cref`/`--cw`, and Runway and Kling put style and subject on
   * one reference channel — so a style is the same object with different plate
   * roles, plus an optional binding to the local film-look provider.
   */
  "style",
  "other",
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/**
 * What a plate is *for*. Roles drive the binding text a provider needs, so
 * they are a closed set — but kind only ever *suggests* roles, it never
 * restricts them. A rule that is right nine times in ten is a rule an artist
 * has to fight on the tenth.
 */
export const PlateRoleSchema = z.enum([
  "face",
  "front",
  "three-quarter",
  "profile",
  "back",
  "full-body",
  "wardrobe",
  "detail",
  "texture",
  "in-situ",
  "wide",
  "establishing",
  "style-plate",
  "motion",
  "reference",
]);
export type PlateRole = z.infer<typeof PlateRoleSchema>;

/** Which aspect of an identity a trait describes. */
export const TraitFacetSchema = z.enum([
  "face",
  "hair",
  "body",
  "age",
  "wardrobe",
  "material",
  "scale",
  "setting",
  "light",
  "grade",
  "optics",
  "grain",
  "mood",
  "other",
]);
export type TraitFacet = z.infer<typeof TraitFacetSchema>;

/**
 * One nameable fact about an identity.
 *
 * Structured rather than prose because the resolver has to *cut* it to fit a
 * budget, and a paragraph cannot be cut intelligently. `driftProne` marks the
 * details references reliably lose — a scar, a logo, a specific colour — which
 * are the ones worth spending words on even when plates are present. Text and
 * images are not redundant; they are good at different things.
 */
export const ItemTraitSchema = z.object({
  text: z.string().min(1).max(200),
  facet: TraitFacetSchema.default("other"),
  /** Lower is kept first when the text budget is tight. */
  priority: z.number().int().min(0).default(0),
  driftProne: z.boolean().default(false),
});
export type ItemTrait = z.infer<typeof ItemTraitSchema>;

/**
 * A reference image (or clip) that carries part of an identity.
 *
 * `providerRefs` exists because the same plate is addressed differently by
 * different providers: Ark accepts a permanent `asset://` id for video and
 * rejects it for images, where a hosted URL is the only accepted form. The
 * plate holds every address it has and the adapter picks one it can use.
 */
export const ItemPlateSchema = z.object({
  assetId: z.string().min(1),
  role: PlateRoleSchema.default("reference"),
  /** Lower is kept first when the reference budget is tight. */
  weight: z.number().int().min(0).default(0),
  notes: z.string().max(500).optional(),
  /** providerId -> the id or URL that provider accepts for this plate. */
  providerRefs: z.record(z.string(), z.string()).default({}),
});
export type ItemPlate = z.infer<typeof ItemPlateSchema>;

/** A style Item may carry local film-look settings alongside its plates. */
export const ItemLookBindingSchema = z.object({
  preset: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type ItemLookBinding = z.infer<typeof ItemLookBindingSchema>;

/**
 * An immutable snapshot of what a variant means.
 *
 * This is what a generation records. Recording only the item id would produce
 * recipes that look reproducible and are not: reopening one six weeks later
 * would resolve against whatever the Item had since become.
 */
export const ItemRevisionSchema = z.object({
  id: z.string().min(1),
  variantId: z.string().min(1),
  /** Monotonic per variant, starting at 1. */
  revision: z.number().int().min(1),
  createdAt: IsoTimestampSchema,
  /** Why this revision exists, in one line. */
  message: z.string().max(500).optional(),
  traits: z.array(ItemTraitSchema).max(40).default([]),
  /** Folded into a negative prompt where the provider takes one. */
  avoid: z.array(z.string().min(1).max(120)).max(20).default([]),
  plates: z.array(ItemPlateSchema).max(40).default([]),
  attributes: z.record(z.string(), z.string()).default({}),
  /** Optional anchor. Whether it helps identity is unmeasured. */
  seedHint: z.number().int().optional(),
  look: ItemLookBindingSchema.optional(),
});
export type ItemRevision = z.infer<typeof ItemRevisionSchema>;

/**
 * A deliberate alternate state of one identity — Sara in the red coat, the bar
 * at night. Inherits from a parent variant and overrides part of it, so a
 * variant is a few plates and a trait replaced rather than a second character
 * maintained by hand.
 */
export const ItemVariantSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  /** Typeable without quoting: the `/night` in `@bar/night`. */
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "slug must be lowercase alphanumeric"),
  name: z.string().min(1).max(120),
  parentVariantId: z.string().optional(),
  createdAt: IsoTimestampSchema,
});
export type ItemVariant = z.infer<typeof ItemVariantSchema>;

/**
 * Whether a likeness may be used.
 *
 * Real people are not a flag on a form: Ark requires the subject themselves to
 * complete liveness authentication through their own account, while a purely
 * generated character is automatic. Modelling that as a state means the UI can
 * route to the hand-off rather than failing at generation time.
 */
export const ItemAuthorisationSchema = z.enum([
  "not-required",
  "pending",
  "authorised",
  "refused",
]);
export type ItemAuthorisation = z.infer<typeof ItemAuthorisationSchema>;

export const ItemSchema = z.object({
  id: z.string().min(1),
  /**
   * What `@` resolves. Chosen, never derived from a filename — this is typed a
   * hundred times and a filename-derived token is not a name.
   */
  handle: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "handle must be lowercase alphanumeric"),
  kind: ItemKindSchema,
  name: z.string().min(1).max(120),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  /**
   * Null means studio-wide, which is the default and the inverse of an Asset's
   * rule. Items exist to travel between shows.
   */
  project: z.string().optional(),
  realPerson: z.boolean().default(false),
  authorisation: ItemAuthorisationSchema.default("not-required"),
  /** providerId -> native grouping id (an Ark Asset Group, for instance). */
  providerGroups: z.record(z.string(), z.string()).default({}),
  defaultVariantId: z.string().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Item = z.infer<typeof ItemSchema>;

/** An Item with its variants and their revisions — the shape packs and the API use. */
export const ItemDetailSchema = z.object({
  item: ItemSchema,
  variants: z.array(ItemVariantSchema),
  revisions: z.array(ItemRevisionSchema),
});
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

/* ------------------------------------------------------------------ *
 * Resolution — what `@sara` becomes
 * ------------------------------------------------------------------ */

/**
 * How much prompt text an Item contributes.
 *
 * Binding text — "@image1 is Sara's face; ignore its background" — is present at
 * every tier, because Ark's own guidance requires the material mapping to be
 * written into the prompt and nothing else can carry it. What shrinks as plates
 * fit is *description*, which the plate already carries better than any
 * sentence.
 *
 * `none` is not silence: traits marked drift-prone survive it. They name what a
 * reference loses however many plates travel, so the tier that has every plate
 * is the last place they should be cut.
 */
export const ItemTextTierSchema = z.enum(["none", "anchor", "brief", "full"]);
export type ItemTextTier = z.infer<typeof ItemTextTierSchema>;

/** How the author referred to an Item in prose, plus the controls on the chip. */
export const ItemMentionSchema = z.object({
  /** The text typed, without the leading `@` — may include `/variant`. */
  token: z.string().min(1),
  itemId: z.string().min(1),
  variantId: z.string().optional(),
  /**
   * 0–100. Identity strength and text control pull against each other: locked
   * at maximum, a character cannot be given a new coat by the prompt. Where a
   * provider has no dial this maps to how much of the reference budget the Item
   * wins, and the panel says so rather than implying a knob that is not there.
   */
  influence: z.number().int().min(0).max(100).default(70),
  /** Set only when the artist overrides the automatic tier. */
  tier: ItemTextTierSchema.optional(),
  /** Keep the plates, drop the words. */
  muteText: z.boolean().default(false),
});
export type ItemMention = z.infer<typeof ItemMentionSchema>;

export const ResolvedItemSchema = z.object({
  itemId: z.string(),
  variantId: z.string(),
  revisionId: z.string(),
  handle: z.string(),
  /** The labels the prompt refers to this Item by — "Image 2", "@图片2". */
  labels: z.array(z.string()).default([]),
  tier: ItemTextTierSchema,
  influence: z.number().int(),
  plateAssetIds: z.array(z.string()).default([]),
  droppedPlateAssetIds: z.array(z.string()).default([]),
});
export type ResolvedItem = z.infer<typeof ResolvedItemSchema>;

export const BundleBudgetSchema = z.object({
  referencesUsed: z.number().int().min(0),
  referencesAvailable: z.number().int().min(0),
  /** The provider's *recommended* ceiling, which is what budgets are built on. */
  referencesStable: z.number().int().min(0),
  promptWords: z.number().int().min(0),
});
export type BundleBudget = z.infer<typeof BundleBudgetSchema>;

/**
 * The expanded, provider-ready form of a prompt containing mentions.
 *
 * Persisted on the generation, because *this* is the reproducibility record:
 * an Item resolved at generation time is a snapshot, and the snapshot is what
 * has to come back when the recipe is reopened.
 */
export const ResolvedBundleSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  inputAssetIds: z.array(z.string()).default([]),
  inputRoles: z.array(z.enum(["first", "last", "reference", "loop"])).default([]),
  items: z.array(ResolvedItemSchema).default([]),
  /** Anything clamped, dropped or unavailable — surfaced before Generate, never after. */
  warnings: z.array(z.string()).default([]),
  budget: BundleBudgetSchema,
  /** Look settings contributed by style Items, for an optional finishing pass. */
  look: ItemLookBindingSchema.optional(),
});
export type ResolvedBundle = z.infer<typeof ResolvedBundleSchema>;

/* ------------------------------------------------------------------ *
 * The provider seam
 * ------------------------------------------------------------------ */

/**
 * How references reach a provider. Ark takes a permanent `provider-asset-id`
 * for video and refuses it for images, where `hosted-url` is the only accepted
 * form — so this is a list, best first, not a single value.
 */
export const ReferenceAddressingSchema = z.enum([
  "provider-asset-id",
  "hosted-url",
  "inline",
]);
export type ReferenceAddressing = z.infer<typeof ReferenceAddressingSchema>;

/** How the prompt names a reference. Ark's own syntax is `@图片N`. */
export const MentionSyntaxSchema = z.enum(["positional-en", "ark-cn"]);
export type MentionSyntax = z.infer<typeof MentionSyntaxSchema>;

/**
 * The narrow slice of provider capability the resolver needs.
 *
 * Declared here rather than imported from `@seed-ae/providers` so that
 * `@seed-ae/items` depends on nothing but the domain: the resolver must never
 * branch on a provider id, or the per-model differences leak into it as
 * conditionals and the package stops being liftable. A provider's full
 * `ProviderCapabilities` satisfies this.
 */
export const ReferenceCapabilitiesSchema = z.object({
  /** Hard ceiling the API will accept. */
  maxImageReferences: z.number().int().min(0),
  /**
   * The published *stable* range, which is what budgets are built against.
   * Seedance accepts 30 and validates 64; the documented working range is 1–8.
   * Accepting is not using.
   */
  stableImageReferences: z.number().int().min(0),
  addressing: z.array(ReferenceAddressingSchema).min(1),
  /** Whether the provider has a grouping concept an Item should own. */
  nativeGrouping: z.boolean().default(false),
  /** Ark requires the material mapping to be written into the prompt. */
  requiresBindingText: z.boolean().default(false),
  mentionSyntax: MentionSyntaxSchema.default("positional-en"),
  supportsNegativePrompt: z.boolean().default(false),
  startEndFrames: z.boolean().default(false),
  /**
   * Whether anchoring to a frame excludes references entirely.
   *
   * Measured on Ark: "first/last frame content cannot be mixed with reference
   * media content". Modelled as its own flag rather than inferred from
   * `startEndFrames`, because a provider could plausibly offer both and allow
   * them together, and inferring would make that provider impossible to state.
   */
  framesExcludeReferences: z.boolean().default(false),
});
export type ReferenceCapabilities = z.infer<typeof ReferenceCapabilitiesSchema>;
