import { SeedError } from "@seed-ae/domain";
import { signArkRequest, type ArkSigningCredentials } from "./signer.js";

export interface ArkOpenApiConfig extends ArkSigningCredentials {
  /** e.g. open.byteplusapi.com — some accounts need open.ap-southeast-1.byteplusapi.com */
  host?: string;
  region?: string;
  service?: string;
  version?: string;
  /** ProjectName sent with asset calls. */
  projectName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export const ARK_OPENAPI_DEFAULTS = {
  host: "open.byteplusapi.com",
  region: "ap-southeast-1",
  service: "ark",
  version: "2024-01-01",
  projectName: "default",
} as const;

export interface AssetGroup {
  Id: string;
  Name?: string;
}

export interface AssetRecord {
  Id: string;
  Name?: string;
  Status?: "Processing" | "Active" | "Failed" | string;
  URL?: string;
}

/**
 * Thin client over the BytePlus/Volcengine OpenAPI actions the asset library
 * needs. Every call is signed; nothing here uses the inference API key.
 */
export class ArkOpenApiClient {
  private readonly host: string;
  private readonly region: string;
  private readonly service: string;
  private readonly version: string;
  readonly projectName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly config: ArkOpenApiConfig) {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new SeedError(
        "unauthorized",
        "the Ark asset library needs an account AK/SK pair",
      );
    }
    this.host = config.host ?? ARK_OPENAPI_DEFAULTS.host;
    this.region = config.region ?? ARK_OPENAPI_DEFAULTS.region;
    this.service = config.service ?? ARK_OPENAPI_DEFAULTS.service;
    this.version = config.version ?? ARK_OPENAPI_DEFAULTS.version;
    this.projectName = config.projectName ?? ARK_OPENAPI_DEFAULTS.projectName;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.now = config.now ?? (() => new Date());
  }

  async call<T = Record<string, unknown>>(
    action: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const query = `Action=${action}&Version=${this.version}`;
    const headers = signArkRequest(this.config, {
      method: "POST",
      host: this.host,
      query,
      body: payload,
      region: this.region,
      service: this.service,
      date: this.now(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    let parsed: unknown;
    try {
      response = await this.fetchImpl(`https://${this.host}/?${query}`, {
        method: "POST",
        headers: { ...headers, host: this.host },
        body: payload,
        signal: controller.signal,
      });
      parsed = await response.json().catch(() => undefined);
    } catch (cause) {
      throw new SeedError("provider_error", `${action} request failed`, { cause });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404 && parsed === undefined) {
      throw new SeedError(
        "provider_error",
        `${action}: HTTP 404 with no error body — this usually means the wrong ` +
          `OpenAPI host. Try open.${this.region}.byteplusapi.com.`,
      );
    }
    if (!response.ok && parsed === undefined) {
      throw new SeedError(
        "provider_error",
        `${action}: HTTP ${response.status}`,
      );
    }

    const metadata = (parsed as { ResponseMetadata?: { Error?: ArkError } })
      ?.ResponseMetadata;
    if (metadata?.Error) {
      throw toSeedError(action, metadata.Error);
    }

    const result = (parsed as { Result?: T })?.Result;
    return (result ?? (parsed as T)) as T;
  }

  /** `Filter` is required — omitting it is a 400. */
  listAssetGroups(name?: string) {
    return this.call<{ Items?: AssetGroup[] }>("ListAssetGroups", {
      PageNumber: 1,
      PageSize: 50,
      Filter: { GroupType: "AIGC", ...(name ? { Name: name } : {}) },
    });
  }

  createAssetGroup(name: string) {
    return this.call<AssetGroup>("CreateAssetGroup", {
      Name: name,
      Description: name,
      ProjectName: this.projectName,
    });
  }

  createAsset(options: {
    groupId: string;
    /** Must be publicly reachable https at request time. `data:` URLs are rejected. */
    url: string;
    name: string;
    assetType?: "Image" | "Video" | "Audio";
    skipModeration?: boolean;
  }) {
    return this.call<AssetRecord>("CreateAsset", {
      GroupId: options.groupId,
      URL: options.url,
      AssetType: options.assetType ?? "Image",
      Name: options.name,
      ProjectName: this.projectName,
      ...(options.skipModeration ? { Moderation: { Strategy: "Skip" } } : {}),
    });
  }

  getAsset(id: string) {
    return this.call<AssetRecord>("GetAsset", {
      Id: id,
      ProjectName: this.projectName,
    });
  }

  /** `Name` is a fuzzy match, which is what makes content-hash lookup work. */
  listAssets(options: { groupId?: string; name?: string } = {}) {
    return this.call<{ Items?: AssetRecord[] }>("ListAssets", {
      PageNumber: 1,
      PageSize: 100,
      Filter: {
        GroupType: "AIGC",
        ...(options.groupId ? { GroupIds: [options.groupId] } : {}),
        ...(options.name ? { Name: options.name } : {}),
      },
    });
  }
}

interface ArkError {
  Code?: string;
  Message?: string;
}

/** Maps the documented failure codes onto explanations that name the fix. */
function toSeedError(action: string, error: ArkError): SeedError {
  const code = error.Code ?? "Unknown";
  const message = error.Message ?? "no message";

  if (code === "ModelNotOpen") {
    return new SeedError(
      "provider_error",
      "Model is not activated for this account. Enable it in the Ark console; " +
        "some models also require an available resource package.",
      { details: { action, code } },
    );
  }
  if (code === "InvalidParameter.DownloadFailed") {
    return new SeedError(
      "provider_error",
      "Ark could not fetch the reference URL. It must be publicly reachable " +
        "over https at request time — a presigned link may have expired.",
      { details: { action, code } },
    );
  }
  if (code === "InvalidParameter.FormatUnsupported") {
    return new SeedError(
      "bad_request",
      "Wrong AssetType for the file, or an unsupported container.",
      { details: { action, code } },
    );
  }
  if (code === "InvalidParameter.FpsTooLow") {
    return new SeedError(
      "bad_request",
      "Video assets must have a frame rate between 23.8 and 60 fps.",
      { details: { action, code } },
    );
  }
  return new SeedError("provider_error", `${action}: ${code}: ${message}`, {
    details: { action, code },
  });
}
