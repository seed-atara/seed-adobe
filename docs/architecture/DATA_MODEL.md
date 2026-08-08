# Data Model

## Asset

```ts
type AssetKind = "image" | "video" | "audio" | "other";

interface Asset {
  id: string;
  kind: AssetKind;
  filename: string;
  mimeType: string;
  storageUri: string;
  thumbnailUri?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  createdAt: string;
  generationId?: string;
  source: AssetSource;
}
```

## AE source provenance

```ts
interface AeSource {
  type: "after-effects";
  projectFingerprint?: string;
  projectPath?: string;
  compName: string;
  compId?: string;
  width: number;
  height: number;
  fps: number;
  timeSeconds: number;
  frameNumber: number;
  selectedLayerNames?: string[];
}
```

## Generation

```ts
interface Generation {
  id: string;
  provider: string;
  model: string;
  operation: string;
  prompt: string;
  seed?: number | string;
  parameters: Record<string, unknown>;
  inputAssetIds: string[];
  outputAssetIds: string[];
  parentAssetId?: string;
  parentGenerationId?: string;
  jobId: string;
  createdAt: string;
  rawRequest?: unknown;
  rawResponse?: unknown;
}
```

## Why assets and generations are separate

An asset is media. A generation is the recipe/process that produced media.

One generation may produce multiple outputs. One asset may be reused by many later generations.
