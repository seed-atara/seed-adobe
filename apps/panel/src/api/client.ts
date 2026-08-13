import type {
  Asset,
  ComposeRequest,
  ComposedPlan,
  Generation,
  HealthResponse,
  JobDto,
  LineageResponse,
  StartGenerationRequest,
} from "@seed-ae/domain";

export interface ProviderCapabilitiesDto {
  id: string;
  displayName: string;
  models: string[];
  operations: string[];
  textToImage: boolean;
  imageToImage: boolean;
  maxImageReferences: number;
  textToVideo: boolean;
  imageToVideo: boolean;
  seed: boolean;
  /** Whether a first and last frame can anchor the shot. */
  startEndFrames: boolean;
  videoReferences: boolean;
  audioReferences: boolean;
  /** Whether the model can score the clip itself. */
  generatesAudio: boolean;
  durationSecondsRange?: [number, number];
  sizes: string[];
  aspectRatios: string[];
  async: boolean;
}

export interface JobView {
  job: JobDto;
  generation?: Generation;
  outputs: Asset[];
}

export interface RecipeView {
  recipe: StartGenerationRequest & { model: string };
  generation: Generation;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Typed client for the local SEED service. Every panel network call goes
 * through here so the token, error shape and base URL live in one place.
 */
export class SeedClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  withToken(token: string): SeedClient {
    return new SeedClient(this.baseUrl, token);
  }

  /**
   * Fetches asset bytes for display.
   *
   * An <img src> cannot carry an Authorization header, and putting the session
   * token in the URL would leak it into logs and history — so images are
   * fetched here and handed to the DOM as object URLs.
   */
  async assetBlob(asset: Asset, variant?: "thumbnail"): Promise<Blob> {
    const useThumbnail = variant === "thumbnail" && asset.thumbnailUri;
    const path = `/v1/assets/${asset.id}/file${useThumbnail ? "?variant=thumbnail" : ""}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new ServiceError(
        "not_found",
        `could not load media for ${asset.id}`,
        response.status,
      );
    }
    return response.blob();
  }

  health(): Promise<HealthResponse> {
    return this.request("/health");
  }

  providers(): Promise<{ providers: ProviderCapabilitiesDto[] }> {
    return this.request("/v1/providers");
  }

  /**
   * Turns a described scene into a proposed generation.
   *
   * Returns a plan only — nothing is queued. The panel fills its form from it
   * and the artist presses Generate.
   */
  compose(request: ComposeRequest): Promise<{ plan: ComposedPlan }> {
    return this.request("/v1/agent/compose", { method: "POST", body: request });
  }

  aeContext(): Promise<{ context: Record<string, unknown>; host: string }> {
    return this.request("/v1/ae/context");
  }

  captureFrame(): Promise<{ asset: Asset; warning?: string }> {
    return this.request("/v1/ae/capture-frame", { method: "POST", body: {} });
  }

  /** Absolute workspace paths, needed when the panel drives AE itself. */
  workspace(): Promise<{
    workspace: {
      projectRoot: string;
      root: string;
      originalsDir: string;
      generatedDir: string;
    };
    aeHost: string;
    director: boolean;
    /** Media the host uses to reserve space while a video renders. */
    placeholder: string;
    pproStillPreset?: string;
    /** An H.264 .epr; without it Premiere cannot export a range. */
    pproVideoPreset?: string;
  }> {
    return this.request("/v1/workspace");
  }

  assetPath(id: string): Promise<{ path: string; filename: string }> {
    return this.request(`/v1/assets/${id}/path`);
  }

  /** Registers a frame the CEP panel rendered out of After Effects itself. */
  registerCapture(input: {
    path: string;
    context: Record<string, unknown>;
    width?: number;
    height?: number;
  }): Promise<{ asset: Asset; warning?: string }> {
    return this.request("/v1/ae/register-capture", {
      method: "POST",
      body: input,
    });
  }

  /**
   * Stores a poster the panel extracted from a clip.
   *
   * The service has no video decoder; this browser does. Sending the frame
   * back is what turns a borrowed still into a real one.
   */
  setPoster(assetId: string, pngBase64: string): Promise<{ asset: Asset }> {
    return this.request(`/v1/assets/${assetId}/poster`, {
      method: "POST",
      body: { png: pngBase64 },
    });
  }

  /** Registers a span of the timeline the panel rendered to an mp4. */
  registerClip(input: {
    path: string;
    posterPath?: string;
    context: Record<string, unknown>;
    width?: number;
    height?: number;
    durationSeconds?: number;
    fps?: number;
  }): Promise<{ asset: Asset }> {
    return this.request("/v1/ae/register-clip", { method: "POST", body: input });
  }

  /**
   * Copies a file from anywhere on disk into the library.
   *
   * The manual route to a motion reference: whatever the artist exported, from
   * whichever application, becomes an asset SEED can reference.
   */
  adoptFile(path: string, project?: string): Promise<{ asset: Asset }> {
    return this.request("/v1/assets/adopt", {
      method: "POST",
      body: { path, ...(project ? { project } : {}) },
    });
  }

  listAssets(
    params: { limit?: number; kind?: string; project?: string } = {},
  ): Promise<{
    assets: Asset[];
    total: number;
  }> {
    const query = new URLSearchParams();
    query.set("limit", String(params.limit ?? 60));
    if (params.kind) query.set("kind", params.kind);
    if (params.project) query.set("project", params.project);
    return this.request(`/v1/assets?${query.toString()}`);
  }

  getAsset(id: string): Promise<{ asset: Asset }> {
    return this.request(`/v1/assets/${id}`);
  }

  lineage(id: string): Promise<LineageResponse> {
    return this.request(`/v1/assets/${id}/lineage`);
  }

  recipe(id: string): Promise<RecipeView> {
    return this.request(`/v1/assets/${id}/recipe`);
  }

  startGeneration(request: Record<string, unknown>): Promise<JobView> {
    return this.request("/v1/generations", { method: "POST", body: request });
  }

  /** Writes the look as a .cube and reports where, and what it cannot carry. */
  lookLut(request: {
    preset: string;
    intensity: number;
  }): Promise<{ path: string; filename: string; missing: string[] }> {
    return this.request("/v1/look/lut", { method: "POST", body: request });
  }

  job(id: string): Promise<JobView> {
    return this.request(`/v1/jobs/${id}`);
  }

  cancelJob(id: string): Promise<JobView> {
    return this.request(`/v1/jobs/${id}/cancel`, { method: "POST", body: {} });
  }

  importAsset(
    assetId: string,
    insertAtPlayhead: boolean,
  ): Promise<{
    name: string;
    insertedAtPlayhead: boolean;
    /** Present only from the CEP bridge, which knows the timeline. */
    trackName?: string;
    movedFromTargeted?: string;
  }> {
    return this.request("/v1/ae/import", {
      method: "POST",
      body: { assetId, insertAtPlayhead },
    });
  }

  /**
   * Removes an asset from the library and deletes its media.
   *
   * The record survives so recipes that used it still resolve; only the bytes
   * and the library entry go. Not undoable.
   */
  removeAsset(id: string): Promise<{
    id: string;
    filesRemoved: number;
    usedBy: number;
  }> {
    return this.request(`/v1/assets/${id}`, { method: "DELETE" });
  }

  /** The stand-in card, in the shape the render will be. */
  placeholder(
    width: number,
    height: number,
    tag?: string,
  ): Promise<{ path: string }> {
    const query = `width=${Math.round(width)}&height=${Math.round(height)}` +
      (tag ? `&tag=${encodeURIComponent(tag)}` : "");
    return this.request(`/v1/placeholder?${query}`);
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch (cause) {
      throw new ServiceError(
        "unreachable",
        "Cannot reach the SEED service. Is it running?",
        0,
      );
    }

    if (response.status === 204) return undefined as T;

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } })
        ?.error;
      throw new ServiceError(
        error?.code ?? "internal_error",
        error?.message ?? `Request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return payload as T;
  }
}

/** Same-origin by default so the Vite proxy and a CEP build both work. */
export const DEFAULT_BASE_URL =
  typeof window !== "undefined" && window.location.protocol.startsWith("http")
    ? ""
    : "http://127.0.0.1:47831";
