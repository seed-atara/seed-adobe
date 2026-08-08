import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // node:sqlite is still flagged experimental; silence the per-process warning.
    env: { NODE_NO_WARNINGS: "1" },
  },
});
