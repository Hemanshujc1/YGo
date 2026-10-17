/**
 * Bans the AWS SDK outside the server's adapters (ADR-0008).
 *
 * The SDK may only be imported behind the FileStorage and Mailer seams in
 * apps/server/src/adapters/, so a change of provider stays inside one
 * directory. The `server` preset switches this rule off for that directory
 * alone. Type-only imports are banned too: an AWS type in a domain signature
 * leaks the provider just as surely as a call does.
 */

/** @param {unknown} source */
function isProviderSdk(source) {
  return (
    typeof source === "string" &&
    (source === "aws-sdk" ||
      source.startsWith("aws-sdk/") ||
      source.startsWith("@aws-sdk/"))
  );
}

/**
 * The string a module specifier node names, when it is written literally.
 *
 * @param {any} node
 * @returns {unknown}
 */
function specifierOf(node) {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked;
  }
  return undefined;
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
    /**
     * @param {import("estree").Node} node
     * @param {any} specifierNode
     */
    function check(node, specifierNode) {
      const source = specifierOf(specifierNode);
      if (isProviderSdk(source)) {
        context.report({
          node,
          messageId: "providerSdk",
          data: { source: String(source) },
        });
      }
    }

    // Keys outside ESTree (the TS* nodes) are typed loosely by ESLint, so the
    // handlers take `any` and read only fields typescript-eslint guarantees.
    return /** @type {import("eslint").Rule.RuleListener} */ ({
      ImportDeclaration: (/** @type {any} */ node) => check(node, node.source),
      ExportAllDeclaration: (/** @type {any} */ node) =>
        check(node, node.source),
      ExportNamedDeclaration: (/** @type {any} */ node) =>
        check(node, node.source),
      ImportExpression: (/** @type {any} */ node) => check(node, node.source),

      CallExpression(/** @type {any} */ node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node, node.arguments[0]);
        }
      },

      // import S3 = require("@aws-sdk/client-s3")
      TSExternalModuleReference: (/** @type {any} */ node) =>
        check(node, node.expression),

      // let client: import("@aws-sdk/client-s3").S3Client
      TSImportType: (/** @type {any} */ node) =>
        check(node, node.source),
    });
  },
};
