import { defineConfig } from "drizzle-kit";

// drizzle-kit writes forward-only SQL migrations here (ADR-0004). Nothing
// applies them on boot; the tests apply them to a fresh database per run.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
