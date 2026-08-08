import { useEffect, useState } from "react";
import type { LineageResponse } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { AssetImage, SectionLabel, formatStamp } from "./primitives.tsx";

interface Props {
  client: SeedClient;
  assetId?: string;
  onSelect: (id: string) => void;
}

/**
 * Provenance rail: ancestors above, the selected asset in the middle, and
 * everything derived from it below — the "where did this come from" answer the
 * demo turns on.
 */
export function LineageView({ client, assetId, onSelect }: Props) {
  const [graph, setGraph] = useState<LineageResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setGraph(undefined);
    setError(undefined);
    if (!assetId) return;

    let cancelled = false;
    client
      .lineage(assetId)
      .then((next) => {
        if (!cancelled) setGraph(next);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, assetId]);

  if (!assetId) {
    return (
      <div className="section">
        <SectionLabel>lineage</SectionLabel>
        <div className="empty">Select an asset to trace its provenance.</div>
      </div>
    );
  }

  if (error) return <div className="notice error">{error}</div>;
  if (!graph) return <div className="empty">Loading lineage…</div>;

  const ordered = orderLineage(graph);

  return (
    <div className="section">
      <SectionLabel>
        lineage - {graph.assets.length} asset
        {graph.assets.length === 1 ? "" : "s"}
      </SectionLabel>

      {ordered.length === 1 ? (
        <div className="notice">
          This asset has no ancestors or descendants yet. Generate from it and
          the chain appears here.
        </div>
      ) : null}

      <div className="lineage">
        {ordered.map((node, index) => {
          const asset = graph.assets.find((item) => item.id === node.assetId);
          if (!asset) return null;
          const generation = node.generationId
            ? graph.generations.find((item) => item.id === node.generationId)
            : undefined;

          return (
            <div
              className="lineage-node"
              key={asset.id}
              aria-current={asset.id === graph.rootAssetId}
            >
              <div className="lineage-rail">
                <span onClick={() => onSelect(asset.id)}>
                  <AssetImage
                    client={client}
                    asset={asset}
                    variant="thumbnail"
                    className="lineage-thumb"
                  />
                </span>
                {index < ordered.length - 1 ? (
                  <span className="lineage-connector" />
                ) : null}
              </div>
              <div className="lineage-info">
                <div className="title">
                  {asset.source.type === "after-effects"
                    ? `${asset.source.context.compName ?? "comp"} · frame ${
                        asset.source.context.frameNumber ?? "?"
                      }`
                    : asset.filename}
                </div>
                <div className="via">
                  {generation
                    ? `via ${generation.provider} · ${generation.operation}${
                        generation.seed !== undefined
                          ? ` · seed ${generation.seed}`
                          : ""
                      }`
                    : formatStamp(asset.createdAt)}
                </div>
                {generation ? (
                  <div className="via dim">“{generation.prompt}”</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface LineageNode {
  assetId: string;
  generationId?: string;
}

/**
 * Flattens the graph into a single top-to-bottom chain by walking parents up
 * from the root and children down. Branch siblings are appended after their
 * parent, which is enough structure for a panel this narrow.
 */
function orderLineage(graph: LineageResponse): LineageNode[] {
  const incoming = new Map<string, { from: string; generationId: string }>();
  const children = new Map<string, Array<{ to: string; generationId: string }>>();

  for (const edge of graph.edges) {
    incoming.set(edge.toAssetId, {
      from: edge.fromAssetId,
      generationId: edge.generationId,
    });
    const list = children.get(edge.fromAssetId) ?? [];
    list.push({ to: edge.toAssetId, generationId: edge.generationId });
    children.set(edge.fromAssetId, list);
  }

  const ancestors: LineageNode[] = [];
  let cursor = graph.rootAssetId;
  const guard = new Set<string>([cursor]);
  while (incoming.has(cursor)) {
    const edge = incoming.get(cursor) as { from: string; generationId: string };
    if (guard.has(edge.from)) break;
    guard.add(edge.from);
    ancestors.unshift({ assetId: cursor, generationId: edge.generationId });
    cursor = edge.from;
  }

  const nodes: LineageNode[] = [{ assetId: cursor }, ...ancestors];

  const walk = (assetId: string) => {
    for (const child of children.get(assetId) ?? []) {
      if (nodes.some((node) => node.assetId === child.to)) continue;
      nodes.push({ assetId: child.to, generationId: child.generationId });
      walk(child.to);
    }
  };
  walk(graph.rootAssetId);

  return nodes;
}
