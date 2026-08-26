import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockImageProvider, ProviderRegistry } from "@seed-ae/providers";
import { createApp, type AppDeps } from "../src/app.js";
import { bootstrap } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";

/**
 * Test-only JSON reader. Responses are asserted against the shared schemas
 * where shape matters; this keeps the ad-hoc assertions readable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(response: Response): Promise<any> {
  return response.json();
}

export interface TestService {
  baseUrl: string;
  token: string;
  deps: AppDeps;
  /** Authenticated fetch against the service. */
  call(pathname: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Small declared sizes keep test renders fast while still exercising the
 * capability check that rejects undeclared sizes.
 */
export function testRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(
    new MockImageProvider({
      latencyMs: 0,
      sizes: ["64x64", "320x180", "1024x1024"],
    }),
  );
}

export async function startTestService(
  options: {
    registry?: ProviderRegistry;
    /**
     * Let bootstrap build the registry from config instead of injecting one.
     * Only the settings tests want this: `reloadProviders` is deliberately
     * absent when a registry is handed in, so a save cannot replace a set of
     * providers a test chose on purpose.
     */
    ownRegistry?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<TestService> {
  // Temp root with a space, mirroring a real "Client Work" project folder.
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "seed ae svc "));
  const config = loadConfig({
    SEED_AE_WORKSPACE: workspaceRoot,
    SEED_AE_SESSION_TOKEN: "test-token-abc",
    SEED_AE_POLL_INTERVAL_MS: "0",
    SEED_AE_MOCK_LATENCY_MS: "0",
    ...options.env,
  } as NodeJS.ProcessEnv);

  const injected = options.ownRegistry
    ? undefined
    : (options.registry ?? testRegistry());
  const deps = await bootstrap({
    config,
    logger: silentLogger,
    ...(injected ? { registry: injected } : {}),
  });
  const { server, deps: appDeps } = createApp(deps);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    token: config.sessionToken,
    deps: appDeps,
    call: (pathname, init = {}) =>
      fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.sessionToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      }),
    close: async () => {
      appDeps.generation.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      appDeps.db.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
