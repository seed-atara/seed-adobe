import type { Asset, Generation } from "@seed-ae/domain";
import type { AssetRepository } from "./assetRepository.js";
import type { GenerationRepository } from "./generationRepository.js";

export interface LineageEdge {
  fromAssetId: string;
  toAssetId: string;
  generationId: string;
}

export interface LineageGraph {
  rootAssetId: string;
  assets: Asset[];
  generations: Generation[];
  edges: LineageEdge[];
}

const MAX_DEPTH = 32;

/**
 * Walks provenance both ways from one asset: up through the generations that
 * produced it, and down through every generation that consumed it.
 *
 * Depth is capped and visited ids are tracked, so a malformed or cyclic
 * lineage degrades to a partial graph instead of hanging the panel.
 */
export function buildLineage(
  assets: AssetRepository,
  generations: GenerationRepository,
  rootAssetId: string,
): LineageGraph {
  const root = assets.requireById(rootAssetId);

  const assetById = new Map<string, Asset>([[root.id, root]]);
  const generationById = new Map<string, Generation>();
  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (fromAssetId: string, toAssetId: string, generationId: string) => {
    const key = `${fromAssetId}->${toAssetId}@${generationId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromAssetId, toAssetId, generationId });
  };

  const loadAsset = (id: string): Asset | undefined => {
    const cached = assetById.get(id);
    if (cached) return cached;
    const asset = assets.getById(id);
    if (asset) assetById.set(id, asset);
    return asset;
  };

  // Upward: this asset's generation, its inputs, and their generations.
  const upward: Array<{ assetId: string; depth: number }> = [
    { assetId: root.id, depth: 0 },
  ];
  const seenUp = new Set<string>();
  while (upward.length > 0) {
    const { assetId, depth } = upward.pop() as { assetId: string; depth: number };
    if (depth >= MAX_DEPTH || seenUp.has(assetId)) continue;
    seenUp.add(assetId);

    const asset = loadAsset(assetId);
    if (!asset?.generationId) continue;
    const generation = generations.getById(asset.generationId);
    if (!generation) continue;
    generationById.set(generation.id, generation);

    for (const inputId of generation.inputAssetIds) {
      if (loadAsset(inputId)) {
        addEdge(inputId, asset.id, generation.id);
        upward.push({ assetId: inputId, depth: depth + 1 });
      }
    }
  }

  // Downward: everything generated from this asset, recursively.
  const downward: Array<{ assetId: string; depth: number }> = [
    { assetId: root.id, depth: 0 },
  ];
  const seenDown = new Set<string>();
  while (downward.length > 0) {
    const { assetId, depth } = downward.pop() as { assetId: string; depth: number };
    if (depth >= MAX_DEPTH || seenDown.has(assetId)) continue;
    seenDown.add(assetId);

    for (const generation of generations.consumersOf(assetId)) {
      generationById.set(generation.id, generation);
      for (const outputId of generation.outputAssetIds) {
        if (loadAsset(outputId)) {
          addEdge(assetId, outputId, generation.id);
          downward.push({ assetId: outputId, depth: depth + 1 });
        }
      }
    }
  }

  return {
    rootAssetId: root.id,
    assets: [...assetById.values()],
    generations: [...generationById.values()],
    edges,
  };
}
