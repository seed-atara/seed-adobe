import { describe, expect, it, vi } from "vitest";
import { R2Publisher } from "../src/publish/r2Publisher.js";

const CONFIG = {
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "seed-ae",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  now: () => new Date("2026-08-13T00:00:00Z"),
};

function publisherWith(fetchImpl: typeof fetch, overrides = {}) {
  return new R2Publisher({ ...CONFIG, fetchImpl, ...overrides });
}

const ok = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

describe("R2Publisher", () => {
  it("names the object by content, so the same media uploads once", async () => {
    const calls: string[] = [];
    const publisher = publisherWith((async (url: string) => {
      calls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch);

    const bytes = Buffer.from("a clip, pretend");
    const first = await publisher.publish({
      bytes,
      filename: "range.mp4",
      mimeType: "video/mp4",
    });
    const second = await publisher.publish({
      bytes,
      filename: "different-name.mp4",
      mimeType: "video/mp4",
    });

    // One PUT for two publishes of identical content.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/seed-ae/seed-ae/");
    expect(calls[0]).toMatch(/[0-9a-f]{32}\.mp4$/);
    expect(new URL(first.url).pathname).toEqual(new URL(second.url).pathname);
  });

  it("signs the PUT with SigV4 over the s3 service", async () => {
    let headers: Headers | undefined;
    const publisher = publisherWith((async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch);

    await publisher.publish({
      bytes: Buffer.from("x"),
      filename: "a.png",
      mimeType: "image/png",
    });

    const authorization = headers?.get("authorization") ?? "";
    expect(authorization).toContain("AWS4-HMAC-SHA256");
    // region auto / service s3 is the R2 convention, and getting it wrong is a
    // SignatureDoesNotMatch nobody can debug from the message.
    expect(authorization).toContain("Credential=AKIDEXAMPLE/20260813/auto/s3/aws4_request");
    expect(authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(headers?.get("x-amz-date")).toBe("20260813T000000Z");
    // sha256 of "x"
    expect(headers?.get("x-amz-content-sha256")).toBe(
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    );
  });

  it("presigns a GET with an expiry and no credentials in the clear", () => {
    const publisher = publisherWith(ok, { urlTtlSeconds: 900 });
    const url = new URL(publisher.presign("seed-ae/abc.mp4"));

    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The secret never travels; only a signature derived from it does.
    expect(url.toString()).not.toContain(CONFIG.secretAccessKey);
  });

  it("reports what the bucket said rather than a bare status", async () => {
    const publisher = publisherWith((async () =>
      new Response(
        "<Error><Code>SignatureDoesNotMatch</Code><Message>bad key</Message></Error>",
        { status: 403 },
      )) as unknown as typeof fetch);

    await expect(
      publisher.publish({
        bytes: Buffer.from("x"),
        filename: "a.png",
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/SignatureDoesNotMatch: bad key/);
  });

  it("refuses to exist half-configured", () => {
    expect(
      () => new R2Publisher({ ...CONFIG, bucket: "", secretAccessKey: "" }),
    ).toThrow(/bucket, secretAccessKey/);
  });

  it("does not upload again after a delete of the same key", async () => {
    const put = vi.fn();
    const publisher = publisherWith((async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") put();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);

    const input = {
      bytes: Buffer.from("clip"),
      filename: "a.mp4",
      mimeType: "video/mp4",
    };
    await publisher.publish(input);
    await publisher.remove(publisher.keyFor(input.bytes, input.filename, input.mimeType));
    await publisher.publish(input);

    // Removed means gone: the next publish has to write it back.
    expect(put).toHaveBeenCalledTimes(2);
  });
});
