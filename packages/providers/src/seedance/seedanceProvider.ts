import { SeedError } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  VideoGenerationRequest,
} from "../types.js";

export interface SeedanceConfig {
  baseUrl?: string;
  apiKey?: string;
  /** Model id from configuration. Empty until official access is granted. */
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Seedance 2.5 — the intended hero video provider.
 *
 * DELIBERATELY UNIMPLEMENTED. The endpoint path, request fields, job/polling
 * semantics and reference-input rules have NOT been verified against official
 * ByteDance/Volcengine documentation, and this project's rules forbid inferring
 * them from consumer UI, older Seedance APIs, third-party write-ups or
 * marketing material.
 *
 * What is needed to finish this adapter:
 *   1. Official endpoint + auth scheme for video generation.
 *   2. Request schema: prompt, duration, resolution/aspect, reference inputs,
 *      start/end frame semantics, seed support.
 *   3. Job lifecycle: is it synchronous or a submit + poll flow, and what does
 *      the status payload look like?
 *   4. Result delivery: URL with what lifetime, or inline data?
 *
 * Until then the demo path runs on MockVideoProvider, and this class reports
 * itself unavailable rather than pretending to work.
 */
export class SeedanceProvider implements GenerationProvider {
  readonly id = "seedance";

  constructor(private readonly config: SeedanceConfig = {}) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.model && this.config.baseUrl);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    // Everything below is reported as unavailable on purpose. Capabilities are
    // meant to describe verified behaviour, and none of it is verified yet.
    return {
      id: this.id,
      displayName: "Seedance 2.5 (pending official API access)",
      models: this.config.model ? [this.config.model] : [],
      operations: [],
      textToImage: false,
      imageToImage: false,
      maxImageReferences: 0,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: false,
      startEndFrames: false,
      audioReferences: false,
      seed: false,
      sizes: [],
      aspectRatios: [],
      async: true,
    };
  }

  async generateVideo(_request: VideoGenerationRequest): Promise<ProviderJob> {
    throw new SeedError(
      "unsupported_capability",
      "The Seedance 2.5 API contract has not been verified. Use the mock video " +
        "provider until official documentation and access are available.",
    );
  }

  async getJob(_providerJobId: string): Promise<ProviderJobState> {
    throw new SeedError(
      "unsupported_capability",
      "Seedance job polling is unimplemented pending the official contract.",
    );
  }
}
