# ADR-0005: Hosting and operations

- **Status**: Accepted (13 Oct 2026). Budget, AWS plan timing and the single-AZ risk are confirmed by the owner, and AWS is confirmed as the initial provider with code portability maintained per [ADR-0008](0008-provider-portability-boundary.md). The choice of domain name is deferred by the owner pending the company name and is tracked as an operational dependency in [#27](https://github.com/Hemanshujc1/YGo/issues/27), not as an open question in this record.
- **Date**: 2026-10-13
- **Ticket**: [#25 Hosting and operations](https://github.com/Hemanshujc1/YGo/issues/25)

## Context

The backend, database, photos and email have to run somewhere for a one-month pilot of fifty to eighty shops, operated by one person who is also writing the product.

Constraints fixed before this decision:

- **Infrastructure is AWS**, in `ap-south-1`, by the owner's decision ([ADR-0002](0002-database-and-geo-query.md)). Supabase was considered and rejected.
- **The backend is one long-lived process**, not functions ([ADR-0004](0004-backend-shape-and-api-contract.md)).
- **A new AWS account suspends itself at six months**, holds data for ninety days, then erases it (ADR-0002).
- **SES is sandboxed per region** until production access is granted, which is a soft-launch blocker ([#18](https://github.com/Hemanshujc1/YGo/issues/18) amendment).
- The only production system anyone on this project has operated is VaayuGO's DigitalOcean droplet with Nginx, Certbot and PM2 — no Docker, no CI, no tests.

All prices in this record were read from **AWS's public price list files for `ap-south-1`** (offer version 20261012), not from third-party pricing sites, which disagreed with each other by up to 90 per cent on the same instance.

## Decision

**One EC2 instance and one Single-AZ RDS instance in one VPC in `ap-south-1`, with S3 for photos and SES for email. No load balancer and no NAT gateway.**

| Concern | Decision |
| --- | --- |
| Region | `ap-south-1` (Mumbai), single availability zone |
| Compute | One EC2 **`t4g.small`** (Graviton, 2 vCPU, 2 GiB), Amazon Linux 2023 |
| Database | One RDS PostgreSQL **`db.t4g.micro`, Single-AZ**, 20 GB gp3, private subnet, not publicly accessible |
| Engine | PostgreSQL 17, current minor; **the PostGIS version pairing is confirmed in the console at creation**, not assumed |
| Web tier | **Nginx + Certbot on the instance.** No load balancer |
| Photos | S3, private, versioned, presigned PUT and GET |
| Email | SES in `ap-south-1`, verified sending domain with DKIM |
| DNS | Route 53 hosted zone |
| Secrets | SSM Parameter Store SecureString, read by the instance role |
| Shell access | **SSM Session Manager. Port 22 is never open and there is no SSH key** |
| Networking | EC2 in a public subnet behind an Internet Gateway; RDS private. **No NAT gateway** |
| Environments | Production and staging as **two databases and two systemd units on the same hardware** |
| Backups | RDS automated, 7 days; weekly manual snapshot; nightly `pg_dump` to S3; **monthly copy off AWS entirely** |
| Restore | **One timed restore drill into staging before launch, and the measured recovery time written down** |
| Process restart | `systemd` with `Restart=always` and `RestartSec=5`; a crash loop raises an alarm rather than being silently restarted forever |
| Alarms | Billing alerts first (zero-spend, 25, 50, 100 USD), then 5xx rate, instance CPU, database CPU, free disk, free memory, and **`job_runs` staleness** (ADR-0004) |
| Alarm delivery | SNS to email — the first 1,000 email notifications a month are free |
| External check | **A Route 53 health check on the public endpoint** — free for the first 50 against an AWS endpoint, and it watches from outside the instance it is watching |
| Logs | `pino` JSON to CloudWatch Logs, **7-day retention**, at `info` in production |
| Deploys | GitHub Actions assuming an **OIDC role — no long-lived AWS keys** |

**Why this shape.** It is the closest AWS analogue of the one production system this project has actually run. The single change is that the database becomes managed, so backups, patching and point-in-time recovery stop being a solo developer's manual routine.

**Why no load balancer.** An ALB is 0.0239 USD per hour in Mumbai — 17.45 USD a month before capacity units — in front of a single instance it cannot fail over to anything. It also forces the TLS question: an ACM certificate is free but **cannot be attached to an EC2 instance directly**, only to a load balancer or CloudFront. Certbot is free and already understood.

**Why no NAT gateway.** 0.056 USD per hour plus 0.056 USD per GB, about **41 USD a month — more than everything else in this record combined** — and it buys nothing, because the only component needing outbound internet is the application instance, which sits in a public subnet. This is the most common way a small AWS bill becomes a large one.

**Why staging shares the hardware.** A second instance and a second database roughly double the bill. Two databases on one RDS instance and two services on one EC2 instance give staging a real deployment target, real migrations and a real TLS endpoint for approximately nothing. The honest cost is that staging contends for CPU and disk with production; the alternative is testing migrations on live shop money.

**Why backups have an off-AWS layer.** RDS automated backups are destroyed with the instance and live inside an account that can suspend and erase itself at six months. A backup that exists only inside the thing it is backing up is not a backup.

## Consequences

**What this forbids.** No NAT gateway. No load balancer in Phase 1, and therefore no ACM certificate. No Multi-AZ. No publicly accessible database. No open port 22 and no SSH key material. No long-lived AWS access keys in CI. No Secrets Manager at 0.40 USD per secret per month where Parameter Store is free. No managed service outside `ap-south-1` except the Route 53 monitoring dependency clarified below. No resource created before the billing alarms exist. And, per [ADR-0008](0008-provider-portability-boundary.md), **no AWS compute or integration service at all** — no Lambda, ECS, API Gateway, SQS, EventBridge, Cognito or DynamoDB — which is what keeps this hosting choice reversible.

**Monitoring clarification (#131, 20 Oct 2026).** The Mumbai-only rule has one AWS-required exception: Route 53 publishes endpoint health metrics only in `us-east-1`, so its health alarm and SNS email topic must also live there. The endpoint, instance, database, logs, other alarms and their SNS topic remain in `ap-south-1`. The original cost table below predates the HTTPS health-check feature charge and the extra metrics/alarms; use the current [monitoring estimate](../operations/monitoring.md#cost) before activation.

**What it costs, verified.** At 730 hours a month, in US dollars:

| Line | Rate | Monthly |
| --- | --- | --- |
| EC2 `t4g.small` | 0.0112 /hr | 8.18 |
| EBS gp3, 30 GB | 0.0912 /GB-mo | 2.74 |
| EBS snapshots, ~30 GB | 0.05 /GB-mo | 1.50 |
| Public IPv4 address ×1 | 0.005 /hr | 3.65 |
| RDS `db.t4g.micro` Single-AZ | 0.021 /hr | 15.33 |
| RDS gp3 storage, 20 GB | 0.131 /GB-mo | 2.62 |
| RDS backups, ≤20 GB | free to 100% of provisioned | 0.00 |
| S3, 20 GB plus requests | 0.025 /GB-mo | 0.60 |
| SES, ~5,000 emails | 0.00016 /email | 0.80 |
| Route 53 hosted zone | 0.50 /zone-mo | 0.50 |
| Route 53 health check ×1 | free to 50 AWS endpoints | 0.00 |
| CloudWatch alarms ×6 | 0.10 /alarm-mo | 0.60 |
| CloudWatch Logs, ~1 GB ingest + storage | 0.67 /GB + 0.03 /GB-mo | 0.70 |
| SNS alarm emails | free to 1,000 /mo | 0.00 |
| Data transfer out, under 100 GB | free allowance | 0.00 |
| **Service charges before tax** | | **37.22** |
| **GST at 18 per cent** | | **6.70** |
| **Monthly total** | | **43.92** |

At roughly 88.5 rupees to the dollar that is about **3,900 rupees a month**, inside the provisional budget of 4,000 to 4,500.

**The variable lines**, in order of how much they can move: data transfer out above the free 100 GB at 0.1093 USD per GB; CloudWatch Logs ingest at 0.67 USD per GB, which rises with traffic and with log verbosity; S3 storage as product photos accumulate; SES above about 5,000 emails a month. Everything else in the table is fixed by the instance sizes.

**What is actually payable while credits are active.** The credits offset **service charges, not tax**. No AWS document states whether a credit reduces the GST base, and the conservative reading — the one assumed here — is that it does not. So during the credit period the expected cash outflow is **the GST line alone, about 6.70 USD or roughly 590 rupees a month**, plus the domain. This must be verified against the first real invoice; if GST turns out to be computed on the post-credit net, the first months are free instead, which is a pleasant surprise rather than a plan. GST is **unclaimable until the entity is GST-registered**, which is stage two, so it is a true cost and not a recoverable input.

**How long the credits last.** At 37.22 USD of service charges a month, the 100 USD sign-up credit covers about 2.7 months and the full 200 USD about 5.4 — either way longer than the one-month pilot.

**What is outside the credits.** The domain name, at roughly 700 to 1,300 rupees a year on renewal. The 18 per cent GST. And, already on the obligations list, the Apple Developer Program, Google Play's one-time fee, and the Google Cloud billing account the Android map SDK requires.

**The line that scales.** Data transfer out is 0.1093 USD per GB above 100 GB a month, so 500 GB of product-image traffic adds about 44 USD and doubles the bill. Compressed, resized images with long cache headers are the mitigation; CloudFront is the answer only when they stop being enough.

**What it costs in reliability, stated against the documentation.** One instance, one availability zone, one database, one person. Every component is a single point of failure.

What **Multi-AZ at about 15 USD a month more** actually buys, and only this: an automatic switch to a synchronously replicated standby in another availability zone when the primary host, its storage or its availability zone fails, and shorter write interruption during minor-version patching. The RDS user guide puts failover at **typically 60 to 120 seconds**, and says large transactions or a lengthy recovery can make it longer.

What it does **not** buy: protection from a bad migration, a wrong `DELETE`, application corruption, or an account suspension. The standby is a replica, so it faithfully reproduces all four. Those are what backups are for, which is why the backup layers above are not optional and the drill is what makes them real.

**The data-loss question, honestly.** AWS's Multi-AZ product page says failover completes "with zero data loss"; that phrase appears in marketing copy, not as a documented recovery-point objective in the user guide, so it is not relied on here. What the user guide does document is the Single-AZ position: **"RDS uploads transaction logs for DB instances to Amazon S3 every five minutes."** The honest statement of the accepted risk is therefore: a total loss of the database instance and its storage volume can lose **up to about five minutes of committed writes**, and recovery means a point-in-time restore, which provisions a fresh instance and takes minutes to tens of minutes. An availability-zone outage without storage loss is downtime, not data loss.

**What materially reduces that risk here, and is the reason Single-AZ is defensible.** Counter sales do not originate in the database. ADR-0003 puts every shop-side write in a durable SQLite outbox on the device, which retries. A database outage during the pilot therefore stops customer browsing and ordering, but a shop can keep billing at its counter and the queued actions arrive when the database returns. The five-minute window applies to writes already accepted by the server and not yet in a log shipment — and for those, the device still holds the action and the idempotency records make a retry safe.

**What it requires that is easy to miss.** Billing alarms **before the first resource**. The restore drill, without which the backup posture is a plan rather than a capability. SES production access for `ap-south-1`.

**The AWS plan policy**, as decided by the owner: stay on the **Free plan during development**, and **upgrade to a Paid plan before any real shop or customer data is stored, or the live pilot begins — whichever comes first — and earlier if a needed service turns out to be unavailable.** Remaining credits carry over on upgrade, so upgrading early costs nothing; the Free plan expires at the earlier of six months or credit exhaustion, cannot be extended, and on expiry **AWS suspends the account, holds the data for ninety days, and then permanently erases it**. Two reminders are therefore required: one for credit exhaustion and one for the six-month date, both set when the account is opened.

**The Free plan's unnamed restrictions are a live risk.** AWS's own FAQ says a Free plan account "is limited from accessing a subset of AWS services and offerings" and **does not say which** — the list is not published in the FAQ, and the limitations are removed only by upgrading. So the Free-plan-during-development policy cannot be verified in advance; it is verified by hitting a wall. The planned sequence is therefore to create every resource in this record early, on the Free plan, and treat any refusal as the trigger to upgrade rather than as a blocker to work around.

**SES production access is the most likely refusal, and it is on the launch path.** The sandbox allows 200 messages per 24 hours only to verified addresses, which is enough for development and not enough for a soft launch where email is the sign-in mechanism. Approval is discretionary, takes days, and is commonly refused when the sending domain has no real website behind it. Consequences: the domain must be bought and the DKIM, SPF and DMARC records published **well before** the launch date, not in launch week, and the request must be raised early enough to survive one rejection and a resubmission.

## The domain name — researched, deferred by the owner

**Deferred on 13 Oct 2026**: the company name is not settled, so the domain cannot be chosen yet. The decision moved to [#27](https://github.com/Hemanshujc1/YGo/issues/27) because it is a branding question with a launch-timing consequence rather than a hosting question, and holding this record open on it was blocking nothing else. The research below stands; availability decays, so any name on the available list must be re-checked immediately before purchase.

**The launch-timing consequence, recorded here because it is a hosting dependency.** Four things must happen in sequence once a name exists: purchase and DNS delegation; DKIM, SPF and DMARC published; the five-page public site live on it (ADR-0006); and SES production access requested for `ap-south-1`, which is discretionary, takes days, and can fail once. That chain is **two to three weeks**, it cannot be compressed, and until it completes no shopkeeper and no customer can receive a sign-in code. The domain name therefore sets the earliest possible pilot date. The build is unaffected and proceeds in parallel.

The domain is the one launch cost AWS credits do not cover, and three separate things depend on it: the SES sending domain with DKIM, SPF and DMARC; the TLS certificate; and the web apps in [#23](https://github.com/Hemanshujc1/YGo/issues/23). **Nothing is purchased until the owner approves a specific name.**

Checked against the registries on 13 Oct 2026 — the `.in` registry at `whois.nixiregistry.in` and the gTLD registrars, each sweep run with a known-registered and a known-free control:

**Every short form is gone.** `ygo.in` has been registered since 2015 and is parked on `parkingcrew.net`, which means a squatter's asking price rather than a registration fee. `ygo.com`, `ygo.app`, `ygo.co`, `ygo.shop`, `ygo.store`, `ygo.site`, `ygo.space` and `yugo.in` are all taken. `ygo.co.in` was registered in May 2026. So is `getygo.com`, `ygonow.com` and `ygolocal.com`.

**Available:** in `.in` — `ygonow.in`, `ygoapp.in`, `ygoshop.in`, `ygomart.in`, `ygolocal.in`, `getygo.in`, `heyygo.in`, `ygokart.in`, `myygo.in`, `ygodaily.in`, `ygostore.in`, `ygoindia.in`, `ygofresh.in`, `ygoquick.in`, `tryygo.in`, `useygo.in`, `ygobazaar.in`. In gTLDs — `ygoapp.com`, `ygomart.com`, `heyygo.com`, `ygoapp.co`.

**Recommendation: a `.in` domain, with `ygonow.in` first and `ygoapp.in` second.** `.in` is correct for a product that is hyperlocal by definition and will never serve customers outside India; it is recognised locally, and it is the cheapest of the options. Registration is roughly 700 to 1,300 rupees a year on renewal, with heavily discounted first years and multi-year terms commonly advertised at under 100 rupees — the renewal price is the one to compare, not the promotional first year. Route 53 lists `.com` at about 15 to 16 USD a year, and is more expensive than Indian registrars for `.in`. **Registering at a mainstream registrar and pointing the nameservers at the Route 53 hosted zone is cheaper than registering through Route 53 and costs nothing in capability**, since the 0.50 USD hosted zone in the table above is what actually serves DNS either way.

**One thing to know before choosing.** "YGO" is the established internet shorthand for Yu-Gi-Oh!, a Konami trading card game. This is not a trademark conflict — quick commerce and trading cards are unrelated goods — but it is why the short domains are all taken, and it means organic search for the bare term will return card-game results for the foreseeable future. It affects discoverability, not legality.

## Alternatives considered

**Keep the DigitalOcean droplet pattern on DigitalOcean.** The known quantity, and cheaper. Rejected because ADR-0002 put the database on RDS in `ap-south-1`, and splitting the application away from its database across providers adds latency to every query and a second bill.

**Elastic Beanstalk or ECS/Fargate.** Both remove the instance from view and add a deployment model to learn. Fargate also charges per task-hour at a premium over the equivalent instance. Rejected as abstraction bought before the problem, for a single process.

**Lambda plus API Gateway.** Already rejected in ADR-0002 on Postgres connection limits, and it would need a NAT gateway or VPC endpoints to reach a private database.

**ALB with an ACM certificate.** Rejected on cost: 17.45 USD a month, more than the server it fronts, to replace a free certificate that renews itself.

**Multi-AZ RDS.** Rejected for Phase 1 only. It doubles the database line from 15.33 to 30.66 USD to protect against an availability-zone failure during a one-month pilot, where the same money is better spent on the pilot.

**A separate staging instance.** Rejected on cost: it roughly doubles the bill to remove a contention risk that fifty to eighty shops will not generate.

**Infrastructure as code (Terraform or CDK).** Honestly rejected on effort: for about a dozen resources created once by one person, writing it is slower than the console, and the real reproducibility need in Phase 1 is the documented restore drill rather than a re-creatable VPC.

## Amendment, 13 Oct 2026: backups and account deletion

Account deletion erases personal data seven days after the request, and every backup layer above still holds it at that moment. Two rules reconcile the two. **Backups that contain personal data age out within 90 days**: nightly dumps are kept 30 days, weekly snapshots five weeks, and no more than two monthly off-AWS copies exist at once. **A deletion ledger**, holding only the opaque account pseudonym and the erasure time, is replayed after any restore and before the restored database serves a request, so a restore cannot bring a deleted person back. The ledger also records each removal of a block marker (the keyed hash of a blocked customer's phone number and email, kept only while the block is active), so a restore cannot bring back the marker of someone who has since been unblocked. The privacy policy states the 90 days. The eight-year financial records live in the database itself and do not depend on old backups.
