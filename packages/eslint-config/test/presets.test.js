import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { base, moneyPaths, server } from "../src/index.js";

// A package root that does not exist on disk: ESLint matches globs against the
// path given, so the presets can be checked without fixture files.
const root = path.resolve(import.meta.dirname, "virtual-package");

/**
 * The `ygo/` rule ids reported for `code` linted as if it lived at `file`.
 *
 * @param {import("eslint").Linter.Config[]} config
 * @param {string} file path relative to the package root
 * @param {string} code
 */
async function ygoRulesAt(config, file, code) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: config,
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(root, file),
  });
  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((ruleId) => ruleId?.startsWith("ygo/"));
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
