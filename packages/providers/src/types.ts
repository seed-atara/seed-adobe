import type {
  GenerationOperation,
  JobStatus,
  ReferenceCapabilities,
} from "@seed-ae/domain";

/**
 * What a provider can actually do. The panel enables controls from this —
 * nothing in the UI may assume a capability that a provider has not declared.
 *
 * Extends `ReferenceCapabilities`, which is the slice `@seed-ae/items` needs to
 * expand an `@item` mention. That slice lives in the domain rather than here so
 * the resolver can stay pure: it reads declared numbers and never learns that
 * Ark exists. Everything a provider does differently about references —
 * addressing, budgets, whether the mapping must be written into the prompt —
 * is therefore data, not a conditional somewhere downstream.
 */
export interface ProviderCapabilities extends ReferenceCapabilities {
  id: string;
  displayName: string;
  /** Model ids come from runtime configuration, never from hard-coded guesses. */
  models: string[];
  operations: GenerationOperation[];
  textToImage: boolean;
  imageToImage: boolean;
  textToVideo: boolean;
  imageToVideo: boolean;
  videoReferences: boolean;
  audioReferences: boolean;
  /**
   * Whether the model can generate a soundtrack of its own.
   *
   * Distinct from audioReferences, which is about audio going *in*. Off by
   * default wherever it is offered: sound is a creative decision, and one that
   * is awkward to undo once it is baked into a clip.
   */
  generatesAudio: boolean;
  seed: boolean;
  durationSecondsRange?: [number, number];
  sizes: string[];
  aspectRatios: string[];
  /** True when results arrive via polling rather than in the initial response. */
  async: boolean;
}

/**
 * An input in a form a provider will accept. Local AE renders are not reachable
 * by URL, so the InputMaterializer converts them before they reach an adapter.
 */
export interface MaterializedInput {
  kind: "url" | "dataUrl" | "base64";
  value: string;
  mimeType: string;
  /** Asset this came from, for lineage. */
  assetId?: string;
}

export interface ProviderRequestBase {
  model: string;
  prompt: string;
  seed?: number | string;
  /** Passed through to the provider after adapter-side normalization. */
  parameters?: Record<string, unknown>;
  correlationId: string;
}

export interface ImageGenerationRequest extends ProviderRequestBase {
  size?: string;
  references?: MaterializedInput[];
}

export interface ImageEditRequest extends ProviderRequestBase {
  size?: string;
  image: MaterializedInput;
  references?: MaterializedInput[];
}

export interface VideoGenerationRequest extends ProviderRequestBase {
  durationSeconds?: number;
  /** Defaults to off; the provider decides what off means on the wire. */
  generateAudio?: boolean;
  aspectRatio?: string;
  firstFrame?: MaterializedInput;
  lastFrame?: MaterializedInput;
  references?: MaterializedInput[];
}

export interface ProviderOutput {
  mimeType: string;
  /** Exactly one of url / base64 is set. */
  url?: string;
  base64?: string;
  width?: number;
  height?: number;
  seed?: number | string;
}

export interface ProviderJobState {
  status: JobStatus;
  /** 0..1 when the provider reports it. */
  progress?: number;
  outputs?: ProviderOutput[];
  error?: { class: string; message: string };
  /** Raw provider payload, persisted so a generation stays debuggable. */
  raw?: unknown;
}

export interface ProviderJob {
  providerJobId: string;
  state: ProviderJobState;
  /** Raw request as sent, minus credentials. */
  rawRequest?: unknown;
}

export interface GenerationProvider {
  readonly id: string;
  capabilities(): Promise<ProviderCapabilities>;
  generateImage?(request: ImageGenerationRequest): Promise<ProviderJob>;
  editImage?(request: ImageEditRequest): Promise<ProviderJob>;
  generateVideo?(request: VideoGenerationRequest): Promise<ProviderJob>;
  getJob(providerJobId: string): Promise<ProviderJobState>;
  cancelJob?(providerJobId: string): Promise<void>;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
