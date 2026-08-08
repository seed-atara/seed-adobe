import { createHash, createHmac } from "node:crypto";

/**
 * BytePlus/Volcengine OpenAPI request signing (a SigV4 variant).
 *
 * This is a *different* credential system from the inference API: the asset
 * library is signed with an account AK/SK pair, while `images/generations` uses
 * `Authorization: Bearer <ARK_API_KEY>`. They are not interchangeable.
 *
 * Differences from AWS SigV4 worth noting, because they are what break naive
 * ports: the timestamp header is `X-Date` (not `X-Amz-Date`), the body hash
 * header is `X-Content-Sha256`, and the credential scope terminator is the
 * literal `request` (not `aws4_request`).
 */
export interface ArkSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ArkSignatureInput {
  method: string;
  host: string;
  /** Canonical query string, already in the order it will be sent. */
  query: string;
  path?: string;
  body: Buffer;
  contentType?: string;
  region: string;
  service: string;
  /** Injectable for deterministic tests. */
  date?: Date;
}

export interface ArkSignedHeaders {
  authorization: string;
  "content-type": string;
  "x-date": string;
  "x-content-sha256": string;
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signArkRequest(
  credentials: ArkSigningCredentials,
  input: ArkSignatureInput,
): ArkSignedHeaders {
  const now = input.date ?? new Date();
  const xDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const shortDate = xDate.slice(0, 8);

  const path = input.path ?? "/";
  const contentType = input.contentType ?? "application/json; charset=utf-8";
  const bodyHash = sha256Hex(input.body);

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${input.host}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `x-date:${xDate}\n`;
  const signedHeaders = "content-type;host;x-content-sha256;x-date";

  const canonicalRequest = [
    input.method.toUpperCase(),
    path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const scope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(Buffer.from(credentials.secretAccessKey, "utf8"), shortDate),
        input.region,
      ),
      input.service,
    ),
    "request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    authorization:
      `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": contentType,
    "x-date": xDate,
    "x-content-sha256": bodyHash,
  };
}
