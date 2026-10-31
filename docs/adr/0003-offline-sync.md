# ADR-0003: Offline sync

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#20 Offline sync approach](https://github.com/Hemanshujc1/YGo/issues/20)

## Context

[#11](https://github.com/Hemanshujc1/YGo/issues/11) settled the offline **policy** before any mechanism was chosen, and that policy is what rules out a sync framework:

- **Offline**: counter billing, stock adjustment, marking out of stock, and the delivery screens. **Online only**: accepting or rejecting orders, marking ready, price and catalog edits, and anything about money owed.
- The device caches its own listings, stock and today's accepted orders, queues up to **500 actions or 72 hours**, then blocks new billing.
- **Orders and money: the server wins.** A counter bill is a **delta** on the movement log and applies in any arrival order. Only an absolute *set stock to N* can conflict, and it resolves by **server receipt order, never the client clock**.
- Bill numbers are **sequential per shop, never reused or skipped** ([#16](https://github.com/Hemanshujc1/YGo/issues/16)); an offline bill carries a provisional number and is assigned its final one by the server on sync.
- Every queued action already carries **the client id of the action** ([#9](https://github.com/Hemanshujc1/YGo/issues/9)), and a device whose clock is outside a configured skew stamps its actions **clock-suspect**.

The storage substrate is fixed by [ADR-0001](0001-mobile-app-framework.md): `expo-sqlite` with SQLCipher, with the read cache and the write queue kept as separate mechanisms.

## Decision

**A custom SQLite outbox on the device, plus explicit backend sync endpoints. No sync framework.**

| Concern | Decision |
| --- | --- |
| Mechanism | Hand-written outbox + own endpoints |
| Outbox row | Client action id, **per-device monotonic sequence**, device id, shop id, action type, payload, client timestamp, clock-suspect flag, attempt count, status, server result |
| Order | Strict first-in-first-out per device |
| Transport | **One batch POST** per sync attempt, answered with a **per-action result array** |
| Idempotency | Server stores processed client action ids for **30 days**; a replay returns the original result |
| Staleness | Server **rejects** actions older than a hard bound |
| Clock skew | Clock-suspect actions are **accepted and flagged for Admin**, never dropped, never silently trusted |
| Bill numbers | Assigned server-side at apply time, returned in the result array, replacing the provisional number |
| Permanent failure | **Dependency-aware quarantine**: apply the rest, flag Admin, show "1 bill needs attention" in-app |
| Pull | Cursor delta pull with a `since` marker per shop, on app open, on a timer, and on push |
| Deletions | **Soft deletes with `deleted_at` on everything the device caches**; the delta pull returns deletions as rows |
| Limits | 500 actions / 72 hours enforced on the device and blocking new billing; the server enforces its own bound independently |

**Why the per-device sequence number exists alongside the client action id.** The id proves an action is not a duplicate. The sequence proves none is **missing** — and a bill that silently never arrives is money the shop believes it recorded.

**Why one batch rather than a request per action.** It gives atomic ordering, and it is what lets a single response hand the device all its final bill numbers. Forty separate requests would run over exactly the connection that caused the queue in the first place.

**Why a poison action never blocks the queue.** [#17](https://github.com/Hemanshujc1/YGo/issues/17) deliberately keeps counter billing working even for a *suspended* shop. A malformed queued action must not achieve what suspension is not permitted to achieve. It is never discarded either, because it is the shop's own money. Dependency awareness is what makes this safe rather than merely convenient: a quarantined bill must quarantine its void, or the void applies to nothing and stock drifts permanently.

## Consequences

**What this forbids.** No sync framework. No use of the read cache to hold a queued write ([ADR-0001](0001-mobile-app-framework.md)). No client clock as a conflict tiebreaker. No hard deletes on any table the device caches. No blocking the queue on a single failed action. No discarding a queued action, ever.

**What it requires that is easy to miss.** Tombstones on every cached table — a row hard-deleted on the server is a row the device never hears about, so a withdrawn listing stays sellable on that phone forever, and the symptom is a customer complaint rather than an error. In-app wording for the 72-hour block **before** it happens to a real shop on a bad network. A defined owner for quarantined actions and for the reconciliation discrepancies that [ADR-0002](0002-database-and-geo-query.md) will surface.

**What it costs.** Hand-written synchronisation is a category with a long history of subtle defects, and a defect here loses a shop's money. Three things contain that: the policy was decided before the mechanism, the rules are narrow, and ADR-0002's reconciliation job independently compares the stock projection against the ledger. It remains the highest-risk component in Phase 1.

**The unmitigated exposure.** Until an action syncs it exists on exactly one phone. A lost, wiped or stolen device loses up to 72 hours of counter bills and nothing can recover them. This is accepted rather than solved; [#12](https://github.com/Hemanshujc1/YGo/issues/12) permits a second phone per shop but Phase 1 does not coordinate two queues.

**What it hands [#21](https://github.com/Hemanshujc1/YGo/issues/21).** The API contract now owes: one batch push endpoint, one cursor pull endpoint, a per-action result shape carrying assigned bill numbers, idempotency storage, the staleness bound, and a separate photo upload path — because a batch carrying image data is a different size class, so the action references the photo and the photo uploads on its own.

## Alternatives considered

**PowerSync.** The strongest candidate: an officially supported React Native SDK, SQLite as the local source of truth, and a persistent upload queue. Rejected because every one of #11's conflict rules would have to be overridden through a custom write path, leaving the engine doing only the read side — one shop's listings, stock and today's orders. Its free tier also deactivates after about a week of inactivity, and the paid tier is 49 USD a month, for a component replacing roughly one endpoint and one table.

**ElectricSQL.** Read-sync only, with no write path, so the outbox would still have been written by hand. That left no reason to add it.

**libSQL embedded replicas.** Flagged as a candidate while closing [#22](https://github.com/Hemanshujc1/YGo/issues/22), since `expo-sqlite` ships a real `syncLibSQL()`. Rejected because it replicates a whole database: it cannot express per-shop scoping, and server-assigned bill numbers are not a replication concept.

**Realtime subscriptions for the pull side.** Rejected for Phase 1 as a second transport with its own reconnect and authentication story, for data a shopkeeper reads a few times an hour.

## Amendment, 13 Oct 2026: the bill reference is permanent, the bill number is added

This record says an offline bill "carries a provisional number" which the server's number later replaces. The PRD consistency review found that a number which is replaced cannot be on a bill the shop has already shared with its customer.

**A counter bill has two identifiers, and neither replaces the other** (PRD BIL-5).

- The **bill reference** is generated on the device at the moment of sale. It is unique, permanent, printed on every copy, and is the outbox row's client action id or derived from it.
- The **bill number** is the gapless per-shop sequence. It is still allocated server-side at apply time from the locked counter row (ADR-0002) and still returned in the result array. The device stores it beside the reference.

A bill shared before sync shows the reference and "number pending". A quarantined bill has no number until it is resolved. Replaying an action returns the same number. Numbers follow the order in which bills reach the server, so two devices syncing in either order leave an unbroken sequence but not necessarily the same number on the same bill.

Everything else in this record stands.

## Amendment, 31 Oct 2026: confirmed access loss erases the device copy

The owner explicitly accepted one exception to never discarding queued work (#48, round 1; #394): after an authenticated check confirms unlinking or shop closure, erase that account's local database and encryption key, including pending actions, and explain what could not be sent. Network failure and session expiry do not establish lost shop access. Failed erasure blocks reopening across restarts and offers retry and support. Voluntary sign-out still blocks unacknowledged work; acknowledged permanent failures require a warning and remain encrypted for the same account.
