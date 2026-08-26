import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { credentialsPath, effectiveEnv, readCredentials } from "./settings.js";

const envFile = loadDotEnv();

const logger = createLogger();
// Panel-set credentials layer over `.env` — see apps/service/src/settings.ts
// for why that direction and not the other.
const stored = readCredentials(credentialsPath());
const config = loadConfig(effectiveEnv(process.env, stored));
const deps = await bootstrap({ config, logger });
const { server } = createApp(deps);

server.listen(config.port, config.host, () => {
  logger.info("service.listening", {
    url: `http://${config.host}:${config.port}`,
    workspace: deps.workspace.root,
    aeHost: deps.aeHost.id,
    envFile: envFile ?? "(none found)",
    // Which keys came from the panel rather than the file, by name. Never the
    // values — this line goes to a log that gets pasted into chat.
    panelSettings: Object.keys(stored).join(", ") || "(none)",
    providers: deps.registry.ids().join(", "),
  });
  if (config.ephemeralToken) {
    // Printed once so a local panel can be pointed at this process. Set
    // SEED_AE_SESSION_TOKEN in .env to keep it stable across restarts.
    process.stdout.write(
      `\nSEED session token (this process only): ${config.sessionToken}\n\n`,
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("service.stopping", { signal });
    deps.generation.dispose();
    server.close(() => {
      deps.db.close();
      process.exit(0);
    });
  });
}
