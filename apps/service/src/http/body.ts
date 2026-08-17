import type { IncomingMessage } from "node:http";
import { SeedError } from "@seed-ae/domain";
import type { ZodType } from "zod";

/** JSON bodies on this service are small recipes, never media. */
export const MAX_JSON_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
    throw new SeedError(
      "bad_request",
      `expected application/json, received ${contentType}`,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new SeedError("bad_request", "request body is too large", {
        httpStatus: 413,
      });
    }
    chunks.push(buffer);
  }

  if (total === 0) return undefined;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw new SeedError("bad_request", "request body is not valid JSON", {
      cause,
    });
  }
}

export function parseWith<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    /*
     * Name the fields in the message, not only in `details`.
     *
     * The panel shows the message and drops the rest, so "request failed
     * validation" was all an artist ever saw — true, and useless. It cost a
     * round trip to find a double-encoded body that the field name would have
     * pointed at immediately.
     */
    const summary = issues
      .slice(0, 4)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .join("; ");
    throw new SeedError(
      "bad_request",
      `request failed validation — ${summary}${issues.length > 4 ? `, and ${issues.length - 4} more` : ""}`,
      { details: issues },
    );
  }
  return result.data;
}
