import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { base, contracts, expo, moneyPaths, server } from "../src/index.js";

// A package root that does not exist on disk: ESLint matches globs against the
// path given, so the presets can be checked without fixture files.
const root = path.resolve(import.meta.dirname, "virtual-package");

/**
 * The rule ids reported for `code` linted as if it lived at `file`.
 *
 * @param {import("eslint").Linter.Config[]} config
 * @param {string} file path relative to the package root
 * @param {string} code
 */
async function rulesAt(config, file, code) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: config,
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(root, file),
  });
  return (result?.messages ?? []).map((message) => message.ruleId);
}

/**
 * The `ygo/` rule ids among {@link rulesAt}.
 *
 * @param {Parameters<typeof rulesAt>} args
 */
async function ygoRulesAt(...args) {
  return (await rulesAt(...args)).filter((ruleId) => ruleId?.startsWith("ygo/"));
}

const awsImport = 'import { S3Client } from "@aws-sdk/client-s3";\nS3Client;\n';
const coercion = "export const total = Number(row.total);\n";

describe("the AWS SDK ban (ADR-0008)", () => {
  it("applies in every package", async () => {
    expect(await ygoRulesAt(base, "src/index.ts", awsImport)).toEqual([
      "ygo/no-provider-sdk",
    ]);
  });

  it("applies in the server outside src/adapters/", async () => {
    expect(await ygoRulesAt(server, "src/orders/place.ts", awsImport)).toEqual(
      ["ygo/no-provider-sdk"],
    );
  });

  it("is lifted inside the server's src/adapters/", async () => {
    expect(
      await ygoRulesAt(server, "src/adapters/file-storage/s3.ts", awsImport),
    ).toEqual([]);
  });

  it("is not lifted for an adapters/ directory in a client package", async () => {
    expect(await ygoRulesAt(base, "src/adapters/s3.ts", awsImport)).toEqual([
      "ygo/no-provider-sdk",
    ]);
  });
});

describe("the numeric-coercion ban in money paths (ADR-0004, ADR-0007)", () => {
  it("applies under a money/ directory", async () => {
    expect(
      await ygoRulesAt(server, "src/orders/money/totals.ts", coercion),
    ).toEqual(["ygo/no-numeric-coercion"]);
  });

  it("applies to a *.money.ts file", async () => {
    expect(await ygoRulesAt(base, "src/fees.money.ts", coercion)).toEqual([
      "ygo/no-numeric-coercion",
    ]);
  });

  it("does not apply outside money paths", async () => {
    expect(await ygoRulesAt(server, "src/config.ts", coercion)).toEqual([]);
  });

  it("covers a whole package added with moneyPaths()", async () => {
    const pricing = [...base, ...moneyPaths(["src/**"])];
    expect(await ygoRulesAt(pricing, "src/counter-bill.ts", coercion)).toEqual(
      ["ygo/no-numeric-coercion"],
    );
  });
});

describe("zod outside @ygo/contracts (AGENTS.md, ADR-0004)", () => {
  const zodImport = 'import { z } from "zod";\nz;\n';

  it("is banned in apps and packages", async () => {
    expect(await ygoRulesAt(base, "src/sign-up/form.tsx", zodImport)).toEqual([
      "ygo/no-zod",
    ]);
  });

  it("is banned in the server outside its zod glue and config", async () => {
    expect(await ygoRulesAt(server, "src/routes/sign-up.ts", zodImport)).toEqual(
      ["ygo/no-zod"],
    );
  });

  it("is allowed in the server's zod glue and config", async () => {
    expect(await ygoRulesAt(server, "src/zod.ts", zodImport)).toEqual([]);
    expect(await ygoRulesAt(server, "src/config.ts", zodImport)).toEqual([]);
  });

  it("is allowed in @ygo/contracts", async () => {
    expect(await ygoRulesAt(contracts, "src/fields.ts", zodImport)).toEqual([]);
  });
});

describe("the Expo apps' config files", () => {
  const commonJs =
    'const { getDefaultConfig } = require("expo/metro-config");\nmodule.exports = getDefaultConfig(__dirname);\n';

  it("may use require and Node globals", async () => {
    expect(await rulesAt(expo, "metro.config.js", commonJs)).toEqual([]);
  });

  it("skip the generated native projects", async () => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: expo,
    });
    for (const file of ["ios/Pods/x/index.js", "android/app/x.js"]) {
      expect(await eslint.isPathIgnored(path.join(root, file))).toBe(true);
    }
  });

  it("stay CommonJS only at the app root", async () => {
    expect(await rulesAt(expo, "src/app/index.js", commonJs)).toContain(
      "@typescript-eslint/no-require-imports",
    );
  });
});

describe("@ygo/mobile outside the mobile apps (ADR-0009)", () => {
  const mobileImports = [
    'import { Text } from "@ygo/mobile";\nexport { Text };\n',
    'import { Text } from "@ygo/mobile/src/text";\nexport { Text };\n',
  ];

  it("is banned in the web apps, the server and the other packages", async () => {
    for (const code of mobileImports) {
      expect(await rulesAt(base, "src/main.tsx", code)).toEqual(["ygo/no-mobile-import"]);
      expect(await rulesAt(server, "src/app.ts", code)).toEqual(["ygo/no-mobile-import"]);
      expect(await rulesAt(contracts, "src/index.ts", code)).toEqual(["ygo/no-mobile-import"]);
    }
  });

  it("is allowed in the mobile apps and the package itself", async () => {
    for (const code of mobileImports) {
      expect(await rulesAt(expo, "src/app/_layout.tsx", code)).toEqual([]);
    }
  });
});
