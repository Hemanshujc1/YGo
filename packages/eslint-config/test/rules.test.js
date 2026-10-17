import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import { noNumericCoercion } from "../src/rules/no-numeric-coercion.js";
import { noProviderSdk } from "../src/rules/no-provider-sdk.js";
import { noZod } from "../src/rules/no-zod.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

const coercion = (/** @type {string} */ what) => ({
  messageId: "coercion",
  data: { what },
});

ruleTester.run("no-numeric-coercion", noNumericCoercion, {
  valid: [
    "const paise = BigInt(row.amount_paise);",
    "const total = lineTotals.reduce((sum, line) => sum + line, 0n);",
    "if (Number.isInteger(quantity)) count();",
    "const limit = Number.MAX_SAFE_INTEGER;",
    "const offset = +1;",
    "const negated = -paise;",
    // A local binding named like a built-in is not the built-in.
    "function f(Number) { return Number(value); }",
    "const Math = { round: (x) => x }; Math.round(value);",
  ],
  invalid: [
    { code: "Number(row.total);", errors: [coercion("Number()")] },
    { code: "new Number(row.total);", errors: [coercion("Number()")] },
    { code: "parseFloat(price);", errors: [coercion("parseFloat()")] },
    { code: "parseInt(price, 10);", errors: [coercion("parseInt()")] },
    {
      code: "Number.parseFloat(price);",
      errors: [coercion("Number.parseFloat()")],
    },
    { code: "Math.round(price * 100);", errors: [coercion("Math.round()")] },
    { code: "Math.floor(price);", errors: [coercion("Math.floor()")] },
    { code: "total.toFixed(2);", errors: [coercion(".toFixed()")] },
    { code: "total.toPrecision(4);", errors: [coercion(".toPrecision()")] },
    { code: "const t = +row.total;", errors: [coercion("Unary +")] },
    {
      code: "amounts.map(Number);",
      errors: [coercion("Passing Number")],
    },
  ],
});

const providerSdk = (/** @type {string} */ source) => ({
  messageId: "providerSdk",
  data: { source },
});

ruleTester.run("no-provider-sdk", noProviderSdk, {
  valid: [
    'import { z } from "zod";',
    'import { FileStorage } from "../adapters/file-storage";',
    'const pg = await import("pg");',
    // Not the AWS SDK, just similarly named.
    'import x from "@aws-sdk-like/thing";',
  ],
  invalid: [
    {
      code: 'import { S3Client } from "@aws-sdk/client-s3";',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: 'import type { S3Client } from "@aws-sdk/client-s3";',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: 'export { SESv2Client } from "@aws-sdk/client-sesv2";',
      errors: [providerSdk("@aws-sdk/client-sesv2")],
    },
    {
      code: 'export * from "@aws-sdk/client-s3";',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: 'const s3 = await import("@aws-sdk/client-s3");',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: "const s3 = await import(`@aws-sdk/client-s3`);",
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: 'const AWS = require("aws-sdk");',
      errors: [providerSdk("aws-sdk")],
    },
    {
      code: 'import S3 = require("@aws-sdk/client-s3");',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
    {
      code: 'let client: import("@aws-sdk/client-s3").S3Client;',
      errors: [providerSdk("@aws-sdk/client-s3")],
    },
  ],
});

const zod = (/** @type {string} */ source) => ({ messageId: "zod", data: { source } });

ruleTester.run("no-zod", noZod, {
  valid: [
    'import { Phone, invalidFields } from "@ygo/contracts";',
    // Not zod, just similarly named.
    'import x from "zod-like";',
  ],
  invalid: [
    { code: 'import { z } from "zod";', errors: [zod("zod")] },
    { code: 'import type { ZodType } from "zod";', errors: [zod("zod")] },
    { code: 'import { z } from "zod/mini";', errors: [zod("zod/mini")] },
    { code: 'export { z } from "zod";', errors: [zod("zod")] },
    { code: 'const { z } = await import("zod");', errors: [zod("zod")] },
    { code: 'const { z } = require("zod");', errors: [zod("zod")] },
    { code: 'let s: import("zod").ZodType;', errors: [zod("zod")] },
  ],
});
