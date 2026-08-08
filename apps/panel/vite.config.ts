import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVICE = process.env.SEED_AE_SERVICE_URL ?? "http://127.0.0.1:47831";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 47830,
    // Proxying keeps dev same-origin. The panel also works cross-origin
    // (the service sends CORS for local origins), which is what a CEP
    // panel loaded from file:// will rely on.
    proxy: {
      "/health": SERVICE,
      "/v1": SERVICE,
    },
  },
  // Relative base so the built panel can be loaded from a file:// CEP host.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
