// Standalone API and migration bundles (ADR-0005, ADR-0007): workspace packages
// and npm dependencies are bundled, so the instance needs only Node and dist/.
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const outdir = process.argv[2] ?? "dist";

await build({
  entryPoints: ["src/main.ts", "src/migrate.ts", "src/job.ts", "src/check-jobs.ts", "src/bootstrap-admin.ts"],
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  // pg loads its optional native driver only when asked; it is never installed.
  external: ["pg-native"],
  // Some bundled dependencies are CommonJS and call require().
  banner: {
    js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);",
  },
  logLevel: "info",
});

// Keep migrations and ESM metadata with the bundle, independent of the checkout.
await mkdir(outdir, { recursive: true });
await cp("migrations", join(outdir, "migrations"), { recursive: true });
await writeFile(join(outdir, "package.json"), JSON.stringify({ type: "module" }));

// Sharp's JavaScript is bundled, but its native binding and libvips are loaded
// at runtime. Ship the installed platform packages with the release (#203).
const require = createRequire(import.meta.url);
const sharpRequire = createRequire(require.resolve("sharp"));
for (const name of Object.keys(sharpRequire("../package.json").optionalDependencies)) {
  let packagePath;
  try {
    packagePath = sharpRequire.resolve(`${name}/package`);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") continue; // Other platforms are not installed.
    throw error;
  }
  await cp(dirname(packagePath), join(outdir, "node_modules", name), { recursive: true, dereference: true });
}
