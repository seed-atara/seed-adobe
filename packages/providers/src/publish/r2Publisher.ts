import { createHash, createHmac } from "node:crypto";
import { SeedError } from "@seed-ae/domain";
import type { PublicUrlPublisher } from "../ark/assetLibrary.js";

/**
 * Configuration for an S3-compatible bucket used as a handover point.
 *
 * Written against Cloudflare R2, which is where SEED's bucket lives, but the
 * signing is ordinary AWS SigV4 over a path-style endpoint — S3, B2 and MinIO
 * work with the same fields.
 */
export interface R2PublisherConfig {
  /** Account endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * How long a presigned link stays valid.
   *
   * Only has to cover the provider's fetch, which happens when the task is
   * submitted rather than while it renders — so this is short by design.
   */
  urlTtlSeconds?: number;
  /** Namespace inside the bucket. */
  prefix?: string;
  /** R2 convention; S3 needs the bucket's real region. */
  region?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_PREFIX = "seed-ae/";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_REGION = "auto";
const SERVICE = "s3";

/**
 * Hands local bytes to a provider as a short-lived presigned link.
 *
 * This exists because Ark will not take a video inline. Seedance answers
 * `reference_video must be provided as a web url` to a data URL, and
 * `CreateAsset` fetches over https too, so anything larger than an image has to
 * be somewhere ByteDance's servers can reach — see
 * docs/research/MODEL_API_NOTES.md.
 *
 * The bucket stays private. Objects are written under a content-hash key and
 * handed over as presigned GETs, which is the same trust boundary as the data
 * URLs images already travel by: the provider can read exactly the one object,
 * for as long as the signature lives, and nobody else can read anything.
 */
export class R2Publisher implements PublicUrlPublisher {
  private readonly config: R2PublisherConfig;
  private readonly fetchImpl: typeof fetch;
  /** Keys already written this session, so a repeated reference costs nothing. */
  private readonly uploaded = new Set<string>();

  constructor(config: R2PublisherConfig) {
    const missing = (
      ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const
    ).filter((field) => !config[field]?.trim());
    if (missing.length > 0) {
      throw new SeedError(
        "bad_request",
        `R2 hosting needs ${missing.join(", ")} (set SEED_R2_* in .env)`,
      );
    }
    this.config = { ...config, endpoint: config.endpoint.replace(/\/+$/, "") };
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get ttlSeconds(): number {
    return this.config.urlTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /** Where an object lives, without a signature. Not fetchable on its own. */
  objectPath(key: string): string {
    return `/${this.config.bucket}/${encodeKey(key)}`;
  }

  /**
   * The key bytes will be stored under.
   *
   * Content-addressed, so the same media uploaded twice occupies one object and
   * a re-run of the same generation re-uses it. The extension is kept because
   * some fetchers infer a type from the path.
   */
  keyFor(bytes: Buffer, filename: string, mimeType: string): string {
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    return `${this.config.prefix ?? DEFAULT_PREFIX}${digest}${extensionFor(filename, mimeType)}`;
  }

  async publish(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<{ url: string }> {
    const key = this.keyFor(input.bytes, input.filename, input.mimeType);
    if (!this.uploaded.has(key)) {
      await this.put(key, input.bytes, input.mimeType);
      this.uploaded.add(key);
    }
    return { url: this.presign(key) };
  }

  /** PUT an object with SigV4 header auth. Idempotent for identical content. */
  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    const host = hostOf(this.config.endpoint);
    const now = (this.config.now ?? (() => new Date()))();
    const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
    const shortDate = amzDate.slice(0, 8);
    const bodyHash = createHash("sha256").update(bytes).digest("hex");
    const contentType = mimeType || "application/octet-stream";
    const uri = this.objectPath(key);

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${bodyHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonical = [
      "PUT",
      uri,
      "",
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join("\n");

    const { scope, signature } = this.sign(canonical, amzDate, shortDate);

    const response = await this.send(`${this.config.endpoint}${uri}`, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": bodyHash,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      // Node's fetch types do not accept a Buffer directly.
      body: new Uint8Array(bytes),
    });

    if (!response.ok) {
      throw new SeedError(
        "provider_error",
        `R2 PUT ${key} failed: HTTP ${response.status}${await detail(response)}`,
      );
    }
  }

  /**
   * A presigned GET URL for an object, using SigV4 query auth.
   *
   * No network call: the signature is computed locally, which is what makes
   * handing out a link cheap enough to do per request rather than caching one
   * and hoping it is still alive.
   */
  presign(key: string, expiresInSeconds: number = this.ttlSeconds): string {
    const host = hostOf(this.config.endpoint);
    const now = (this.config.now ?? (() => new Date()))();
    const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
    const shortDate = amzDate.slice(0, 8);
    const scope = `${shortDate}/${this.config.region ?? DEFAULT_REGION}/${SERVICE}/aws4_request`;

    // Query parameters are signed in the order they appear, and SigV4 requires
    // that order to be sorted by name — which this list already is.
    const query =
      "X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      `&X-Amz-Credential=${encodeURIComponent(`${this.config.accessKeyId}/${scope}`)}` +
      `&X-Amz-Date=${amzDate}` +
      `&X-Amz-Expires=${Math.max(1, Math.floor(expiresInSeconds))}` +
      "&X-Amz-SignedHeaders=host";

    const uri = this.objectPath(key);
    const canonical = [
      "GET",
      uri,
      query,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const { signature } = this.sign(canonical, amzDate, shortDate);

    return `${this.config.endpoint}${uri}?${query}&X-Amz-Signature=${signature}`;
  }

  /** Removes an object. Not wired into publish(): see the note in bootstrap. */
  async remove(key: string): Promise<void> {
    const host = hostOf(this.config.endpoint);
    const now = (this.config.now ?? (() => new Date()))();
    const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
    const shortDate = amzDate.slice(0, 8);
    const bodyHash = createHash("sha256").update("").digest("hex");
    const uri = this.objectPath(key);

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${bodyHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonical = [
      "DELETE",
      uri,
      "",
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join("\n");
    const { scope, signature } = this.sign(canonical, amzDate, shortDate);

    const response = await this.send(`${this.config.endpoint}${uri}`, {
      method: "DELETE",
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": bodyHash,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    this.uploaded.delete(key);
    if (!response.ok && response.status !== 404) {
      throw new SeedError(
        "provider_error",
        `R2 DELETE ${key} failed: HTTP ${response.status}${await detail(response)}`,
      );
    }
  }

  private sign(
    canonicalRequest: string,
    amzDate: string,
    shortDate: string,
  ): { scope: string; signature: string } {
    const region = this.config.region ?? DEFAULT_REGION;
    const scope = `${shortDate}/${region}/${SERVICE}/aws4_request`;
    const toSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");

    const key = hmac(
      hmac(
        hmac(
          hmac(Buffer.from(`AWS4${this.config.secretAccessKey}`, "utf8"), shortDate),
          region,
        ),
        SERVICE,
      ),
      "aws4_request",
    );
    return {
      scope,
      signature: createHmac("sha256", key).update(toSign, "utf8").digest("hex"),
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 300_000,
    );
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (cause) {
      throw new SeedError("provider_error", `R2 ${init.method} could not reach the bucket`, {
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

function hostOf(endpoint: string): string {
  return new URL(endpoint).host;
}

/** Each path segment is encoded; the separators are not. */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

/**
 * Keeps a recognisable extension on the key.
 *
 * The filename is preferred because it came from the real file; the mime type
 * is the fallback for a name that never had one.
 */
function extensionFor(filename: string, mimeType: string): string {
  const match = /\.([a-zA-Z0-9]{1,5})$/.exec(filename ?? "");
  if (match) return `.${match[1]?.toLowerCase()}`;
  return EXTENSION_BY_MIME[mimeType.split(";")[0]?.trim() ?? ""] ?? "";
}

/** A short body excerpt for an error message; R2 answers XML. */
async function detail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  if (code) return ` (${code}${message ? `: ${message}` : ""})`;
  return body ? ` (${body.slice(0, 200)})` : "";
}
