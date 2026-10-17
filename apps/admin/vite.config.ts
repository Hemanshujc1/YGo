import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // In development the page and the API share one origin: /v1 goes to the
  // local server (apps/server). See README.md.
  server: {
    proxy: { "/v1": "http://127.0.0.1:3000" },
  },
});
