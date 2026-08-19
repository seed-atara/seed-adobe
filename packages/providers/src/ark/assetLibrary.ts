import { createHash } from "node:crypto";
import { SeedError } from "@seed-ae/domain";
import type { ArkOpenApiClient, AssetRecord } from "./openapi.js";

/**
 * Publishes bytes at a URL Ark can fetch over https.
 *
 * `CreateAsset` will not accept a `data:` URL — it fetches the file itself — so
 * a local AE render has to be reachable at request time. A short-lived
 * presigned S3/R2/GCS link is the intended implementation: nothing has to stay
 * permanently public, because the asset persists after ingestion.
 */
export interface PublicUrlPublisher {
  publish(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<{ url: string; dispose?: () => Promise<void> }>;
}

export interface AssetLibraryOptions {
  client: ArkOpenApiClient;
  publisher?: PublicUrlPublisher;
  /** Asset group to register into; created on first use if absent. */
  groupName?: string;
  /** Bypasses the content pre-filter. Only works if disabled account-side. */
  skipModeration?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedAsset {
  assetId: string;
  /** True when an existing registration was reused. */
  cached: boolean;
}

const DEFAULT_GROUP = "seed-ae";

/**
 * Registers reference images in the Ark asset library and hands back
 * `asset://<id>` URIs.
 *
 * Two behaviours matter for cost and latency: registration is free but slow
 * (~10s), and generation is paid but interactive — so assets are deduped by
 * content hash and cached, and can be registered ahead of time.
 */
export class ArkAssetLibrary {
  private readonly client: ArkOpenApiClient;
  private readonly options: AssetLibraryOptions;
  /** sha16 -> assetId, so a repeated reference costs nothing. */
  private readonly cache = new Map<string, string>();
  private groupId: string | undefined;

  constructor(options: AssetLibraryOptions) {
    this.client = options.client;
    this.options = options;
  }

  get hasPublisher(): boolean {
    return this.options.publisher !== undefined;
  }

  static contentHash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  }

  async ensureGroup(): Promise<string> {
    if (this.groupId) return this.groupId;
    const name = this.options.groupName ?? DEFAULT_GROUP;

    const existing = await this.client.listAssetGroups(name);
    const match = (existing.Items ?? []).find((group) => group.Name === name);
    if (match?.Id) {
      this.groupId = match.Id;
      return match.Id;
    }

    const created = await this.client.createAssetGroup(name);
    if (!created?.Id) {
      throw new SeedError("provider_error", `could not create asset group ${name}`);
    }
    this.groupId = created.Id;
    return created.Id;
  }

  /**
   * Resolves bytes to an asset id, registering them only if the same content is
   * not already in the library. The name carries the content hash so any
   * machine can find an existing registration without a shared database.
   */
  async ensureAsset(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<ResolvedAsset> {
    const sha16 = ArkAssetLibrary.contentHash(input.bytes);

    const local = this.cache.get(sha16);
    if (local) return { assetId: local, cached: true };

    /*
     * A lookup failure is not a registration failure. ListAssets answered
     * InternalError once on 2026-08-20 and the whole ensureAsset threw, so the
     * caller fell back to a plain link and the generation was refused as "may
     * contain real person" — the exact outcome this library exists to prevent,
     * caused by a cache miss.
     *
     * Worst case of pressing on is a duplicate asset, which is free and
     * permanent. That is a far better trade than losing the protected route to
     * a transient error on someone else's service.
     */
    const remote = await this.findByHash(sha16).catch(() => undefined);
    if (remote) {
      this.cache.set(sha16, remote);
      return { assetId: remote, cached: true };
    }

    const publisher = this.options.publisher;
    if (!publisher) {
      throw new SeedError(
        "unsupported_capability",
        "Registering an Ark asset needs a public URL publisher: CreateAsset " +
          "fetches the file over https and rejects data: URLs. Configure one, " +
          "or use the inline reference policy.",
      );
    }

    const stem = input.filename.replace(/\.[^.]+$/, "").slice(0, 48);
    const name = `${sanitize(stem)}_${sha16}`;
    const groupId = await this.ensureGroup();

    const published = await publisher.publish(input);
    let assetId: string;
    try {
      const created = await this.client.createAsset({
        groupId,
        url: published.url,
        name,
        assetType: assetTypeFor(input.mimeType),
        ...(this.options.skipModeration ? { skipModeration: true } : {}),
      });
      if (!created?.Id) {
        throw new SeedError("provider_error", "CreateAsset returned no asset id");
      }
      assetId = created.Id;
      // Ark fetches the file while the asset preprocesses, not at CreateAsset,
      // so the link has to outlive the call that used it.
      await this.waitUntilActive(assetId);
    } finally {
      // The asset persists after ingestion, so the temporary link can go.
      await published.dispose?.().catch(() => undefined);
    }

    this.cache.set(sha16, assetId);
    return { assetId, cached: false };
  }

  private async findByHash(sha16: string): Promise<string | undefined> {
    const found = await this.client.listAssets({ name: sha16 });
    const active = (found.Items ?? []).find(
      (asset: AssetRecord) =>
        asset.Status === "Active" && (asset.Name ?? "").includes(sha16),
    );
    return active?.Id;
  }

  private async waitUntilActive(assetId: string): Promise<void> {
    const interval = this.options.pollIntervalMs ?? 4000;
    const timeout = this.options.pollTimeoutMs ?? 240_000;
    const sleep =
      this.options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));

    const attempts = Math.max(1, Math.ceil(timeout / Math.max(interval, 1)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const info = await this.client.getAsset(assetId);
      if (info.Status === "Active") return;
      if (info.Status === "Failed") {
        throw new SeedError(
          "provider_error",
          `Ark asset ${assetId} failed preprocessing`,
          { details: { status: info.Status } },
        );
      }
      await sleep(interval);
    }
    throw new SeedError(
      "provider_error",
      `Ark asset ${assetId} was still processing after ${timeout}ms`,
    );
  }
}

function assetTypeFor(mimeType: string): "Image" | "Video" | "Audio" {
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  return "Image";
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "reference";
}
