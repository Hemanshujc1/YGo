# ADR-0007: Monorepo and shared packages

- **Status**: Accepted; "no shared UI package" narrowed to "no UI shared between mobile and web" by [ADR-0009](0009-shared-mobile-package.md)
- **Date**: 2026-10-13
- **Ticket**: [#24 Monorepo and shared packages: Turborepo evaluation](https://github.com/Hemanshujc1/YGo/issues/24)

## Context

Five deployables share one API contract, and several coding agents will work on them in parallel on separate branches.

Constraints fixed before this decision:

- **Two Expo listings from one codebase**, SDK 57 pinned, TypeScript strict, with shared packages carrying types, the API client, the pricing calculators and the format and token sources, and **no UI shared with the web** ([ADR-0001](0001-mobile-app-framework.md)).
- **One Fastify service on Node 26 LTS**, ESM, with `@ygo/contracts` as the single definition of the `/v1` contract, and **money arithmetic in SQL, never in JavaScript** ([ADR-0004](0004-backend-shape-and-api-contract.md)).
- **Two Vite web bundles** ([ADR-0006](0006-web-apps.md)).
- **Deploys are GitHub Actions assuming an OIDC role**, with no long-lived AWS keys; Android builds are local and iOS uses EAS Build ([ADR-0005](0005-hosting-and-operations.md), ADR-0001).
- **A mobile installed base cannot be force-updated**, so a contract change must break at build time or it breaks in a shop.

## Decision

**One repository, pnpm workspaces, Turborepo for task running, and shared packages shipped as TypeScript source with no build step.**

| Concern | Decision |
| --- | --- |
| Repository | **One**, holding both mobile apps, both web apps, the server and the packages |
| Package manager | **pnpm 12**, pinned in `packageManager`, enabled by Corepack (no longer bundled from Node 25: install it with `npm i -g corepack`, then `corepack enable pnpm`) |
| Node | **26 LTS**, pinned in `.nvmrc` and `engines` |
| Task runner | **Turborepo 2.11** |
| Remote cache | **Off.** Local cache only |
| Layout | `apps/` for the five deployables, `packages/` for shared code |
| Internal packages | **TypeScript source, no build output**; `exports` points at `src/index.ts` |
| Expo install strategy | **pnpm's default isolated install** — supported from SDK 54, and the repo is on 57 |
| Metro config | **Not hand-configured.** Expo configures Metro for monorepos itself from SDK 52 |
| Server build | esbuild bundle at deploy; `tsx` in development |
| CI gate | One `turbo run lint typecheck test build` on every branch |

**The five apps.** `apps/customer`, `apps/shopkeeper` (Expo); `apps/admin`, `apps/web` (Vite); `apps/server` (Fastify).

**The seven packages.** `@ygo/contracts` (Zod schemas and error codes for every `/v1` message, types derived); `@ygo/api-client` (typed fetch, retry, token refresh); `@ygo/pricing` (the [#15](https://github.com/Hemanshujc1/YGo/issues/15) pricing, fee and coupon calculators); `@ygo/format` (Indian digit grouping, two-decimal money, `dd/mm/yyyy`, 12-hour time, Asia/Kolkata display over UTC storage); `@ygo/tokens` (semantic colour, spacing and type tokens, consumed by NativeWind on mobile and Tailwind on web); `@ygo/tsconfig`; `@ygo/eslint-config` (including the ban on numeric coercion in money paths).

**No shared UI package**, per ADR-0001. A package attempting to span React Native and the web becomes two implementations behind one import, which is worse than two implementations behind two imports.

**Why one repository.** Renaming a field in `@ygo/contracts` must break the type check in every consumer, in the same commit, before anything deploys. Across separate repositories that break instead arrives as a production runtime error after a forgotten version bump. With several agents on separate branches and an installed base that cannot be force-updated, this is the most valuable guarantee in the toolchain.

**Why pnpm.** It fails on undeclared dependencies rather than silently resolving them from a sibling's hoisted tree, which is the failure mode that makes monorepos rot. It is faster and smaller on disk across five apps sharing most of a dependency tree. And Expo's own documentation lists it as supported, with isolated installs supported from SDK 54.

**Why Turborepo.** With source-only packages the graph is nearly flat, so this is not bought for orchestration. It is bought for one command that runs lint, typecheck, test and build across five apps in parallel, and a content-hash cache so re-running the gate after touching one app does not re-check the other four. Configuration is a single `turbo.json`.

**Why source-only packages.** Internal packages publish nothing, so they have no reason to compile. Vite and Metro consume TypeScript directly, and esbuild pulls the sources into the server bundle at deploy. The result: no build step in `packages/`, no stale `dist/`, no build ordering in the task graph, and the elimination of the commonest solo-developer waste — editing a package, forgetting to rebuild, and debugging the old behaviour.

## Consequences

**What this forbids.** No second repository, and no repository split for the mobile apps. No npm or Yarn lockfile. No build step or published artifact for an internal package. No `watchFolders`, `resolver.nodeModulesPath`, `resolver.extraNodeModules` or `resolver.disableHierarchicalLookup` in `metro.config.js` — Expo's documentation says that if those keys are present they should be **removed**, followed by one `expo start --clear`. Multiple current monorepo guides instruct the opposite; on SDK 57 that advice fights the built-in configuration and produces the very resolution errors it claims to prevent. No shared UI package. No remote cache, and therefore no build artifact leaving the machine. No UI dependency in `@ygo/contracts`, `@ygo/format` or `@ygo/pricing`, which must stay runtime-agnostic because the server imports them.

**What it requires that is easy to miss.** `@ygo/pricing` needs its own README stating that ADR-0004 puts money arithmetic in SQL on the server, so these calculators exist to *show* a customer or shopkeeper what a total will be while the server's number is what is charged. They must agree; sharing the package makes agreement likely and shared test fixtures are the only thing that makes it checkable. Separately, the recorded escape hatch for pnpm: Expo notes that isolated installs can cause native build or resolution errors with some React Native libraries, and the documented remedy is `nodeLinker: hoisted` in `pnpm-workspace.yaml` — one line to try first, not a migration to npm.

**What it costs.** One repository is one blast radius: a bad change to `@ygo/contracts` or `@ygo/format` fails every app at once. That is desirable at type-check time and a liability at runtime, so the shared packages are the parts that most need tests — above all `@ygo/pricing`, where a wrong number is money. Source-only packages push all compilation into consumers, so a TypeScript feature Metro's transform rejects would break only the mobile apps and point at the package rather than the consumer. And Turborepo's cache can be wrong when a task's inputs are declared incompletely, the symptom being a green check on a change that was never checked; a cache hit on a surprising change deserves suspicion, and `--force` exists.

**What it buys.** A contract that cannot drift between four clients and a server. One gate command an agent can run before opening a branch, and the same one in CI. One place to change the money format or a colour token.

## Alternatives considered

**npm workspaces.** The safest choice against React Native tooling surprises, since hoisting is the behaviour every library has been tested against. Rejected because the same hoisting hides undeclared dependencies, which is the defect that makes a five-app workspace unmaintainable — and Expo now documents pnpm support with isolated installs from SDK 54.

**Yarn Berry with Plug'n'Play.** Strictest of all about dependencies, and the least compatible with React Native's native tooling. Rejected on toolchain risk during a one-month pilot.

**Nx.** Generators, an executor model and a plugin per framework — real machinery repaid by large teams coordinating many libraries. With one developer it is structure bought well ahead of the problem.

**Plain pnpm scripts, no task runner.** Honestly attractive given the flat graph. Rejected because repeated full-repo checks get slow enough to be skipped, and a gate that gets skipped is not a gate.

**Separate repositories per app.** Independent release cadences, which is the usual argument. Rejected outright: it converts contract drift from a compile error into a production incident on phones that cannot be force-updated.

**Pre-built internal packages.** The conventional shape, and necessary if anything were ever published. Rejected as adding a build graph and a class of stale-output bug to solve a problem this repository does not have.

**Turborepo remote caching.** Rejected for Phase 1: it means an account with a third party and artifacts leaving the machine, for a shared-cache benefit that is meaningless with one developer.

## Amendment, 13 Oct 2026: what `@ygo/pricing` holds

The PRD consistency review found this record and ADR-0004 pulling in opposite directions. ADR-0004 puts money arithmetic in SQL and forbids it in JavaScript on the server; this record gave `@ygo/pricing` "the pricing, fee and coupon calculators" and had the server import them. Two implementations of the pricing engine, one in SQL and one in TypeScript, are two chances for a customer's cart to disagree with their order, and agreement between them was only ever as good as the fixtures.

**The engine exists once, in SQL, on the server.** The cart quote, order placement, the recomputation after a partial acceptance, the admin simulator and the weekly statement all call it. Choosing which rule applies may be written in TypeScript; every operation that produces or combines a money amount runs in PostgreSQL on `NUMERIC`. The customer app shows the last quote the server returned and never computes one, which costs nothing because that app needs a connection to order anyway.

**`@ygo/pricing` is narrowed to three things:**

- **Counter-bill arithmetic**, the one money calculation that must work offline: line totals rounded once per line half-up, the bill-level discount and the bill total, done in **integer paise and integer thousandths of a unit, never floating point**.
- **The worked examples as data**: every scenario in `docs/product/revenue-system-spec.md` expressed as inputs and expected amounts. The server's tests run them through the SQL engine. They are the acceptance test for the pricing engine.
- **Counter-bill fixtures**, run against both the phone's arithmetic and the server's check of it.

The server imports the fixtures in its tests and executes none of the package's arithmetic. On sync it recomputes each counter bill in SQL; a disagreement flags the bill for Admin and changes nothing, because the customer has already paid the amount the phone showed.

Everything else in this record stands, including the lint ban on numeric coercion in money paths, which now also covers the paise arithmetic in this package.
