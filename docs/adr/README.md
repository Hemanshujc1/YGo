# Architecture decision records

One record per hard-to-reverse technical decision. An ADR is written only when a decision is **hard to reverse, surprising, and a real trade-off** — all three. Everything else lives in the resolution comment on its decision ticket and, where it is domain language, in the root `CONTEXT.md`.

From the YGo Phase 1 decision map ([#1](https://github.com/Hemanshujc1/YGo/issues/1)): **one ADR per stack ticket**, written when that ticket closes.

## What an ADR is for

The resolution comment on the ticket is the record of *reasoning* — the questions asked, the facts found, the options rejected. The ADR is what a new agent or developer reads **first**: the decision itself, what it commits the codebase to, and what it forbids. An ADR that needs the ticket read alongside it has failed.

## Convention

- Filename: `NNNN-short-kebab-title.md`, numbers never reused.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, or `Deprecated`. `Proposed` means the technical content is decided but something in it still needs the owner's confirmation — a spending commitment, a date, or an accepted risk — and it names what. Records are **never edited to change a decision** — a new ADR supersedes an old one and the old one's Status line is updated to point at it.
- Every ADR links back to the ticket whose resolution comment holds its reasoning.
- **Reading the pilot size in a Context section.** Several records open with "a one-month pilot of fifty to eighty shops". That was the launch shape when they were written. The launch is now two stages: a soft launch of one to two weeks with 12 to 20 shops, then an official launch growing toward 50 to 80 (`CONTEXT.md`, Launch stages). Fifty to eighty remains the size the system is built for, so no decision in any record changes, and the records are left as written.

## Template

```markdown
# ADR-NNNN: <title>

- **Status**: Accepted
- **Date**: YYYY-MM-DD
- **Ticket**: <link to the decision ticket>

## Context

What forced the decision, and the constraints that were already fixed before it was made.

## Decision

What was chosen, stated so it can be checked against the code.

## Consequences

What this commits the codebase to, what it forbids, and what it costs. Both directions.

## Alternatives considered

What else was on the table and why it lost. One short paragraph each.
```

## Index

- [ADR-0001: Mobile app framework](0001-mobile-app-framework.md) — React Native with Expo, SDK 57 pinned, two apps from one codebase.
- [ADR-0002: Database, geo query and money precision](0002-database-and-geo-query.md) — PostgreSQL on Amazon RDS in Mumbai, PostGIS with a 5 km bounded radius query, separate money and quantity precision.
- [ADR-0003: Offline sync](0003-offline-sync.md) — a custom SQLite outbox and explicit sync endpoints, no sync framework.
- [ADR-0004: Backend shape and API contract](0004-backend-shape-and-api-contract.md) — one Fastify service on Node 26 LTS, REST with shared Zod schemas, money arithmetic in SQL only.
- [ADR-0005: Hosting and operations](0005-hosting-and-operations.md) — AWS as the initial provider. One EC2 instance and one Single-AZ RDS instance in Mumbai, no load balancer, no NAT gateway; about 44 USD a month including GST after credits. The domain name is deferred to [#27](https://github.com/Hemanshujc1/YGo/issues/27).
- [ADR-0006: Web apps](0006-web-apps.md) — no Next.js; two static Vite and React bundles with Tailwind, served by Nginx, plus a five-page public site that Play review and SES both depend on.
- [ADR-0007: Monorepo and shared packages](0007-monorepo-and-shared-packages.md) — one repository, pnpm workspaces and Turborepo, with seven shared packages shipped as TypeScript source and no build step.
- [ADR-0008: Provider portability boundary](0008-provider-portability-boundary.md) — AWS stays replaceable through two adapter seams and a lint rule rather than an abstraction layer; the database is deliberately not abstracted, and a provider switch is budgeted at one to two days.
- [ADR-0009: A shared package for the two mobile apps](0009-shared-mobile-package.md) — `@ygo/mobile` holds code both mobile apps use, words excepted; ADR-0007's "no shared UI package" narrowed to mobile and web.
