/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { setupFiles: ["src/test-setup.ts"], testTimeout: 10_000 },
  // In development the page and the API share one origin: /v1 goes to the
  // local server (apps/server). See README.md.
  server: {
    proxy: {
      "/v1": {
        target: process.env.YGO_ADMIN_DEV_API_TARGET ?? "http://127.0.0.1:3000",
        // With the server down, drop the connection instead of Vite's 500, so
        // the page's fetch fails the way it would against an unreachable API.
        configure: (proxy) => proxy.on("error", (_err, _req, res) => res.destroy()),
      },
    },
  },
});
