/**
 * Listeners that pass every module a file names to `check`, in every import
 * form: static, type-only, re-export, dynamic `import()`, `require`,
 * `import x = require(…)` and `import("…")` types. The import bans share it so
 * they cover the same forms.
 *
 * @param {(node: import("estree").Node, source: unknown) => void} check
 * @returns {import("eslint").Rule.RuleListener}
 */
export function importSourceListeners(check) {
  /** @param {any} node @param {any} specifierNode */
  const visit = (node, specifierNode) => check(node, specifierOf(specifierNode));

  // Keys outside ESTree (the TS* nodes) are typed loosely by ESLint, so the
  // handlers take `any` and read only fields typescript-eslint guarantees.
  return /** @type {import("eslint").Rule.RuleListener} */ ({
    ImportDeclaration: (/** @type {any} */ node) => visit(node, node.source),
    ExportAllDeclaration: (/** @type {any} */ node) => visit(node, node.source),
    ExportNamedDeclaration: (/** @type {any} */ node) => visit(node, node.source),
    ImportExpression: (/** @type {any} */ node) => visit(node, node.source),

    CallExpression(/** @type {any} */ node) {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        visit(node, node.arguments[0]);
      }
    },

    // import S3 = require("@aws-sdk/client-s3")
    TSExternalModuleReference: (/** @type {any} */ node) =>
      visit(node, node.expression),

    // let client: import("@aws-sdk/client-s3").S3Client
    TSImportType: (/** @type {any} */ node) => visit(node, node.source),
  });
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
