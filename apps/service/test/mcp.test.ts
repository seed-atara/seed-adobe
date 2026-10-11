import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createSeedMcpServer } from "../src/mcp/server.js";

/**
 * Driven through a real MCP client over a real transport, rather than by
 * calling the handlers directly.
 *
 * The handlers are the easy part. What actually breaks when an agent connects
 * is the wiring around them — a schema the SDK rejects, a result shape a
 * client cannot read, a tool that registered but was never listed — and none
 * of that is reachable by calling a function. This is the only arrangement
 * that exercises the thing an agent will meet.
 */

interface Recorded {
  path: string;
  method: string;
  body?: unknown;
  authorization?: string;
}

let calls: Recorded[];
let reply: (path: string) => { status: number; body: unknown };

function stubFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
    });
    const { status, body } = reply(url.pathname);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function connect(): Promise<Client> {
  const server = createSeedMcpServer({
    baseUrl: "http://127.0.0.1:47831",
    token: "test-token",
    fetchImpl: stubFetch(),
  });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** The text of a tool result, which is how every tool here answers. */
function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join("\n");
}

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: {} });
});

describe("SEED over MCP", () => {
  it("lists the tools an agent needs to do a whole job", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    // The full loop: find a plate, transform one frame, measure it, commit to
    // the clip, watch it finish. A missing link here means an agent gets
    // halfway and stops.
    for (const needed of [
      "list_assets",
      "transform_keyframe",
      "check_against_plate",
      "transform_clip",
      "job",
    ]) {
      expect(names).toContain(needed);
    }
  });

  it("sends the session token, and never puts it in a result", async () => {
    const client = await connect();
    reply = () => ({ status: 200, body: { assets: [] } });

    const result = await client.callTool({ name: "list_assets", arguments: {} });

    expect(calls[0]?.authorization).toBe("Bearer test-token");
    expect(resultText(result)).not.toContain("test-token");
  });

  it("passes a transformation through with its arguments intact", async () => {
    const client = await connect();
    reply = () => ({ status: 200, body: { frame: { id: "ast_1" }, job: { job: { id: "job_1" } } } });

    await client.callTool({
      name: "transform_keyframe",
      arguments: { sourceAssetId: "ast_src", change: "the same place in deep winter", atSeconds: 3.5 },
    });

    expect(calls[0]?.path).toBe("/v1/transform/keyframe");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({
      sourceAssetId: "ast_src",
      change: "the same place in deep winter",
      atSeconds: 3.5,
      // Seasonal — the default a director means by "make it winter", applied
      // here rather than left for the agent to remember.
      depth: 50,
    });
  });

  it("surfaces the service's own message rather than a status code", async () => {
    const client = await connect();
    reply = () => ({
      status: 400,
      body: {
        error: {
          code: "unsupported_capability",
          message: "Transforming a plate needs Seedance. Set ARK_API_KEY under Keys.",
        },
      },
    });

    const result = await client.callTool({
      name: "transform_clip",
      arguments: { sourceAssetId: "ast_src", change: "winter" },
    });

    /*
     * The service writes its errors for a person to act on. An agent can act
     * on them too — but only if they survive the trip, which is why the
     * wrapper unwraps the envelope instead of reporting "HTTP 400" and
     * inviting a retry of something that will never work.
     */
    expect(resultText(result)).toContain("needs Seedance");
    expect(resultText(result)).toContain("ARK_API_KEY");
  });

  it("filters assets by kind, so finding a plate does not mean reading the library", async () => {
    const client = await connect();
    reply = () => ({
      status: 200,
      body: {
        assets: [
          { id: "a", kind: "image", filename: "frame.png" },
          { id: "b", kind: "video", filename: "plate.mp4", width: 2560, height: 1440 },
        ],
      },
    });

    const result = await client.callTool({
      name: "list_assets",
      arguments: { kind: "video" },
    });

    expect(resultText(result)).toContain("plate.mp4");
    expect(resultText(result)).not.toContain("frame.png");
  });

  it("offers After Effects as named operations, and says so in the description", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const run = tools.find((tool) => tool.name === "ae_run");

    expect(run).toBeDefined();
    /*
     * The description is load-bearing, not documentation. It is the only thing
     * that tells a model not to try sending script here, and a model that
     * tries gets a refusal it has to recover from — at best a wasted turn, at
     * worst a confident report that the project was changed when it was not.
     */
    expect(run!.description).toMatch(/NAMED OPERATIONS ONLY/);
    expect(run!.description).toMatch(/not an ExtendScript endpoint/);

    // And the status check is there to be called first, for the same reason.
    expect(tools.find((tool) => tool.name === "ae_status")).toBeDefined();
  });

  it("reaches the host bridge rather than the mock adapter", async () => {
    const client = await connect();
    reply = () => ({ status: 200, body: { ok: true, value: { comp: "Comp 1" } } });

    await client.callTool({ name: "ae_run", arguments: { name: "getContext", args: {} } });

    // /v1/host/run is the queue the panel drains. /v1/ae/context is the
    // service's own adapter, which is a mock and would answer with fiction.
    expect(calls[0]?.path).toBe("/v1/host/run");
    expect(calls[0]?.body).toMatchObject({ name: "getContext" });
  });
});
