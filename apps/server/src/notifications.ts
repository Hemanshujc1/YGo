import { type NotificationKind, ORDER_ANSWER_SECONDS, type OrderStatus, type RejectReason } from "@ygo/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Push, PushResult, PushSender } from "./adapters/push-sender";
import { withTransaction } from "./db";

type Order = { number: number; shopName: string; reason: RejectReason | null };

/** The customer reads the same reason C19 shows (owner's answer 3 on #425). */
const rejectReasons: Record<RejectReason, string> = {
  out_of_stock: "Items out of stock",
  too_busy: "Too busy right now",
  closing_soon: "Closing soon",
  cannot_deliver: "Can't deliver to this address",
};

/**
 * Who hears of each order status, and in what words (CONTEXT.md, Notifications). The shop's Owner hears every
 * kind; `staff` adds its Staff, as order and product kinds do (S41). Only the new order is loud (NOT-3).
 */
const rules: Partial<Record<OrderStatus, { kind: NotificationKind; to: "customer" | "shop"; staff?: boolean; loud?: boolean;
  words: (order: Order) => { title: string; body: string } }>> = {
  placed: {
    kind: "order_placed", to: "shop", staff: true, loud: true,
    words: ({ number }) => ({ title: `New order #${number}`, body: `Accept or reject it within ${ORDER_ANSWER_SECONDS / 60} minutes.` }),
  },
  cancelled_by_customer: {
    kind: "order_cancelled_by_customer", to: "shop", staff: true,
    words: ({ number }) => ({ title: `Order #${number} cancelled`, body: "The customer cancelled this order." }),
  },
  accepted: {
    kind: "order_accepted", to: "customer",
    words: ({ number, shopName }) => ({ title: `Order #${number} accepted`, body: `${shopName} is getting your order ready.` }),
  },
  rejected_by_shop: {
    kind: "order_rejected", to: "customer",
    words: ({ number, shopName, reason }) => ({
      title: `Order #${number} rejected`,
      body: `${shopName} could not take your order${reason ? `: ${rejectReasons[reason]}` : ""}.`,
    }),
  },
};

/** The new-order alarm rings again this long after placing, while the order still waits (ORD-2, owner's answer 8 on #55). */
export const RE_RING_SECONDS = 120;

/**
 * Records the notification for an order's move to `to`, with its pushes queued, in the caller's transaction:
 * it lands only with the move it reports (NOT-2).
 */
export async function notifyOrderStatus(client: PoolClient, orderId: string, to: OrderStatus, at: Date, reason: string | null): Promise<void> {
  const rule = rules[to];
  if (!rule) return;
  const { rows: [order] } = await client.query<Order & { accountId: string; shopId: string }>(
    `SELECT o.number, o.account_id AS "accountId", o.shop_id AS "shopId", s.shop_name AS "shopName"
     FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = $1`, [orderId]);
  if (!order) throw new Error("A notified order is missing");
  const { title, body } = rule.words({ ...order, reason: reason as RejectReason | null });
  await client.query(
    `WITH added AS (
       INSERT INTO notifications (account_id, app, kind, title, body, order_id, loud, created_at)
       SELECT account_id, $4, $5, $6, $7, $8, $9, $10 FROM (
         SELECT $1::uuid AS account_id WHERE $4 = 'customer'
         UNION ALL SELECT account_id FROM shop_members WHERE $4 = 'shopkeeper' AND shop_id = $2 AND (role = 'owner' OR $3)) AS recipients
       RETURNING id)
     INSERT INTO push_queue (notification_id, send_after)
     SELECT id, send_after FROM added CROSS JOIN unnest(CASE WHEN $9 THEN ARRAY[$10::timestamptz, $10::timestamptz + make_interval(secs => $11)]
       ELSE ARRAY[$10::timestamptz] END) AS send_after`,
    [order.accountId, order.shopId, rule.staff ?? false, rule.to === "customer" ? "customer" : "shopkeeper", rule.kind, title, body, orderId,
      rule.loud ?? false, at, RE_RING_SECONDS]);
}

/** A phone's push is tried this many times in all, then dropped (NOT-2). */
const MAX_TRIES = 3;
const RETRY_SECONDS = 30;
/**
 * How long a run holds its claimed rows while it calls Expo. A run claims at most `batch` (100) rows, so it makes
 * at most one Expo request per app, each cut off at 10 s; a run that dies leaves its rows to the next after this.
 */
const CLAIM_SECONDS = 60;

/** The kinds a shop's Staff hear of; the Owner hears every kind (S41). */
const staffKinds = Object.values(rules).filter((rule) => rule.to === "shop" && rule.staff).map((rule) => rule.kind);

/**
 * Whether queue row `q` of notification `n` may still go to its token: the token still belongs to a live session of
 * the recipient in that app, a shop recipient is still in the shop in a role that hears this kind, and a new order
 * still waits within its answer time.
 */
const stillDue = `EXISTS (SELECT 1 FROM push_tokens t JOIN sessions s ON s.id = t.session_id
    WHERE t.token = q.token AND t.app = n.app AND s.account_id = n.account_id AND s.expires_at > $1)
  AND (n.app = 'customer' OR EXISTS (SELECT 1 FROM shop_members m WHERE m.account_id = n.account_id AND m.shop_id = o.shop_id
    AND (m.role = 'owner' OR n.kind = ANY($2::text[]))))
  AND NOT (n.kind = 'order_placed' AND (o.status <> 'placed' OR o.placed_at + make_interval(secs => $3) <= $1))`;

type Claimed = { id: string; app: string; push: Push };

/**
 * Takes the pushes due by now, one row per phone, and claims them for this run as `claimId`, counting a try.
 * Notifications not yet fanned out become a row for each phone signed in to the recipient's account in that app;
 * rows no longer due, or out of tries, are dropped. Short, and done before any call to Expo, so no lock is held
 * while Expo answers.
 */
async function claimDuePushes(pool: Pool, now: Date, batch: number, claimId: string): Promise<Claimed[]> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `WITH fresh AS (
         DELETE FROM push_queue WHERE id IN (SELECT id FROM push_queue WHERE token IS NULL AND send_after <= $1
           ORDER BY send_after, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING notification_id, send_after)
       INSERT INTO push_queue (notification_id, token, send_after)
       SELECT f.notification_id, t.token, f.send_after FROM fresh f JOIN notifications n ON n.id = f.notification_id
         JOIN push_tokens t ON t.app = n.app JOIN sessions s ON s.id = t.session_id AND s.account_id = n.account_id AND s.expires_at > $1`,
      [now, batch]);
    const { rows } = await client.query<{ id: string; due: boolean }>(
      `SELECT q.id, q.tries < ${MAX_TRIES} AND ${stillDue} AS due
       FROM push_queue q JOIN notifications n ON n.id = q.notification_id LEFT JOIN orders o ON o.id = n.order_id
       WHERE q.token IS NOT NULL AND q.send_after <= $1 AND (q.claimed_until IS NULL OR q.claimed_until <= $1)
       ORDER BY q.send_after, q.id LIMIT $4 FOR UPDATE OF q SKIP LOCKED`, [now, staffKinds, ORDER_ANSWER_SECONDS, batch]);
    await client.query("DELETE FROM push_queue WHERE id = ANY($1::bigint[])", [rows.filter((row) => !row.due).map((row) => row.id)]);
    const { rows: claimed } = await client.query<Claimed>(
      `UPDATE push_queue q SET tries = q.tries + 1, claim_id = $4, claimed_until = $2::timestamptz + make_interval(secs => $3)
       FROM notifications n WHERE q.id = ANY($1::bigint[]) AND n.id = q.notification_id
       RETURNING q.id, n.app, json_build_object('to', q.token, 'title', n.title, 'body', n.body, 'loud', n.loud,
         'data', json_build_object('notificationId', n.id, 'orderId', n.order_id)) AS push`,
      [rows.filter((row) => row.due).map((row) => row.id), now, CLAIM_SECONDS, claimId]);
    await client.query("COMMIT");
    return claimed;
  });
}

/**
 * Sends the queued pushes due by now, `batch` phones at a time until none is left. Each phone's row is finished only
 * when Expo confirms it: a sent push leaves the queue, a dead token is deleted with its rows, and anything unconfirmed
 * (an error, a missing ticket, no answer) is tried again after 30 s, three tries in all. A run records outcomes only
 * for rows it still holds, so a phone already reached is not sent the push again, except when the outcome itself
 * can't be written: then the claim lapses and the push goes again (at least once, NOT-2). Throws, once outcomes are
 * recorded, when any push failed, so the caller can log it.
 */
export async function sendDuePushes(pool: Pool, sender: PushSender, now: Date, batch = 100): Promise<void> {
  let failures = 0;
  let cause: unknown;
  for (;;) {
    const claimId = randomUUID();
    const claimed = await claimDuePushes(pool, now, batch, claimId);
    const outcome = new Map<string, PushResult>();
    // Expo refuses one request for two apps, as each is its own project.
    for (const app of new Set(claimed.map((row) => row.app))) {
      const mine = claimed.filter((row) => row.app === app);
      const results = await sender.send(mine.map((row) => row.push)).catch((error: unknown): PushResult[] => {
        cause = error;
        return [];
      });
      mine.forEach((row, i) => outcome.set(row.id, results[i] ?? "failed"));
    }
    const ids = (result: PushResult) => claimed.filter((row) => outcome.get(row.id) === result).map((row) => row.id);
    const failed = ids("failed");
    failures += failed.length;
    await withTransaction(pool, async (client) => {
      const held = "id = ANY($1::bigint[]) AND claim_id = $2";
      await client.query(`DELETE FROM push_queue WHERE ${held}`, [ids("sent"), claimId]);
      // A dead token goes with all its queued rows.
      await client.query("DELETE FROM push_tokens WHERE token = ANY($1::text[])",
        [claimed.filter((row) => outcome.get(row.id) === "dead").map((row) => row.push.to)]);
      await client.query(`DELETE FROM push_queue WHERE ${held} AND tries >= $3`, [failed, claimId, MAX_TRIES]);
      await client.query(
        `UPDATE push_queue SET send_after = $3::timestamptz + make_interval(secs => $4), claim_id = NULL, claimed_until = NULL WHERE ${held}`,
        [failed, claimId, now, RETRY_SECONDS]);
      await client.query("COMMIT");
    });
    if (claimed.length < batch) break;
  }
  if (failures > 0) throw new Error(`${failures} pushes could not be sent`, { cause });
}
