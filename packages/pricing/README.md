# @ygo/pricing

Holds the delivered-route worked examples (`src/worked-examples.ts`, #357) and the counter-bill total with its examples (`src/counter-bill.ts`, #51).

## What this package is not

**The pricing engine exists once, in SQL, on the server** ([ADR-0004](../../docs/adr/0004-backend-shape-and-api-contract.md), and the 13 Oct 2026 amendment to [ADR-0007](../../docs/adr/0007-monorepo-and-shared-packages.md)). The cart quote, order placement, the recomputation after a partial acceptance, the admin simulator and the weekly statement all call it, and every operation that produces or combines a money amount runs in PostgreSQL on `NUMERIC`. The customer app shows the last quote the server returned and never computes one.

## What it holds

The amendment narrows it to three things:

- **Counter-bill arithmetic**, the one money calculation that must work offline: line totals rounded once per line half-up, the bill-level discount and the bill total, in **integer paise and integer thousandths of a unit, never floating point**.
- **The worked examples as data**: every scenario in `docs/product/revenue-system-spec.md` as inputs and expected amounts. The server's tests run them through the SQL engine; they are the acceptance test for the pricing engine.
- **Counter-bill fixtures**, run against both the phone's arithmetic and the server's check of it.

The server imports the fixtures in its tests and executes none of this package's arithmetic. On sync it recomputes each counter bill in SQL; a disagreement flags the bill for Admin and changes nothing, because the customer has already paid the amount the phone showed.

## Rules

- The whole of `src/` is a money path: `ygo/no-numeric-coercion` applies to every file (see `@ygo/eslint-config`).
- The server imports this package, so it stays runtime-agnostic: no UI or React dependency.
