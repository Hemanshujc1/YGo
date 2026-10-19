/**
 * Bans @ygo/mobile outside the two mobile apps (ADR-0009).
 *
 * It holds React Native code, so the web apps, the server and every other
 * package stay free of it. The `expo` preset, which the Customer and
 * Shopkeeper apps and @ygo/mobile itself use, switches this rule off.
 */

import { importSourceListeners } from "./import-sources.js";

/** @param {unknown} source */
function isMobile(source) {
  return typeof source === "string" && (source === "@ygo/mobile" || source.startsWith("@ygo/mobile/"));
}

/** @type {import("eslint").Rule.RuleModule} */
export const noMobileImport = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow @ygo/mobile outside the mobile apps (ADR-0009)",
    },
    schema: [],
    messages: {
      mobile: "'{{source}}' is for the mobile apps only (ADR-0009).",
    },
  },

  create(context) {
    return importSourceListeners((node, source) => {
      if (isMobile(source)) {
        context.report({ node, messageId: "mobile", data: { source: String(source) } });
      }
    });
  },
};
