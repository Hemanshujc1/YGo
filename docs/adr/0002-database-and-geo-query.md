# ADR-0002: Database, geo query and money precision

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#19 Database and geo query](https://github.com/Hemanshujc1/YGo/issues/19)

## Context

One relational store has to serve the catalog, orders, money, stock and geography for a one-month pilot of fifty to eighty shops, maintained by a solo developer.

Constraints fixed before this decision:

- **Serviceability is distance from the shop against that shop's own radius** ([#6](https://github.com/Hemanshujc1/YGo/issues/6)), roughly 2-3 km.
- **Money is exact and auditable**: immutable per-order pricing snapshots aggregated into weekly statements ([#14](https://github.com/Hemanshujc1/YGo/issues/14)), per-line commission ([#15](https://github.com/Hemanshujc1/YGo/issues/15)), bill numbers sequential per shop and never reused or skipped ([#16](https://github.com/Hemanshujc1/YGo/issues/16)).
- **Stock is a movement log with reason codes**, read on every listing render, and never auto-cancelling an order ([#11](https://github.com/Hemanshujc1/YGo/issues/11)).
- **Products sell in measured units** with a minimum and a step, and search must match Hindi typed in English letters ([#10](https://github.com/Hemanshujc1/YGo/issues/10)).
- **Infrastructure is AWS.** Supabase was considered and rejected by the owner.

## Decision

**PostgreSQL on Amazon RDS in `ap-south-1` (Mumbai).**

| Concern | Decision |
| --- | --- |
| Engine | PostgreSQL, one store for everything |
| Hosting | Amazon RDS, `ap-south-1` Mumbai |
| Geo | PostGIS `geography` + GiST index |
| Nearby query | `ST_DWithin` against a **5 km constant**, then compare each shop's own radius |
| Search | `pg_trgm` + `unaccent` + the admin synonym table expanded at query time |
| Money | `NUMERIC(12,2)`, never binary floating point |
| Quantity | `NUMERIC(12,3)`, deliberately separate from money |
| Rounding | Once per line, half-up, to two decimals; the rounded line total is **stored** |
| History | Pricing snapshots and stock movements append-only, no UPDATE path |
| Corrections | Voids and cancellations write compensating records; nothing is erased |
| Stock | Movement log is the audit trail; `on_hand` is a projection written in the same transaction |
| Integrity | A reconciliation job compares the projection against the ledger and flags discrepancies |
| Bill numbers | Allocated from a **locked per-shop counter row** in the bill's own transaction |

**Why the nearby query is two steps.** `ST_DWithin(shop.geog, point, shop.radius)` cannot use the GiST index, because a per-row radius gives the planner no constant envelope to bound the scan with. The query pre-filters on a constant maximum and compares the per-shop radius afterwards. This is correctness-critical rather than an optimisation, and it is easy to write in a way that silently drops the index while still returning the right rows.

**Why 5 km is now a schema value.** The constant above *is* the platform's maximum permitted service radius, which had been carried as an unresolved config item. It is set at 5 km: generous enough never to exclude a legitimate shop, while per-shop radius stays configurable at the 2-3 km the product describes. Raising it later costs one line and a slightly slower pre-filter.

**Why money and quantity are different types.** 0.250 kg is a real quantity and 1.33333 is not a real price. Keeping both at two decimals would round sales of loose goods; keeping money at three would invent paise. Quantity times unit price produces more decimals than money has, so the single rounding point per line is what makes a bill add up at a counter.

## Consequences

**What this forbids.** No binary floating point in any financial or quantity path, in the database or in application code. No UPDATE on a pricing snapshot or a stock movement. No global sequence for bill numbers — a sequence skips on rollback and [#16](https://github.com/Hemanshujc1/YGo/issues/16) says never skipped. No recomputation of a line total on read. No Supabase, and no managed Postgres outside `ap-south-1`.

**What it constrains elsewhere.** [#21](https://github.com/Hemanshujc1/YGo/issues/21) inherits a connection-limit problem: a request-per-invocation serverless backend exhausts Postgres connections without pooling, and managed pooling costs money, which argues for a long-lived server process. [#25](https://github.com/Hemanshujc1/YGo/issues/25) inherits instance sizing, storage class, the backup and restore posture, and confirming the PostGIS version pairing on the chosen engine version.

**What it costs.** A new AWS account now gets a credit-based **six-month Free plan** (100 USD, up to 100 USD more) that **closes itself at six months or when credits run out**; the legacy twelve-month free tier applies only to accounts activated before 15 July 2025. An India billing address bills through AISPL in rupees with **18% GST that is unclaimable until the entity is GST-registered**. RBI's recurring-payment rules make a repeating card charge a real failure mode — the third payment-instrument risk on this project after the Apple enrolment and the Google Cloud billing account the Android map SDK needs.

**What it buys.** Exact money in the schema instead of in a library. A spatial query in metres on a spheroid. A stock projection fast enough for the hottest read in the app, with the ledger still able to rebuild it, and a reconciliation job that turns an offline-sync defect into an alert rather than a shopkeeper's complaint.

## Alternatives considered

**MySQL.** VaayuGO's choice, so the continuity argument was real. Rejected on weaker spatial and text-search support, and because the surrounding ecosystem is Postgres-first. Worth noting that `decimal.js` in VaayuGO's dependencies is a symptom of money being computed in JavaScript floats over a database not holding exact decimals — this decision moves that into the schema.

**A document store.** The only precedent in the reference material is Usthaan's Pouch/Couch usage. Rejected: this domain is relational — orders to lines to snapshots to statements — and the money invariants are exactly what transactions and constraints exist for.

**Plain latitude and longitude with Haversine in SQL.** At this shop count it performs identically to PostGIS, and it was rejected only on correctness: metres on a spheroid against hand-rolled trigonometry with a degree bounding box, in the single query that decides whether a customer sees any shops at all.

**A dedicated search engine (Meilisearch, Typesense).** Rejected for Phase 1 as one more service to run, back up and keep consistent, for a catalogue of a few thousand rows that trigram search handles.

**On-hand computed from the ledger on every read.** Rejected: it puts an aggregate on the most frequent query in the app. **On-hand as the sole truth** was rejected for the opposite reason: it discards the ability to rebuild, which is the only reason to keep a log at all.
