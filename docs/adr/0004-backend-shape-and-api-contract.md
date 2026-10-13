# ADR-0004: Backend shape and API contract

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#21 Backend shape and API contract](https://github.com/Hemanshujc1/YGo/issues/21)

## Context

One backend has to serve two mobile apps and Admin for a one-month pilot of fifty to eighty shops, maintained by a solo developer, with several coding agents working on separate branches.

Constraints fixed before this decision:

- **No request-per-invocation backend.** [ADR-0002](0002-database-and-geo-query.md): a serverless backend exhausts Postgres connections without paid pooling, so the backend is a long-lived process.
- **The sync protocol is already specified.** [ADR-0003](0003-offline-sync.md) owes this ticket a batch push endpoint, a cursor pull endpoint, a per-action result array carrying assigned bill numbers, idempotency storage, a staleness bound and a separate photo upload path.
- **The clients are two Expo apps from one TypeScript-strict repository** ([ADR-0001](0001-mobile-app-framework.md)), and a mobile app cannot be force-updated.
- **Money is exact in the schema**, not in application code (ADR-0002).
- A suspended shop and a deactivated staff member must lose access immediately ([#17](https://github.com/Hemanshujc1/YGo/issues/17)), and a login is never bound to a device ([#12](https://github.com/Hemanshujc1/YGo/issues/12)).

## Decision

**One Fastify service on Node.js 26 LTS in TypeScript strict, with a REST contract shared as Zod schemas.**

| Concern | Decision |
| --- | --- |
| Shape | **One service, one process, one deployable**, modular by domain |
| Runtime | **Node.js 26 LTS** (Active LTS from 28 Oct 2026, supported to Apr 2029), ES modules |
| Language | TypeScript, strict |
| Framework | **Fastify** — the schema is the route definition |
| API style | REST over HTTPS with JSON |
| Contract | One shared `@ygo/contracts` package of **Zod schemas**; types derived, never hand-written |
| Versioning | `/v1`, **additive changes only**; app version on every request; a configured floor returns one "update required" code |
| Errors | One envelope with a machine code. **The server never returns display text** |
| Database access | **Drizzle** for schema, migrations and typed queries, with raw SQL where the query is the point |
| Money | **Money arithmetic happens in SQL, never in JavaScript.** No decimal library in the backend |
| Migrations | Forward-only SQL files, applied by an explicit deploy step, **never on process boot** |
| Pooling | One `pg` pool, 10-15 connections, one process |
| Sessions | Email OTP issuing a short access token plus a **rotating refresh token in a server-side table** |
| Scoping | Role and shop id as claims; **every query scoped by shop id in the service layer** |
| Sync | `POST /v1/sync/actions`, `GET /v1/sync/changes?since=`, `POST /v1/uploads` returning a **presigned S3 PUT URL** |
| Jobs | A one-shot job CLI invoked by **systemd timers**, with a `job_runs` row per run |
| Logs | `pino` JSON to CloudWatch; `/healthz` checks the database; four alarms to email |
| Secrets | SSM Parameter Store SecureString, read by the instance role |
| Deploys | GitHub Actions authenticating by **OIDC role assumption, no long-lived keys** |

**Why one service.** The money invariants are single-database transactions — the pricing snapshot, the locked per-shop counter row, the stock projection written in the movement's own transaction. A service boundary between them would need a distributed transaction to recover what one Postgres transaction already provides, and would cost a deployment and a failure mode per boundary.

**Why Fastify and not Express.** Not speed. Fastify makes the schema the route definition, so a malformed request is rejected at the boundary by the same object the client validated against. A batch of queued counter bills is the one payload in this product that must never reach money code half-understood. Express 5 — VaayuGO's choice — has no validation of its own, so it gets bolted on per route and forgotten on one of them.

**Why REST and not tRPC.** The sync protocol is HTTP-shaped already: idempotency keys, a batch POST, a `since` cursor. A REST surface can be reproduced with `curl` while standing at a counter where the till is misbehaving. tRPC would also couple each mobile release to a server type version, and the installed base cannot be upgraded on demand.

**Why the refresh records are server-side.** A self-contained token cannot be revoked, and #17 requires revocation to be immediate. The cost is a database read per refresh, which at this scale is free.

**Why jobs run on systemd timers.** A long job inside the API process competes with request handling, and a crash takes the schedule with it. EventBridge plus Lambda would need VPC access to a private database, a second deployment artifact and a second runtime, to run a job on an instance that is already running.

## Consequences

**What this forbids.** No second service, and no network boundary inside the domain. No money arithmetic in JavaScript, and therefore no decimal library in the backend. No migration on process boot. No breaking change inside `/v1`. No display text in an API response. No long-lived AWS keys in CI. No ORM-generated SQL for the nearby-shops query or the trigram search — both are hand-written, because an ORM rewrite is how the GiST index gets silently dropped (ADR-0002). No secret in the repository, which is public.

**What it requires that is easy to miss.** A query plan for the geo and search queries checked into the repository and re-checked whenever either is touched, since a regression there is a silent code change rather than a failing test. A lint rule banning numeric coercion in money paths — "money arithmetic in SQL only" is a discipline, and an unenforced discipline is a comment. Rate limits on the OTP endpoints, because email is metered and quota-limited. A `job_runs` row per run, because a weekly statement that silently did not run is indistinguishable from a week with no orders.

**What it costs.** One process is one point of failure: a crash loop is a total outage for every shop and customer at once, and `systemd` restarting it is the whole of the recovery story. Additive-only versioning will be tested by the first wrong decision, and a breaking change to a shipped app during a one-month pilot has no graceful path except a forced update.

**What it buys.** A contract that fails to compile on both sides when one side changes it — the property that matters most with several agents on separate branches. Validation at the boundary as a structural property rather than a per-route habit. And a restart that is safe, because ADR-0003's outbox retries exactly the traffic a restart would otherwise endanger.

**What it hands [#24](https://github.com/Hemanshujc1/YGo/issues/24).** `@ygo/contracts` joins the shared-package list from ADR-0001, and it is the one package imported by every target: both apps, Admin and the server.

## Alternatives considered

**Express 5.** The continuity argument was real — VaayuGO runs Express 5 with Sequelize on CommonJS, and it is the only backend stack anyone here has shipped. Rejected because validation is the whole point at this boundary and Express has none, so the sync endpoints would depend on remembering to validate.

**NestJS.** A decorator architecture and a module system whose cost is repaid by a team coordinating across many modules. With one developer it is structure bought in advance of the problem.

**tRPC.** Attractive in a TypeScript monorepo, and it would have made the contract package unnecessary. Rejected on the version coupling: an installed mobile app pins the server's type surface, and the sync endpoints want explicit HTTP semantics.

**GraphQL.** One query language and a resolver layer for a product whose read patterns are known and few. Rejected as an extra layer with its own caching and error model.

**Prisma.** Rejected on PostGIS: raw SQL is a second-class citizen in exactly the two queries that matter most here, and its connection handling has its own opinions on a connection budget this tight.

**EventBridge plus Lambda for scheduled jobs.** Rejected as a second runtime and a second deployment artifact needing VPC access to a private database, to do work on an instance that is already paid for and running.

## Amendment, 13 Oct 2026: one pricing engine

"Money arithmetic happens in SQL" is tightened by the amendment to [ADR-0007](0007-monorepo-and-shared-packages.md): the pricing engine is a single SQL implementation called by the quote endpoint, order placement, partial-acceptance recomputation, the simulator and the statement job. No client computes a quote. The one exception is a counter bill's total, computed on the phone in integer paise for offline use and checked, never rewritten, by the server on sync. An earlier ticket's note that money is "stored as integer paise" is superseded by ADR-0002's `NUMERIC(12,2)`; integer paise is the phone's representation only.

## Amendment, 13 Oct 2026: sign-in methods, and four more interfaces at the edge

**Sign-in is not email OTP alone.** The Sessions row was written before [#18](https://github.com/Hemanshujc1/YGo/issues/18) was amended. Every role signs in with Google, with Apple on iOS, or with a 6-digit emailed code (PRD ACC-1). All three end in the same place: the service has a proven email address, and issues the short access token and the rotating server-side refresh token this record already describes. Google and Apple sign-in are the verification of a signed identity token inside the service. No managed identity provider is adopted, so ADR-0008's Sessions row is unchanged.

**Four interfaces sit beside `FileStorage` and `Mailer`.** ADR-0008 counts two adapter seams because two AWS services are used. The service also reaches four other things that a test must be able to replace, and each gets one interface with a real and a local implementation:

| Interface | Real implementation | Local implementation |
| --- | --- | --- |
| `IdentityVerifier` | Verifies Google and Apple identity tokens | Accepts tokens minted by the test |
| `PushSender` | Expo's push service (ADR-0001) | Records what would have been sent |
| `SmsSender` | None in stage one. The SMS sign-in flow is built and switched off (PRD ACC-10) | Records the code |
| `Clock` | System time | Set and advanced by the test |

`Clock` exists because the product is full of deadlines: the 120-second re-alert, the 600-second expiry, the five- and ten-minute confirmations, slot cutoffs, the 24-hour void, the 7-, 30- and 90-day deletion steps and the Monday statement. Every one of them reads time through it, in the service and in the jobs.

None of these is an AWS dependency, so the lint rule and the one-to-two-day portability budget in ADR-0008 are untouched.
