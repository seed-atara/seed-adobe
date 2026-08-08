# After Effects Host Contract

```ts
interface AeContext {
  projectName?: string;
  projectPath?: string;
  compName?: string;
  compId?: string;
  width?: number;
  height?: number;
  fps?: number;
  timeSeconds?: number;
  frameNumber?: number;
  selectedLayers?: Array<{ id?: string; name: string }>;
}

interface CapturedMedia {
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  sourceContext: AeContext;
}

interface AeHostAdapter {
  getActiveContext(): Promise<AeContext>;
  captureCurrentFrame(options?: {
    includeAlpha?: boolean;
    format?: "png" | "exr";
  }): Promise<CapturedMedia>;
  importMedia(path: string): Promise<{ projectItemId?: string; name: string }>;
  insertAtPlayhead?(
    projectItemId: string,
    options?: { trackAboveSelected?: boolean }
  ): Promise<void>;
}
```

## Implementation policy

Maintain:
- `MockAeHostAdapter` for tests/dev.
- one actual Adobe implementation selected after official compatibility verification.

Do not put provider networking into the host adapter.
