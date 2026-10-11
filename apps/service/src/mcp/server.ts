import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { animatePrompt, estimateTokens, tierFor } from "@seed-ae/domain";
import { z } from "zod";

/**
 * SEED as a set of tools an agent can call directly.
 *
 * The panel is a good way for a person to run one job and look at the result.
 * It is a poor way to run nine variations, measure each against the plate and
 * keep the two that held — which is the shape of most real work, and the shape
 * an agent is actually useful for.
 *
 * ## Why this wraps HTTP rather than importing the service
 *
 * It would be shorter to construct the repositories here and call the routes
 * in-process. It would also mean two live processes holding the same SQLite
 * file and the same workspace, with the panel's service already running — and
 * a second writer to a database the artist is actively using is not a thing to
 * introduce for the sake of saving a fetch. So this is a client: one service,
 * one owner of the data, and the MCP process can come and go without the
 * panel noticing.
 *
 * ## Two groups of tools, and the second one is different
 *
 * Most tools here are *media* operations — generate, restore, transform,
 * measure — which touch the library and nothing else. The library is designed
 * to be appended to: assets are immutable, edits create descendants, and
 * nothing an agent does there can destroy work.
 *
 * The `ae_*` tools are not like that. They reach into the project the artist
 * has open, through the panel, and they only work while the artist has
 * switched the agent on in the panel. That switch is the point: the service's
 * session token is the security boundary, and the switch is the artist
 * *knowing*. Both halves refuse anything outside a published allowlist of
 * named operations — never a script. See `host/commands.ts`.
 */

export interface McpOptions {
  /** Where the SEED service is listening. */
  baseUrl: string;
  /** The session token from .env. Never logged, never echoed into a result. */
  token: string;
  fetchImpl?: typeof fetch;
}

/** A tool result, in the shape MCP wants. */
function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

export function createSeedMcpServer(options: McpOptions): McpServer {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const response = await doFetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { raw };
    }

    if (!response.ok) {
      /*
       * The service's own message, surfaced rather than replaced. Those
       * messages are written for a person — "Restoring a clip needs Seedance.
       * Set ARK_API_KEY and a Seedance model id under Keys." — and an agent
       * reading them can act on them, where "HTTP 400" tells it to retry
       * something that will never work.
       */
      const message =
        (parsed as { error?: { message?: string } })?.error?.message ??
        `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return parsed;
  }

  const server = new McpServer({ name: "seed-ae", version: "0.1.0" });

  // ---- The library -------------------------------------------------------

  server.registerTool(
    "list_assets",
    {
      title: "List assets",
      description:
        "Media known to SEED: clips, frames, generated results. Filter by kind to " +
        "find a plate to work on.",
      inputSchema: {
        kind: z.enum(["image", "video", "audio", "other"]).optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async ({ kind, limit }) => {
      const all = (await call("/v1/assets")) as { assets?: Array<Record<string, unknown>> };
      const assets = (all.assets ?? [])
        .filter((asset) => !kind || asset.kind === kind)
        .slice(0, limit)
        .map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          filename: asset.filename,
          width: asset.width,
          height: asset.height,
          durationSeconds: asset.durationSeconds,
          createdAt: asset.createdAt,
        }));
      return text({ count: assets.length, assets });
    },
  );

  server.registerTool(
    "asset_path",
    {
      title: "Asset path on disk",
      description:
        "The absolute path of an asset's file, so it can be read, inspected with " +
        "ffmpeg, or opened as an image.",
      inputSchema: { assetId: z.string().min(1) },
    },
    async ({ assetId }) => text(await call(`/v1/assets/${encodeURIComponent(assetId)}/path`)),
  );

  server.registerTool(
    "asset_lineage",
    {
      title: "Asset lineage",
      description:
        "Where an asset came from and what came from it — the recipe, the parents " +
        "and the descendants.",
      inputSchema: { assetId: z.string().min(1) },
    },
    async ({ assetId }) => text(await call(`/v1/assets/${encodeURIComponent(assetId)}/lineage`)),
  );

  // ---- Making pictures ---------------------------------------------------

  server.registerTool(
    "transform_presets",
    {
      title: "Season and weather presets",
      description:
        "The starting text for a transformation — winter, summer, night, rain and " +
        "the rest. Editable: what you send is what is rendered.",
      inputSchema: {},
    },
    async () => text(await call("/v1/transform/presets")),
  );

  server.registerTool(
    "transform_keyframe",
    {
      title: "Transform one frame",
      description:
        "Pull one frame out of a clip and apply a change to it with the image " +
        "model — a season, an hour, weather. Seconds, and nearly free. Always do " +
        "this and check it before transforming a whole clip: a still that has " +
        "already drifted will pull the animation with it.",
      inputSchema: {
        sourceAssetId: z.string().min(1).describe("the clip to take the frame from"),
        change: z.string().min(1).describe("what changes — describe what it does to this place"),
        atSeconds: z.number().min(0).default(0).describe("where in the clip; land inside one shot"),
        depth: z
          .number()
          .min(0)
          .max(100)
          .default(50)
          .describe("0 surfaces only, 50 seasonal, 100 also wardrobe and air"),
        note: z.string().max(600).optional().describe("what the plate is — background, not an instruction"),
      },
    },
    async (args) => text(await call("/v1/transform/keyframe", { method: "POST", body: args })),
  );

  server.registerTool(
    "transform_clip",
    {
      title: "Transform a clip",
      description:
        "Re-render a whole clip with one named change, holding the camera, the " +
        "geometry, the people and the cut. Pass the key frame from " +
        "transform_keyframe so the look holds across the shot.",
      inputSchema: {
        sourceAssetId: z.string().min(1),
        change: z.string().min(1),
        depth: z.number().min(0).max(100).default(50),
        keyframeAssetId: z.string().optional(),
        note: z.string().max(600).optional(),
        providerId: z.string().optional(),
      },
    },
    async (args) => text(await call("/v1/transform", { method: "POST", body: args })),
  );

  server.registerTool(
    "check_against_plate",
    {
      title: "Measure drift from the plate",
      description:
        "How far the picture MOVED, in plate pixels, with the worst region named. " +
        "Not a similarity score: a correct season change is supposed to look " +
        "unlike its plate, so this measures displacement instead. Use it to " +
        "decide whether a key frame is usable before paying for video.",
      inputSchema: {
        plateAssetId: z.string().min(1).describe("the frame that was handed to the model"),
        resultAssetId: z.string().min(1).describe("what came back — an image, or a clip to sample"),
        atSeconds: z.number().min(0).optional().describe("where to sample, when the result is a clip"),
      },
    },
    async (args) => text(await call("/v1/transform/agreement", { method: "POST", body: args })),
  );

  server.registerTool(
    "restore_clip",
    {
      title: "Restore a clip",
      description:
        "Archive footage re-rendered at the quality it should have had, with " +
        "nothing invented. Use restore_keyframe first for the same reason as a " +
        "transformation.",
      inputSchema: {
        sourceAssetId: z.string().min(1),
        look: z.string().min(1),
        freedom: z.number().min(0).max(100).default(50),
        keyframeAssetId: z.string().optional(),
        note: z.string().max(600).optional(),
        providerId: z.string().optional(),
      },
    },
    async (args) => text(await call("/v1/restore", { method: "POST", body: args })),
  );

  server.registerTool(
    "restore_keyframe",
    {
      title: "Render one frame properly",
      description:
        "One frame of a clip, re-rendered at full quality by the image model. " +
        "This is where detail comes from — a video model cannot resolve more " +
        "than its source already did.",
      inputSchema: {
        sourceAssetId: z.string().min(1),
        look: z.string().min(1),
        atSeconds: z.number().min(0).default(0),
        note: z.string().max(600).optional(),
      },
    },
    async (args) => text(await call("/v1/restore/keyframe", { method: "POST", body: args })),
  );

  // ---- Animating one piece of artwork -----------------------------------

  server.registerTool(
    "animate",
    {
      title: "Animate a still as a cel element",
      description:
        "Turn one piece of flat artwork into a looping clip that can be keyed and " +
        "comped back into the plate it came from. Give it the artwork's own " +
        "description and a beat sheet; the camera note, the backdrop hold and the " +
        "stability constraints are added for you from what has measurably worked " +
        "on this project. Returns the job to poll, and what the render will cost " +
        "in provider tokens. Pass a frame captured WITH its backdrop already " +
        "behind it — this writes the prompt, it does not isolate the subject.",
      inputSchema: {
        sourceAssetId: z
          .string()
          .min(1)
          .describe("the still to animate, normally a capture of the element on its backdrop"),
        describe: z
          .string()
          .min(1)
          .max(1200)
          .describe(
            "what the artwork IS — style, line weight, colours, props. Holds the " +
              "design; does not describe the motion",
          ),
        beats: z
          .array(
            z.object({
              from: z.number().min(0),
              to: z.number().min(0),
              action: z.string().min(1).max(600),
            }),
          )
          .min(1)
          .max(8)
          .describe("what happens, in timed beats covering the whole duration"),
        durationSeconds: z.number().min(4).max(30).default(10),
        size: z.enum(["480p", "720p", "1080p", "4K"]).default("1080p"),
        aspectRatio: z
          .string()
          .default("adaptive")
          .describe("match the ELEMENT's shape, not the comp's — a forced aspect is what failed before"),
        backdrop: z.enum(["green", "white", "none"]).default("green"),
        loop: z
          .boolean()
          .default(true)
          .describe("same still in both frame slots, so the shot ends where it began"),
        providerId: z
          .enum(["seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini", "seedance-2-5"])
          .default("seedance-2-0")
          .describe("2-0 is the only one that reaches 4K; fast and mini stop at 720p"),
        project: z.string().optional().describe("the host project, so the result files with it"),
        seed: z.number().int().optional(),
      },
    },
    async (args) => {
      const prompt = animatePrompt({
        describe: args.describe,
        beats: args.beats,
        loop: args.loop,
        backdrop: args.backdrop,
      });

      const started = await call("/v1/generations", {
        method: "POST",
        body: {
          providerId: args.providerId,
          operation: "video.generate",
          prompt,
          size: args.size,
          durationSeconds: args.durationSeconds,
          aspectRatio: args.aspectRatio,
          inputAssetIds: [args.sourceAssetId],
          // `loop` puts the one still in both frame slots. `first` anchors the
          // opening and lets the end go where it will.
          inputRoles: [args.loop ? "loop" : "first"],
          ...(args.project ? { project: args.project } : {}),
          ...(args.seed === undefined ? {} : { seed: args.seed }),
        },
      });

      return text({
        ...(started as Record<string, unknown>),
        prompt,
        estimatedTokens: estimateTokens(args.size, args.durationSeconds),
        note:
          "Renders take minutes — poll `job`. Token estimate is measured on this " +
          "account at ~1017 pixels per token; the rate per token is a console setting.",
      });
    },
  );

  server.registerTool(
    "plan_animation",
    {
      title: "Size and cost before spending",
      description:
        "Which resolution tier to generate at for an element of a given on-screen " +
        "size, and what each option would cost in tokens. Generating above the " +
        "size a clip is scaled down to is fine — this project runs 2–4x " +
        "oversampled and it is clean. Generating below it cannot be recovered.",
      inputSchema: {
        screenWidth: z.number().positive().describe("the element's width in comp pixels"),
        screenHeight: z.number().positive(),
        durationSeconds: z.number().min(4).max(30).default(10),
      },
    },
    async ({ screenWidth, screenHeight, durationSeconds }) => {
      const recommended = tierFor(screenWidth, screenHeight);
      const options = ["720p", "1080p", "4K"].map((size) => ({
        size,
        tokens: estimateTokens(size, durationSeconds),
        withVideoReference: estimateTokens(size, durationSeconds, { hasVideoReference: true }),
      }));
      return text({
        element: { screenWidth, screenHeight, aspect: Math.round((screenWidth / screenHeight) * 1000) / 1000 },
        recommended,
        options,
        typicalWallClock: { "720p": "~2.5 min", "1080p": "~4 min", "4K": "~6.5 min" },
        note: "Aspect should follow the element, not the comp it lands in.",
      });
    },
  );

  // ---- Watching work finish ---------------------------------------------

  server.registerTool(
    "job",
    {
      title: "Job status",
      description:
        "Where a render has got to. Renders take minutes — poll this rather than " +
        "assuming a started job has finished.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) => text(await call(`/v1/jobs/${encodeURIComponent(jobId)}`)),
  );

  server.registerTool(
    "providers",
    {
      title: "Available models",
      description: "Which models are configured and what each can take and return.",
      inputSchema: {},
    },
    async () => text(await call("/v1/providers")),
  );

  // ---- After Effects itself ---------------------------------------------

  server.registerTool(
    "ae_status",
    {
      title: "Is After Effects reachable",
      description:
        "Whether a SEED panel is listening and will run work. Driving the host " +
        "needs the panel open AND the artist to have switched the agent on in it. " +
        "Check this before any ae_* call so a refusal can be explained rather " +
        "than retried.",
      inputSchema: {},
    },
    async () => text(await call("/v1/host")),
  );

  server.registerTool(
    "ae_run",
    {
      title: "Run one operation in After Effects",
      description:
        "Drive the open project through the panel. NAMED OPERATIONS ONLY — this " +
        "is not an ExtendScript endpoint and will refuse anything outside the " +
        "allowlist. Reads: ping, getContext, rangeInfo, listRegions, " +
        "selectedMedia, compTree (what a comp is built from, with each part's " +
        "source pixels per screen pixel), projectComps (every comp, top-level " +
        "ones marked), layerBounds (where a layer sits, in comp pixels). " +
        "Writes (these change the artist's project): captureFrame, createRegion, " +
        "regionFromLayer (a region framed on one layer), captureRegion, " +
        "insertRegion, precompose (group layers into a comp of their own), " +
        "setLayerSolo, setRegionAspect, setRegionContain, setProjectDepth, " +
        "setActiveComp (AIM FIRST — everything else works on the active comp), " +
        "addSolid, applyEffects, setLayerEnabled, insertIntoComp, repeatToFill, " +
        "replaceFootage, saveVersion. Call ae_status first to see the current list.",
      inputSchema: {
        name: z.string().min(1).describe("the operation, from the allowlist"),
        args: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ name, args }) =>
      text(await call("/v1/host/run", { method: "POST", body: { name, args } })),
  );

  return server;
}

/** Entry point for `seed-mcp`, speaking stdio to whatever launched it. */
export async function runStdioServer(options: McpOptions): Promise<void> {
  const server = createSeedMcpServer(options);
  await server.connect(new StdioServerTransport());
}
