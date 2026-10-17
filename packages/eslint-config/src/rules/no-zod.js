/**
 * Bans zod outside @ygo/contracts (ADR-0004, AGENTS.md).
 *
 * Every schema and field rule is written once in @ygo/contracts and used by
 * the server and every form, so no app keeps its own copy of a rule. The
 * `contracts` preset switches this rule off, and the `server` preset switches
 * it off for its Fastify glue and environment check.
 */

import { importSourceListeners } from "./import-sources.js";

/** @param {unknown} source */
function isZod(source) {
  return typeof source === "string" && (source === "zod" || source.startsWith("zod/"));
}

/** @type {import("eslint").Rule.RuleModule} */
export const noZod = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow zod outside @ygo/contracts (ADR-0004)",
    },
    schema: [],
    messages: {
      zod: "'{{source}}' may only be imported in @ygo/contracts: take the schema or field rule from there, or add it there (AGENTS.md, ADR-0004).",
    },
  },

  create(context) {
    return importSourceListeners((node, source) => {
      if (isZod(source)) {
        context.report({ node, messageId: "zod", data: { source: String(source) } });
      }
    });
  },
};
