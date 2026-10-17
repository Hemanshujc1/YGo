// One self-contained file for deploy (ADR-0005, ADR-0007): workspace packages
// and npm dependencies are bundled, so the instance needs only Node and dist/.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  // pg loads its optional native driver only when asked; it is never installed.
  external: ["pg-native"],
  // Some bundled dependencies are CommonJS and call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
