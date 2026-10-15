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
  /**
   * Containers this provider will honour, best first. Empty means the request
   * has no say — most providers.
   *
   * On Seedance this is not cosmetic: `mov` carries 4:4:4 where `mp4` carries
   * 4:2:0, at the same resolution and for the same money.
   */
  outputFormats: string[];
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
  /**
   * The resolution tier — `480p`, `720p`, `1080p`.
   *
   * A first-class field rather than something fished out of `parameters`,
   * because that is exactly how it went missing: the image requests carry
   * `size` and the video one did not, so the adapter read
   * `parameters.size` and found nothing on every single video generation.
   */
  size?: string;
  durationSeconds?: number;
  /** Defaults to off; the provider decides what off means on the wire. */
  generateAudio?: boolean;
  aspectRatio?: string;
  firstFrame?: MaterializedInput;
  lastFrame?: MaterializedInput;
  references?: MaterializedInput[];
  /**
   * Ask for a cheap 480p draft instead of the full render.
   *
   * Verified from the API rather than from the docs: every Seedance task
   * response this project has stored echoes `"draft": false` alongside
   * `service_tier`, `priority` and `seed`, which is the API telling us the
   * field exists and that we have been defaulting it. ModelArk's own pages
   * render their parameter tables with JavaScript and cannot be read by a
   * fetch, so the echo is the stronger evidence.
   *
   * A draft returns a task id that a later conversion call can upgrade to the
   * full-resolution render of the *same content*, which is the part that
   * matters here: it replaces a re-roll lottery with an approval step.
   */
  draft?: boolean;
  /**
   * The id of a finished 480p draft, to render at full resolution instead.
   *
   * Step 2 of draft mode. The official page says to "use the Draft video task
   * ID returned in Step 1 to call POST /contents/generations/tasks again", and
   * the content of the final matches the draft rather than being a fresh roll.
   * Seedance 2.5 only produces 1080p this way, and the id expires seven days
   * after the draft's `created_at`.
   */
  sourceTaskId?: string;
}

export interface ProviderOutput {
  mimeType: string;
  /** Exactly one of url / base64 is set. */
  url?: string;
  base64?: string;
  width?: number;
  height?: number;
  seed?: number | string;
  /**
   * A still the provider returned alongside a clip.
   *
   * Worth having for any video and necessary for some: a 4:4:4 or HEVC Rext
   * result cannot be decoded by the browser, so the panel's own poster
   * extraction fails and the card would otherwise say "video" forever. A frame
   * from the provider is also a truer frame than one we transcode.
   */
  posterUrl?: string;
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
