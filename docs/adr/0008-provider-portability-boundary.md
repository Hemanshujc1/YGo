# ADR-0008: Provider portability boundary

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#25 Hosting and operations](https://github.com/Hemanshujc1/YGo/issues/25)

## Context

[ADR-0005](0005-hosting-and-operations.md) put the platform on AWS in `ap-south-1`. The owner has confirmed AWS as the initial choice and required that the code remain portable so another provider is possible later.

"Portable" is the word that ruins architectures. Taken literally it produces an abstraction over every dependency, each one costing effort every day to buy an option exercised at most once. Taken as a slogan it produces nothing at all, and the AWS SDK ends up imported in thirty files. This record fixes the boundary: what is deliberately replaceable, what is deliberately not, and the test that settles any future argument.

Constraints fixed before this decision:

- **One Linux instance and one managed PostgreSQL instance**, no load balancer and no NAT gateway ([ADR-0005](0005-hosting-and-operations.md)). The AWS services actually consumed are EC2, RDS, S3, SES, Route 53, CloudWatch and SSM Parameter Store.
- **One Fastify service on Node 26 LTS**, ESM, with `@ygo/contracts` as the single definition of the `/v1` contract and **money arithmetic in SQL** ([ADR-0004](0004-backend-shape-and-api-contract.md)).
- **PostgreSQL with PostGIS**, a bounded radius query, and separate money and quantity precision ([ADR-0002](0002-database-and-geo-query.md)).
- **No second Node process**; the web apps are static files ([ADR-0006](0006-web-apps.md)).
- **Shared ESLint configuration** in `@ygo/eslint-config`, which already bans numeric coercion in money paths ([ADR-0007](0007-monorepo-and-shared-packages.md)).

## Decision

**The architecture chosen in ADR-0005 is already the least-locked-in shape available — a plain virtual machine plus managed PostgreSQL — so portability is maintained by two adapter seams and a lint rule, not by an abstraction layer.**

The test, stated as a number so it can be argued with: **a move to another provider should cost one to two days of work at pilot data volume.** Any proposed abstraction that does not reduce that number is refused, and any dependency that raises it needs this record amended.

| Concern | Decision | Portable because |
| --- | --- | --- |
| Compute | Linux, `systemd`, Nginx, an esbuild bundle | Every provider rents a Linux box |
| Database | **PostgreSQL, not abstracted.** SQL written directly, PostGIS, no ORM as a portability layer | Managed PostgreSQL with PostGIS exists everywhere; `pg_dump` is the migration |
| File storage | Behind one `FileStorage` interface, with the **S3 API** as the wire protocol and the endpoint configurable | S3's API is a de facto standard, implemented by every competitor |
| Email | Behind one `Mailer` interface | **No standard exists.** This is the seam that earns its keep |
| Configuration | **Environment variables only.** Nothing in the application reads a provider configuration service | Parameter Store populates the environment at boot, outside the application |
| Logs | `pino` JSON to standard output. The application does not ship its own logs | Shipping is an agent's job, replaceable without touching code |
| Background jobs | In-process scheduling with state in PostgreSQL, already alarmed on staleness | No managed queue to leave behind |
| Sessions and roles | Implemented in the service per ADR-0004 | No managed identity provider to migrate off |
| AWS SDK | Importable **only** inside `apps/server/src/adapters/`, enforced by `no-restricted-imports` on `@aws-sdk/*` in `@ygo/eslint-config` | The blast radius of a provider change is one directory |

**Two adapters, two implementations each.** `FileStorage` and `Mailer` each ship an AWS implementation and a local-development implementation — the filesystem and a local mail catcher. The local pair is not a convenience: it is the only thing that proves the seam is real, and it is also why the test suite never touches a paid service or needs credentials.

**Why the database is deliberately not abstracted.** This is the one that looks inconsistent and is not. PostgreSQL is not a provider service, it is software every provider rents; the portability already exists at the product level and costs nothing to keep. An abstraction over it — an ORM adopted for portability rather than for ergonomics — would be paid for in every query, would fight ADR-0002's PostGIS radius query and ADR-0004's rule that money arithmetic happens in SQL, and would buy an option that `pg_dump` already provides. What is forbidden instead is narrow and sufficient: nothing proprietary to RDS or Aurora.

**Why S3's API is not lock-in.** DigitalOcean Spaces, Cloudflare R2, Backblaze B2, MinIO and the rest all implement it. Writing against `@aws-sdk/client-s3` with a configurable endpoint and region means the move is a change of environment variables plus a data copy, so the adapter exists for the small differences rather than for a rewrite.

**What is accepted as not portable**, stated so it is not discovered during a migration: the deploy pipeline, which assumes an OIDC role and would become another credential mechanism; the alarms, log shipping and health check, which are re-created rather than moved; and **email sender reputation**, which is built per provider and per domain, making it the slowest part of any switch.

## Consequences

**What this forbids.** No `@aws-sdk/*` import outside `apps/server/src/adapters/`, and none at all in `packages/` or in any client app. No AWS compute or integration service: no Lambda, no Fargate or ECS, no App Runner, no API Gateway, no SQS, no EventBridge, no Step Functions, no AppSync. No Cognito — ADR-0004 owns sessions. No DynamoDB. No Aurora-only feature, and no RDS-proprietary extension, including `aws_s3` for import or export. No provider configuration service read at runtime from application code. No presigned-URL semantics beyond what the S3 API specifies. No hard-coded bucket name, region, endpoint or sender address anywhere in the source. And no abstraction added "for portability" without an argument that it lowers the one-to-two-day figure above.

**What it requires that is easy to miss.** The local implementations of both adapters must be the ones used in day-to-day development, because a seam exercised only in production rots quietly and is discovered broken at the worst moment. The S3 endpoint must be configuration from the first commit, not added later, since retrofitting it means auditing every call site. And the two interfaces belong in `apps/server`, not in a shared package: nothing else may consume them, because a client app that learns how files are stored defeats the purpose.

**What it costs.** Two indirections that a single-provider codebase would not have, and the genuine convenience of managed services forgone — Cognito and SQS in particular would each save a solo developer real time, and are refused here for an option that may never be exercised. That is the trade being made deliberately rather than by accident. The discipline is also only as strong as the lint rule, which is why it is a rule and not a paragraph.

**What it buys.** A provider switch that is config, a data copy and a rebuilt pipeline, rather than a rewrite. Tests and local development that need no cloud account and no credentials, which matters immediately: development can proceed for weeks before the AWS account exists. And one honest sentence available to the owner at any point — changing provider costs about two days — instead of an unknown.

## Alternatives considered

**A full abstraction layer over every provider dependency.** The textbook answer, and the reason "portable" has a bad reputation. Rejected because it prices an option far above its value: the cost is paid in every file, every day, for a switch that may never happen, and the layer itself becomes the thing that is hard to change.

**An ORM adopted for database portability.** Rejected on the grounds above. PostgreSQL is already portable, and the abstraction would conflict with the PostGIS query and the money-in-SQL rule. If an ORM is ever adopted it will be for developer ergonomics, argued on those merits, not justified as portability.

**Containers for portability.** The usual recommendation, and half true: an image is portable while the orchestration around it is not, so the saving is smaller than it appears. Rejected for Phase 1 deployment because ADR-0005 deploys a bundle to one instance under `systemd`, and a container adds a build and a runtime to supervise on a 2 GiB box for no portability the esbuild bundle lacks. Kubernetes on a single small instance would be a cost with no benefit at all. Unaffected by this: PostgreSQL in Docker for local development, which stays.

**Infrastructure as code as the portability strategy.** Worth separating from this decision. Terraform or OpenTofu makes a rebuild repeatable, but the modules themselves do not port — provider resources differ — so it is not a portability mechanism. It may be justified later on its own merits, as a defence against an instance that was configured by hand and cannot be recreated.

**Deciding the provider later and building against nothing.** Rejected because it does not avoid the work, it defers it into the launch window, and the long-lead items — SES production access, the sending domain's authentication records — are exactly the ones that would be discovered late. Choosing AWS now and keeping the seams thin gets the same flexibility at a fraction of the risk.

**Multi-provider from the start.** Two bills, two sets of credentials and two monitoring setups for one developer, to hedge a risk that one to two days of work already covers.
