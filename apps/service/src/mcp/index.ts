import { runStdioServer } from "./server.js";

/**
 * `seed-mcp` — SEED's tools, over stdio, for an agent.
 *
 * Reads the same `.env` the service does, because the alternative is a second
 * place to keep the port and the token in step and nobody keeps two places in
 * step. Nothing here prints the token, including on the failure path: a
 * missing-token message that helpfully showed what it found would put it in
 * the terminal scrollback of whatever launched this.
 */

const port = process.env.SEED_AE_PORT ?? "47831";
const host = process.env.SEED_AE_HOST ?? "127.0.0.1";
const token = process.env.SEED_AE_SESSION_TOKEN ?? "";

if (!token) {
  /*
   * stderr, not stdout. stdout is the MCP transport — a stray line there is a
   * protocol error, and the client's report of it would say nothing about the
   * real problem.
   */
  process.stderr.write(
    "seed-mcp: SEED_AE_SESSION_TOKEN is not set. Run it with the service's .env " +
      "loaded, the same one the panel uses.\n",
  );
  process.exit(1);
}

await runStdioServer({ baseUrl: `http://${host}:${port}`, token });
