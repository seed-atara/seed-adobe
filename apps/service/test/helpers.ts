import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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

export async function startTestService(): Promise<TestService> {
  // Temp root with a space, mirroring a real "Client Work" project folder.
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "seed ae svc "));
  const config = loadConfig({
    SEED_AE_WORKSPACE: workspaceRoot,
    SEED_AE_SESSION_TOKEN: "test-token-abc",
  } as NodeJS.ProcessEnv);

  const deps = await bootstrap({ config, logger: silentLogger });
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      appDeps.db.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
