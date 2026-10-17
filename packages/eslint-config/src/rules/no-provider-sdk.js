/**
 * Bans the AWS SDK outside the server's adapters (ADR-0008).
 *
 * The SDK may only be imported behind the FileStorage and Mailer seams in
 * apps/server/src/adapters/, so a change of provider stays inside one
 * directory. The `server` preset switches this rule off for that directory
 * alone. Type-only imports are banned too: an AWS type in a domain signature
 * leaks the provider just as surely as a call does.
 */

import { importSourceListeners } from "./import-sources.js";

/** @param {unknown} source */
function isProviderSdk(source) {
  return (
    typeof source === "string" &&
    (source === "aws-sdk" ||
      source.startsWith("aws-sdk/") ||
      source.startsWith("@aws-sdk/"))
  );
}

/** @type {import("eslint").Rule.RuleModule} */
export const noProviderSdk = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the AWS SDK outside apps/server/src/adapters/ (ADR-0008)",
    },
    schema: [],
    messages: {
      providerSdk:
        "'{{source}}' may only be imported in apps/server/src/adapters/, behind the FileStorage or Mailer interface (ADR-0008).",
    },
  },

  create(context) {
    return importSourceListeners((node, source) => {
      if (isProviderSdk(source)) {
        context.report({
          node,
          messageId: "providerSdk",
          data: { source: String(source) },
        });
      }
    });
  },
};
