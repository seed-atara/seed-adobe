# Provider Contract

```ts
interface ProviderCapabilities {
  textToImage?: boolean;
  imageToImage?: boolean;
  multipleImageReferences?: boolean;
  textToVideo?: boolean;
  imageToVideo?: boolean;
  multipleVideoReferences?: boolean;
  startFrame?: boolean;
  endFrame?: boolean;
  audioReference?: boolean;
  seed?: boolean;
  cancellation?: boolean;
  maxImageReferences?: number;
  maxVideoReferences?: number;
  durationsSeconds?: number[];
  resolutions?: string[];
}

interface ProviderJob {
  providerJobId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress?: number;
}

interface GenerationProvider {
  id: string;
  capabilities(): Promise<ProviderCapabilities>;
  getJob(jobId: string): Promise<ProviderJob>;
  cancelJob?(jobId: string): Promise<void>;
}
```

Image/video operation-specific interfaces should extend this contract.

## Critical principle

The panel renders controls from `ProviderCapabilities`; it must not assume Seedance features globally.

This keeps the product useful when models change.
