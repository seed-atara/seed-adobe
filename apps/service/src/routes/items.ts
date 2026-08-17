import {
  AddRevisionRequestSchema,
  DescribeItemRequestSchema,
  AdoptItemRequestSchema,
  CreateItemRequestSchema,
  CreateVariantRequestSchema,
  ListItemsQuerySchema,
  RenameItemRequestSchema,
  ResolvePromptRequestSchema,
  SeedError,
  UpdateItemRequestSchema,
  type ItemMention,
} from "@seed-ae/domain";
import { resolveBundle, type MentionBinding } from "@seed-ae/items";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Items: the identities that keep a character, a place, a prop or a look the
 * same across many generations.
 *
 * Nothing here is Adobe-specific and nothing here knows a provider id, which is
 * deliberate — this whole surface is meant to lift out into a studio-wide
 * service later, and a single host-shaped assumption would prevent that.
 */

export function createItemRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(CreateItemRequestSchema, await readJsonBody(req));
    const item = deps.items.create(request);
    return json({ item }, 201);
  };
}

/**
 * The commonest way an item is really born: the artist has just captured the
 * frame that made them want the character, so adopting costs nothing and waits
 * for nothing.
 */
export function adoptItemRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(AdoptItemRequestSchema, await readJsonBody(req));

    // Fail before creating anything if a plate names an asset we do not have.
    for (const plate of request.plates) {
      deps.assets.requireById(plate.assetId);
    }

    const created = deps.items.create({
      handle: request.handle,
      kind: request.kind,
      name: request.name,
      ...(request.project ? { project: request.project } : {}),
      realPerson: request.realPerson,
    });
    const variantId = created.variants[0]?.id as string;

    deps.items.addRevision(variantId, {
      message: "adopted from the library",
      traits: request.traits,
      // Drag order is the artist's statement of what matters most, and weight
      // is what the resolver spends the reference budget by.
      plates: request.plates.map((plate, index) => ({
        assetId: plate.assetId,
        role: plate.role,
        weight: index,
        ...(plate.notes ? { notes: plate.notes } : {}),
        providerRefs: {},
      })),
    });

    const item = deps.items.get(created.item.id);
    return json({ item }, 201);
  };
}

/**
 * Reads the plates and proposes traits.
 *
 * Deliberately not part of creating an item: it costs a model call and a few
 * seconds, and an artist who already knows what matters should not wait for a
 * machine to agree. It also proposes rather than applies, which is ADR 0007's
 * boundary and the reason the panel shows every trait as editable.
 */
export function describeItemRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    if (!deps.describer) {
      throw new SeedError(
        "unsupported_capability",
        "ANTHROPIC_API_KEY is not set, so plates cannot be read for you. Traits can still be written by hand.",
      );
    }
    const request = parseWith(DescribeItemRequestSchema, await readJsonBody(req));
    const plates = request.plates.map((plate) => ({
      asset: deps.assets.requireById(plate.assetId),
      role: plate.role,
    }));
    const result = await deps.describer.describe({
      kind: request.kind,
      ...(request.name ? { name: request.name } : {}),
      plates,
    });
    return json(result);
  };
}

export function listItemsRoute(deps: AppDeps) {
  return ({ url }: RequestContext) => {
    const query = parseWith(
      ListItemsQuerySchema,
      Object.fromEntries(url.searchParams.entries()),
    );
    return json(deps.items.list(query));
  };
}

export function getItemRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const item = requireItem(deps, params.id as string);
    return json({ item });
  };
}

export function updateItemRoute(deps: AppDeps) {
  return async ({ params, req }: RequestContext) => {
    const request = parseWith(UpdateItemRequestSchema, await readJsonBody(req));
    requireItem(deps, params.id as string);
    const item = deps.items.update(params.id as string, request);
    return json({ item });
  };
}

export function renameItemRoute(deps: AppDeps) {
  return async ({ params, req }: RequestContext) => {
    const request = parseWith(RenameItemRequestSchema, await readJsonBody(req));
    requireItem(deps, params.id as string);
    const item = deps.items.rename(params.id as string, request.handle);
    return json({ item });
  };
}

export function createVariantRoute(deps: AppDeps) {
  return async ({ params, req }: RequestContext) => {
    const request = parseWith(CreateVariantRequestSchema, await readJsonBody(req));
    requireItem(deps, params.id as string);
    const variant = deps.items.createVariant(
      params.id as string,
      request.slug,
      request.name,
      request.parentVariantId,
    );
    return json({ variant }, 201);
  };
}

/** Appends. The previous revision stays exactly as every past shot saw it. */
export function addRevisionRoute(deps: AppDeps) {
  return async ({ params, req }: RequestContext) => {
    const request = parseWith(AddRevisionRequestSchema, await readJsonBody(req));
    const detail = requireItem(deps, params.id as string);
    const variantId =
      request.variantId ?? detail.item.defaultVariantId ?? detail.variants[0]?.id;
    if (!variantId) {
      throw new SeedError("not_found", "the item has no variant to revise");
    }
    if (!detail.variants.some((variant) => variant.id === variantId)) {
      throw new SeedError("not_found", `variant ${variantId} does not belong to this item`);
    }
    for (const plate of request.plates ?? []) {
      deps.assets.requireById(plate.assetId);
    }

    deps.items.addRevision(variantId, request);
    return json({ item: deps.items.get(params.id as string) }, 201);
  };
}

/** Where a character has been used — the other half of lineage. */
export function itemGenerationsRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    requireItem(deps, params.id as string);
    const generations = deps.items
      .generationIdsFor(params.id as string)
      .map((id) => deps.generations.getById(id))
      .filter((generation) => generation !== undefined);
    return json({ generations });
  };
}

/**
 * What a prompt would actually send, without sending it.
 *
 * This is the panel's prompt preview and the first thing to look at when a shot
 * comes back wrong: which plates travelled, which were dropped and why, the
 * final text, the word count. It costs nothing, which is the point — the
 * alternative is inferring all of it from a result you have already paid for.
 */
export function resolvePromptRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(ResolvePromptRequestSchema, await readJsonBody(req));
    const provider = deps.registry.get(request.providerId);
    const capabilities = await provider.capabilities();
    const { bindings, warnings } = bindMentions(deps, request.itemMentions);

    const bundle = resolveBundle({
      prompt: request.prompt,
      bindings,
      capabilities,
      attachedAssetIds: request.attachedAssetIds,
      ...(request.attachedRoles ? { attachedRoles: request.attachedRoles } : {}),
      ...(request.allowBeyondStable !== undefined
        ? { allowBeyondStable: request.allowBeyondStable }
        : {}),
    });

    return json({ bundle: { ...bundle, warnings: [...warnings, ...bundle.warnings] } });
  };
}

/**
 * Turns mentions into the definitions they point at.
 *
 * A mention naming an item that no longer exists is reported rather than
 * thrown: the artist is mid-sentence, and refusing to preview a prompt because
 * one handle went stale would be worse than previewing it without them.
 */
export function bindMentions(
  deps: AppDeps,
  mentions: ItemMention[],
): { bindings: MentionBinding[]; warnings: string[] } {
  const bindings: MentionBinding[] = [];
  const warnings: string[] = [];

  for (const mention of mentions) {
    const detail = deps.items.get(mention.itemId);
    if (!detail) {
      warnings.push(`@${mention.token} no longer exists and was left as written.`);
      continue;
    }
    const variant = mention.variantId
      ? detail.variants.find((entry) => entry.id === mention.variantId)
      : (detail.variants.find((entry) => entry.id === detail.item.defaultVariantId) ??
        detail.variants[0]);
    if (!variant) {
      warnings.push(`@${mention.token} has no variant to resolve.`);
      continue;
    }
    const revision = deps.items.latestRevision(variant.id);
    if (!revision) {
      warnings.push(`@${mention.token} has no revision yet and contributed nothing.`);
      continue;
    }
    bindings.push({ mention, definition: { item: detail.item, variant, revision } });
  }

  return { bindings, warnings };
}

function requireItem(deps: AppDeps, id: string) {
  const item = deps.items.get(id);
  if (!item) throw new SeedError("not_found", `no item ${id}`);
  return item;
}
