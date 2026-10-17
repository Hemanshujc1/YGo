# @ygo/eslint-config

Shared ESLint flat config for every app and package. Written in JavaScript rather than TypeScript because ESLint loads it directly under Node; it is type-checked through JSDoc.

## Presets

| Export | Use in | Adds |
| --- | --- | --- |
| `base` | client apps and shared packages | `@eslint/js` recommended, `typescript-eslint` strict, both `ygo/` rules |
| `server` | `apps/server` | Node globals; the AWS SDK allowed in `src/adapters/**` only |
| `node` | Node tooling packages | Node globals |
| `moneyPaths(globs)` | a package that is money throughout | the numeric-coercion ban on more files |

```js
// apps/server/eslint.config.js
import { server } from "@ygo/eslint-config";
export default server;
```

## The two rules

**`ygo/no-provider-sdk`** ([ADR-0008](../../docs/adr/0008-provider-portability-boundary.md)). Bans `@aws-sdk/*` and `aws-sdk` everywhere except `apps/server/src/adapters/`, in every import form: static, type-only, re-export, dynamic `import()`, `require`, and `import("…")` types.

**`ygo/no-numeric-coercion`** ([ADR-0004](../../docs/adr/0004-backend-shape-and-api-contract.md), [ADR-0007](../../docs/adr/0007-monorepo-and-shared-packages.md)). In money paths, bans `Number()`, `parseFloat`, `parseInt`, unary `+`, `.toFixed()`, `.toPrecision()` and `Math.round/floor/ceil/trunc`. BigInt is allowed: it is how integer paise are held.

**What counts as a money path.** Any file under a `money/` directory, or named `*.money.ts`, in any package. `@ygo/pricing` covers its whole source with `moneyPaths(["src/**"])`. Put new money code in one of those places, or the rule cannot see it.

The rule catches the common ways a value becomes a float, not every one (`price * 1` gets through). Review still matters; the rule makes the easy mistakes impossible.

## Extending a preset

Add config objects after the preset; don't redefine its rules. Setting `ygo/no-provider-sdk` or `ygo/no-numeric-coercion` to `off` anywhere other than the server's adapters needs an ADR amendment.
