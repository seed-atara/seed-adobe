import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/logger.js";

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("redaction", () => {
  it("removes credential-shaped values at any depth", () => {
    expect(
      redact({
        authorization: "Bearer secret",
        ARK_API_KEY: "abc",
        sessionToken: "t",
        provider: { apiKey: "k", model: "seedream" },
        assetId: "ast_1",
      }),
    ).toEqual({
      authorization: "[redacted]",
      ARK_API_KEY: "[redacted]",
      sessionToken: "[redacted]",
      provider: { apiKey: "[redacted]", model: "seedream" },
      assetId: "ast_1",
    });
  });
});

describe("log envelope", () => {
  it("keeps the event name when a field is also called message", () => {
    const { lines, sink } = capture();
    createLogger("info", sink).warn("request.error", {
      message: "missing session token",
      code: "unauthorized",
    });
    const entry = JSON.parse(lines[0] as string);
    expect(entry.message).toBe("request.error");
    expect(entry.field_message).toBe("missing session token");
    expect(entry.code).toBe("unauthorized");
  });

  it("honours the level threshold", () => {
    const { lines, sink } = capture();
    const logger = createLogger("warn", sink);
    logger.info("ignored");
    logger.error("kept");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).message).toBe("kept");
  });
});
