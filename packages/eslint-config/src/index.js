import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import { noMobileImport } from "./rules/no-mobile-import.js";
import { noNumericCoercion } from "./rules/no-numeric-coercion.js";
import { noProviderSdk } from "./rules/no-provider-sdk.js";
import { noZod } from "./rules/no-zod.js";

/** The repository's own rules, registered under the `ygo/` prefix. */
export const plugin = {
  meta: { name: "@ygo/eslint-plugin" },
  rules: {
    "no-mobile-import": noMobileImport,
    "no-numeric-coercion": noNumericCoercion,
    "no-provider-sdk": noProviderSdk,
    "no-zod": noZod,
  },
};

/**
 * Files that hold money arithmetic by convention, in any package: anything
 * under a `money/` directory, or named `*.money.ts`. A package that is money
 * throughout, such as @ygo/pricing, adds its whole source with `moneyPaths`.
 */
export const MONEY_PATH_GLOBS = [
  "**/money/**/*.{js,mjs,ts,mts,tsx}",
  "**/*.money.{js,mjs,ts,mts,tsx}",
];

/**
 * Applies the numeric-coercion ban to more files.
 *
 * @param {string[]} files globs relative to the package's eslint.config.js
 */
export function moneyPaths(files) {
  return defineConfig({
    name: "ygo/money-paths",
    files,
    plugins: { ygo: plugin },
    rules: { "ygo/no-numeric-coercion": "error" },
  });
}

/** Every package and app starts from this. */
export const base = defineConfig(
  globalIgnores([
    "**/dist/",
    "**/build/",
    "**/coverage/",
    "**/.turbo/",
    "**/.expo/",
  ]),
  {
    name: "ygo/files",
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    name: "ygo/base",
    plugins: { ygo: plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "ygo/no-provider-sdk": "error",
      "ygo/no-zod": "error",
      "ygo/no-mobile-import": "error",
    },
  },
  moneyPaths(MONEY_PATH_GLOBS),
);

/** packages/contracts: the one place zod schemas are written. */
export const contracts = defineConfig(base, {
  name: "ygo/contracts",
  rules: { "ygo/no-zod": "off" },
});

/**
 * apps/server: Node globals, the AWS SDK allowed in src/adapters/ only, and
 * zod in the Fastify glue and the environment check only.
 */
export const server = defineConfig(base, {
  name: "ygo/server",
  languageOptions: { globals: globals.node },
}, {
  name: "ygo/server-adapters",
  files: ["src/adapters/**"],
  rules: { "ygo/no-provider-sdk": "off" },
}, {
  name: "ygo/server-zod",
  files: ["src/zod.ts", "src/config.ts"],
  rules: { "ygo/no-zod": "off" },
});

/**
 * apps/customer, apps/shopkeeper and packages/mobile, the one place
 * @ygo/mobile may be imported (ADR-0009). Babel, Metro and Tailwind load their
 * config files (`babel.config.js` and the like) as CommonJS under Node, so
 * those files get Node globals and `require`. The native projects that
 * `expo prebuild` and `expo run` generate are not linted.
 */
export const expo = defineConfig(base, globalIgnores(["android/", "ios/"]), {
  name: "ygo/expo-mobile",
  rules: { "ygo/no-mobile-import": "off" },
}, {
  name: "ygo/expo-config-files",
  files: ["*.config.js"],
  languageOptions: { sourceType: "commonjs", globals: globals.node },
  rules: { "@typescript-eslint/no-require-imports": "off" },
});

/** Tooling packages that run under Node, such as this one. */
export const node = defineConfig(base, {
  name: "ygo/node",
  languageOptions: { globals: globals.node },
});
