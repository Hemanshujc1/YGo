/**
 * Bans turning a value into a JavaScript number inside a money path.
 *
 * A JavaScript number is a binary float, so `Number("0.10") * 3` is not 0.30.
 * Money arithmetic happens in SQL on NUMERIC (ADR-0004); the one calculation
 * that must run on the phone uses integer paise held as BigInt (ADR-0007).
 * Each pattern below is a way a money value slips into a float.
 */

const COERCING_FUNCTIONS = new Set(["Number", "parseFloat", "parseInt"]);
const COERCING_STATICS = new Map([
  ["Number", new Set(["parseFloat", "parseInt"])],
  ["Math", new Set(["round", "floor", "ceil", "trunc"])],
]);
const COERCING_METHODS = new Set(["toFixed", "toPrecision"]);

/** @type {import("eslint").Rule.RuleModule} */
export const noNumericCoercion = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow numeric coercion in money paths (ADR-0004, ADR-0007)",
    },
    schema: [],
    messages: {
      coercion:
        "{{what}} turns a money value into a float. Do money arithmetic in SQL (ADR-0004), or in integer paise as BigInt in @ygo/pricing (ADR-0007).",
    },
  },

  create(context) {
    const { sourceCode } = context;

    /**
     * True when `name` at `node` resolves to the built-in, not to a local
     * binding that happens to share its name.
     *
     * @param {import("estree").Node} node
     * @param {string} name
     */
    function isGlobal(node, name) {
      let scope = /** @type {import("eslint").Scope.Scope | null} */ (
        sourceCode.getScope(node)
      );
      while (scope) {
        const variable = scope.set.get(name);
        if (variable) return variable.defs.length === 0;
        scope = scope.upper;
      }
      return true;
    }

    /**
     * @param {import("estree").Node} node
     * @param {string} what
     */
    function report(node, what) {
      context.report({ node, messageId: "coercion", data: { what } });
    }

    /** @param {import("estree").CallExpression | import("estree").NewExpression} node */
    function checkCall(node) {
      const { callee } = node;

      if (
        callee.type === "Identifier" &&
        COERCING_FUNCTIONS.has(callee.name) &&
        isGlobal(callee, callee.name)
      ) {
        report(node, `${callee.name}()`);
      }

      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier"
      ) {
        const method = callee.property.name;
        const { object } = callee;

        if (COERCING_METHODS.has(method)) {
          report(node, `.${method}()`);
        } else if (
          object.type === "Identifier" &&
          COERCING_STATICS.get(object.name)?.has(method) &&
          isGlobal(object, object.name)
        ) {
          report(node, `${object.name}.${method}()`);
        }
      }

      // `values.map(Number)` coerces as surely as `Number(value)`.
      for (const argument of node.arguments) {
        if (
          argument.type === "Identifier" &&
          COERCING_FUNCTIONS.has(argument.name) &&
          isGlobal(argument, argument.name)
        ) {
          report(argument, `Passing ${argument.name}`);
        }
      }
    }

    return {
      CallExpression: checkCall,
      NewExpression: checkCall,

      UnaryExpression(node) {
        if (node.operator !== "+") return;
        // `+1` is a literal written with a sign, not a coercion.
        if (
          node.argument.type === "Literal" &&
          typeof node.argument.value === "number"
        ) {
          return;
        }
        report(node, "Unary +");
      },
    };
  },
};
