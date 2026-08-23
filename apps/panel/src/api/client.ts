import type {
  AddRevisionRequest,
  AdoptItemRequest,
  Asset,
  DescribeItemRequest,
  DescribeItemResponse,
  ComposeRequest,
  ComposedPlan,
  Generation,
  HealthResponse,
  Item,
  ItemDetail,
  ItemMention,
  JobDto,
  LineageResponse,
  ResolvedBundle,
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
  /** What to build budgets against, which is not always what validation takes. */
  stableImageReferences: number;
  /** Whether the provider wants the material mapping written into the prompt. */
  requiresBindingText: boolean;
  mentionSyntax: "positional-en" | "ark-cn";
  supportsNegativePrompt: boolean;
  /** Whether anchoring to a frame excludes references entirely. */
  framesExcludeReferences: boolean;
  textToVideo: boolean;
  imageToVideo: boolean;
  seed: boolean;
  /** Whether a first and last frame can anchor the shot. */
  startEndFrames: boolean;
  videoReferences: boolean;
  audioReferences: boolean;
  /** Whether the model can score the clip itself. */
  generatesAudio: boolean;
  /** Containers the provider will honour. On Seedance this decides chroma. */
  outputFormats: string[];
  durationSecondsRange?: [number, number];
  sizes: string[];
  aspectRatios: string[];
  async: boolean;
}

/** One measurement and how much the frame supported it. */
/** What an expansion recovered, and where the original sits inside it. */
export interface ExpandCoverage {
  canvas: { width: number; height: number };
  source: { x: number; y: number; width: number; height: number };
  newArea: number;
  recovered: number;
  /** recovered / newArea, 0..1 — the number the decision turns on. */
  coverage: number;
  /** Per edge, because a pan fills one side and leaves the other empty. */
  edges: { left: number; right: number; top: number; bottom: number };
  framesUsed: number;
  framesRejected: number;
  travel: { x: number; y: number };
}

export interface MeasuredDto {
  value: number;
  confidence: number;
}

export interface CameraSignatureDto {
  vignette: MeasuredDto;
  aberration: MeasuredDto;
  grain: MeasuredDto;
  grainSize: MeasuredDto;
  halation: MeasuredDto;
  notes: string[];
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
    samplesDir: string;
      generatedDir: string;
    };
    aeHost: string;
    director: boolean;
    /** Media the host uses to reserve space while a video renders. */
    placeholder: string;
    pproStillPreset?: string;
    /** An H.264 .epr; without it Premiere cannot export a range. */
    pproVideoPreset?: string;
    /** ProRes, for a clip that stays local. Absent when none is exported. */
    pproQualityPreset?: string;
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

  /* ------------------------------------------------------------ passes -- */

  /** The pass catalogue, so the panel does not carry its own prompts. */
  passPresets(): Promise<{
    presets: Array<{
      kind: string;
      label: string;
      purpose: string;
      usableAsIdentity: boolean;
      prompt: string;
    }>;
  }> {
    return this.request("/v1/passes/presets");
  }

  /** Depth and normals, computed here rather than generated. */
  derivePasses(input: {
    sourceAssetId: string;
    kinds: Array<"depth" | "normal">;
    strength?: number;
    detail?: number;
    detailRadius?: number;
    project?: string;
  }): Promise<{ sourceAssetId: string; made: Array<{ kind: string; asset: Asset }> }> {
    return this.request("/v1/passes/derive", { method: "POST", body: input });
  }

  /** Albedo and the rest, which need a provider. */
  startPasses(input: {
    sourceAssetId: string;
    kinds: string[];
    providerId: string;
    lighting?: string;
    project?: string;
  }): Promise<{ started: Array<{ kind: string; job: JobDto }> }> {
    return this.request("/v1/passes", { method: "POST", body: input });
  }

  /** Albedo and normals, lit again. Deterministic; no model runs. */
  relightPasses(input: {
    albedoAssetId: string;
    normalAssetId: string;
    roughnessAssetId?: string;
    occlusionAssetId?: string;
    light?: { x: number; y: number; z: number };
    intensity?: number;
    ambient?: number;
    specular?: number;
    project?: string;
  }): Promise<{ asset: Asset }> {
    return this.request("/v1/passes/relight", { method: "POST", body: input });
  }

  /**
   * How much of a wider frame the footage itself can pay for.
   *
   * Asked before the expensive question, and before any money is spent: a
   * shot that pans has already photographed most of what a reframer would
   * otherwise invent, and this says how much.
   */
  expandCoverage(input: {
    framePaths?: string[];
    frameAssetIds?: string[];
    aspect: string | number;
    sourceRect?: { x: number; y: number; width: number; height: number };
  }): Promise<{ coverage: ExpandCoverage; verdict: string }> {
    return this.request("/v1/expand/coverage", { method: "POST", body: input });
  }

  /** The recovered plate, and a mask of what nobody ever photographed. */
  expandRecover(input: {
    framePaths?: string[];
    frameAssetIds?: string[];
    aspect: string | number;
    sourceRect?: { x: number; y: number; width: number; height: number };
    project?: string;
  }): Promise<{
    coverage: ExpandCoverage;
    verdict: string;
    plate: Asset;
    residual: Asset;
  }> {
    return this.request("/v1/expand/recover", { method: "POST", body: input });
  }

  /** What has already been derived from a shot. */
  listPasses(sourceAssetId: string): Promise<{
    sourceAssetId: string;
    passes: Array<{
      kind: string;
      generationId: string;
      status: string;
      assetIds: string[];
      createdAt: string;
    }>;
  }> {
    return this.request(
      `/v1/passes?sourceAssetId=${encodeURIComponent(sourceAssetId)}`,
    );
  }

  /** Light one shot the way another shot is lit. */
  transferLight(input: {
    referenceAssetId: string;
    referenceAlbedoId: string;
    referenceNormalId: string;
    targetAlbedoId: string;
    targetNormalId: string;
    amount?: number;
    project?: string;
  }): Promise<{ asset: Asset; residual: number; samples: number; note: string }> {
    return this.request("/v1/passes/light-transfer", { method: "POST", body: input });
  }

  /** The camera out of a shot, as film-look settings. */
  transferCamera(input: {
    referenceAssetId: string;
    targetAssetId?: string;
    minimumConfidence?: number;
  }): Promise<{
    settings: Record<string, number>;
    skipped: string[];
    reference: CameraSignatureDto;
    target?: CameraSignatureDto;
    note: string;
  }> {
    return this.request("/v1/passes/camera-transfer", { method: "POST", body: input });
  }

  /**
   * Makes a flat colour frame and puts it in the library.
   *
   * The opening frame for a shot that fades up from black. The provider needs
   * an image, not an adjective in the prompt.
   */
  createSolidAsset(input: {
    width: number;
    height: number;
    red?: number;
    green?: number;
    blue?: number;
    project?: string;
  }): Promise<{ asset: Asset }> {
    return this.request("/v1/assets/solid", { method: "POST", body: input });
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
  /* ---------------------------------------------------------------- *
   * Items
   * ---------------------------------------------------------------- */

  listItems(params: {
    kind?: string;
    project?: string;
    query?: string;
  } = {}): Promise<{ items: Item[]; total: number }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const suffix = search.toString();
    return this.request(`/v1/items${suffix ? `?${suffix}` : ""}`);
  }

  /** Reads the plates and proposes traits. Costs a model call. */
  describeItem(request: DescribeItemRequest): Promise<DescribeItemResponse> {
    return this.request("/v1/items/describe", { method: "POST", body: request });
  }

  getItem(id: string): Promise<{ item: ItemDetail }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}`);
  }

  adoptItem(request: AdoptItemRequest): Promise<{ item: ItemDetail }> {
    return this.request("/v1/items/adopt", { method: "POST", body: request });
  }

  updateItem(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ item: ItemDetail }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}`, {
      method: "POST",
      body: patch,
    });
  }

  /** Only possible while nothing has been generated with it. */
  removeItem(id: string): Promise<{ removed: boolean }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  renameItem(id: string, handle: string): Promise<{ item: ItemDetail }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: { handle },
    });
  }

  createVariant(
    id: string,
    slug: string,
    name: string,
  ): Promise<{ variant: { id: string; slug: string; name: string } }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}/variants`, {
      method: "POST",
      body: { slug, name },
    });
  }

  addRevision(id: string, request: AddRevisionRequest): Promise<{ item: ItemDetail }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}/revisions`, {
      method: "POST",
      body: request,
    });
  }

  itemGenerations(id: string): Promise<{ generations: Generation[] }> {
    return this.request(`/v1/items/${encodeURIComponent(id)}/generations`);
  }

  /** What a prompt would send, without sending it. Costs nothing. */
  resolvePrompt(request: {
    prompt: string;
    providerId: string;
    itemMentions: ItemMention[];
    attachedAssetIds?: string[];
    attachedRoles?: Array<"first" | "last" | "reference" | "loop">;
    allowBeyondStable?: boolean;
  }): Promise<{ bundle: ResolvedBundle }> {
    return this.request("/v1/items/resolve", {
      method: "POST",
      body: request,
    });
  }

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
