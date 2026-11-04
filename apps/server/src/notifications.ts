import { type NotificationKind, ORDER_ANSWER_SECONDS, type OrderStatus, type RejectReason } from "@ygo/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Push, PushResult, PushSender, ReceiptResult } from "./adapters/push-sender";
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
/** The safety-net floor push goes this long after an unacknowledged ring push (#508). */
export const FLOOR_SECONDS = 15;

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
/** Expo needs a few minutes to have a receipt (#509); one still missing is asked for again this much later. */
const RECEIPT_AFTER_SECONDS = 15 * 60;
/** Expo keeps a receipt for 24 hours; after that the ticket is dropped. */
const RECEIPT_KEPT_SECONDS = 24 * 60 * 60;
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
 * still waits within its answer time. An acknowledged ring attempt drops its floor push (#508).
 */
const stillDue = `EXISTS (SELECT 1 FROM push_tokens t JOIN sessions s ON s.id = t.session_id
    WHERE t.token = q.token AND t.app = n.app AND s.account_id = n.account_id AND s.expires_at > $1)
  AND (n.app = 'customer' OR EXISTS (SELECT 1 FROM shop_members m WHERE m.account_id = n.account_id AND m.shop_id = o.shop_id
    AND (m.role = 'owner' OR n.kind = ANY($2::text[]))))
  AND NOT (n.kind = 'order_placed' AND (o.status <> 'placed' OR o.placed_at + make_interval(secs => $3) <= $1))
  AND NOT (q.floor AND EXISTS (SELECT 1 FROM ring_attempts a WHERE a.id = q.ring_attempt_id AND a.acknowledged_at IS NOT NULL))`;

type Claimed = { id: string; app: string; push: Push };

/**
 * Takes the pushes due by now, one row per phone, and claims them for this run as `claimId`, counting a try.
 * Notifications not yet fanned out become a row for each phone signed in to the recipient's account in that app;
 * Android phones receiving a new-order alarm get a ring attempt and a 15 s floor push (#508).
 * Rows no longer due, or out of tries, are dropped. Short, and done before any call to Expo, so no lock is held
 * while Expo answers.
 */
async function claimDuePushes(pool: Pool, now: Date, batch: number, claimId: string): Promise<Claimed[]> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `WITH fresh AS (
         DELETE FROM push_queue WHERE id IN (SELECT id FROM push_queue WHERE token IS NULL AND send_after <= $1
           ORDER BY send_after, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING notification_id, send_after),
       candidates AS (
         SELECT f.notification_id, f.send_after, n.order_id, n.kind, t.token, t.platform
         FROM fresh f
         JOIN notifications n ON n.id = f.notification_id
         JOIN push_tokens t ON t.app = n.app
         JOIN sessions s ON s.id = t.session_id AND s.account_id = n.account_id AND s.expires_at > $1),
       android_rings AS (
         INSERT INTO ring_attempts (order_id, attempt, token, created_at)
         SELECT c.order_id, CASE WHEN c.send_after = n.created_at THEN 1 ELSE 2 END, c.token, $1
         FROM candidates c
         JOIN notifications n ON n.id = c.notification_id
         WHERE c.platform = 'android' AND c.kind = 'order_placed' AND c.order_id IS NOT NULL
         RETURNING id AS ring_attempt_id, order_id, token),
       android_pushes AS (
         SELECT c.notification_id, c.token,
           unnest(ARRAY[c.send_after, c.send_after + make_interval(secs => $3)]) AS send_after,
           r.ring_attempt_id,
           unnest(ARRAY[false, true]) AS floor
         FROM candidates c
         JOIN android_rings r ON r.order_id = c.order_id AND r.token = c.token
         WHERE c.platform = 'android' AND c.kind = 'order_placed'),
       standard_pushes AS (
         SELECT c.notification_id, c.token, c.send_after, NULL::uuid AS ring_attempt_id, false AS floor
         FROM candidates c
         WHERE c.platform IS DISTINCT FROM 'android' OR c.kind <> 'order_placed')
       INSERT INTO push_queue (notification_id, token, send_after, ring_attempt_id, floor)
       SELECT notification_id, token, send_after, ring_attempt_id, floor FROM android_pushes
       UNION ALL
       SELECT notification_id, token, send_after, ring_attempt_id, floor FROM standard_pushes`,
      [now, batch, FLOOR_SECONDS]);
    const { rows } = await client.query<{ id: string; due: boolean }>(
      `SELECT q.id, q.tries < ${MAX_TRIES} AND ${stillDue} AS due
       FROM push_queue q JOIN notifications n ON n.id = q.notification_id LEFT JOIN orders o ON o.id = n.order_id
       WHERE q.token IS NOT NULL AND q.send_after <= $1 AND (q.claimed_until IS NULL OR q.claimed_until <= $1)
       ORDER BY q.send_after, q.id LIMIT $4 FOR UPDATE OF q SKIP LOCKED`, [now, staffKinds, ORDER_ANSWER_SECONDS, batch]);
    await client.query("DELETE FROM push_queue WHERE id = ANY($1::bigint[])", [rows.filter((row) => !row.due).map((row) => row.id)]);
    const { rows: claimed } = await client.query<Claimed>(
      `UPDATE push_queue q SET tries = q.tries + 1, claim_id = $4, claimed_until = $2::timestamptz + make_interval(secs => $3)
       FROM notifications n WHERE q.id = ANY($1::bigint[]) AND n.id = q.notification_id
       RETURNING q.id, n.app,
         CASE
           WHEN q.ring_attempt_id IS NOT NULL AND NOT q.floor THEN
             json_build_object('to', q.token, 'loud', true, 'tag', 'order-' || n.order_id::text,
               'data', json_build_object('notificationId', n.id, 'orderId', n.order_id, 'ringAttemptId', q.ring_attempt_id, 'kind', n.kind, 'loud', true))
           WHEN q.ring_attempt_id IS NOT NULL AND q.floor THEN
             json_build_object('to', q.token, 'title', n.title, 'body', n.body, 'loud', n.loud, 'tag', 'order-' || n.order_id::text,
               'data', json_build_object('notificationId', n.id, 'orderId', n.order_id, 'ringAttemptId', q.ring_attempt_id, 'floor', true))
           ELSE
             json_build_object('to', q.token, 'title', n.title, 'body', n.body, 'loud', n.loud, 'tag', 'order-' || n.order_id::text,
               'data', json_build_object('notificationId', n.id, 'orderId', n.order_id))
         END AS push`,
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
    const ticketed = claimed.flatMap((row) => {
      const result = outcome.get(row.id);
      return typeof result === "object" ? [{ id: row.id, ticketId: result.ticketId, token: row.push.to, app: row.app }] : [];
    });
    const failed = ids("failed");
    failures += failed.length;
    await withTransaction(pool, async (client) => {
      const held = "id = ANY($1::bigint[]) AND claim_id = $2";
      // A sent push leaves the queue, and its ticket is kept for the receipt, for the rows this run still holds only.
      await client.query(
        `WITH done AS (DELETE FROM push_queue WHERE ${held} RETURNING id),
           ticketed AS (SELECT * FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[]) AS t(id, ticket_id, token, app))
         INSERT INTO push_receipts (ticket_id, token, app, sent_at, check_after)
         SELECT ticket_id, token, app, $7::timestamptz, $7::timestamptz + make_interval(secs => $8) FROM ticketed JOIN done USING (id)
         ON CONFLICT DO NOTHING`,
        [[...ids("sent"), ...ticketed.map((row) => row.id)], claimId, ticketed.map((row) => row.id), ticketed.map((row) => row.ticketId),
          ticketed.map((row) => row.token), ticketed.map((row) => row.app), now, RECEIPT_AFTER_SECONDS]);
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

/**
 * Reads the receipts due by now and deletes the token of each phone Expo says no longer holds it (#509), up to `batch`
 * tickets a run in all (Expo's limit is 1000 ids a request). Like the sending, a run claims its tickets, calls Expo outside
 * any transaction and records outcomes only for tickets it still holds, so a ticket is acted on once even with two
 * workers. A token goes only if its phone did not register it again after the send, decided in the same statement
 * that takes the ticket, so a reinstalled phone keeps its token. An "ok" or other receipt just ends the ticket; a missing
 * one is asked for again after 15 minutes, and dropped once asked for after 24 hours from the send. The tickets of a failed
 * request go back at once, to be asked for on the next pass. Throws, once outcomes are recorded, when any request failed, so
 * the caller can log it.
 */
export async function checkPushReceipts(pool: Pool, sender: PushSender, now: Date, batch = 1000): Promise<void> {
  const claimId = randomUUID();
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ ticketId: string; app: string }>(
      `UPDATE push_receipts SET claim_id = $4, claimed_until = $1::timestamptz + make_interval(secs => $3)
       WHERE ticket_id IN (SELECT ticket_id FROM push_receipts WHERE check_after <= $1 AND (claimed_until IS NULL OR claimed_until <= $1)
         ORDER BY check_after, ticket_id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING ticket_id AS "ticketId", app`, [now, batch, CLAIM_SECONDS, claimId]);
    await client.query("COMMIT");
    return rows;
  });
  const found = new Map<string, ReceiptResult | "failed">();
  let cause: unknown;
  // Expo's projects are separate, so each app asks on its own.
  for (const app of new Set(claimed.map((row) => row.app))) {
    const asked = claimed.filter((row) => row.app === app).map((row) => row.ticketId);
    const answer = await sender.receipts(asked).catch((error: unknown) => {
      cause = error;
      return new Map(asked.map((id) => [id, "failed" as const]));
    });
    answer.forEach((result, ticketId) => found.set(ticketId, result));
  }
  const withResult = (result: ReceiptResult) => claimed.filter((row) => found.get(row.ticketId) === result).map((row) => row.ticketId);
  const missing = claimed.filter((row) => !found.has(row.ticketId)).map((row) => row.ticketId);
  const failed = claimed.filter((row) => found.get(row.ticketId) === "failed").map((row) => row.ticketId);
  await withTransaction(pool, async (client) => {
    // One statement takes the held tickets and judges the token against the same rows.
    await client.query(
      `WITH held AS (DELETE FROM push_receipts WHERE ticket_id = ANY($1::text[]) AND claim_id = $2 RETURNING ticket_id, token, sent_at)
       DELETE FROM push_tokens t USING held h WHERE h.ticket_id = ANY($3::text[]) AND t.token = h.token AND t.updated_at < h.sent_at`,
      [[...withResult("ok"), ...withResult("dead"), ...withResult("other")], claimId, withResult("dead")]);
    await client.query("DELETE FROM push_receipts WHERE ticket_id = ANY($1::text[]) AND claim_id = $2 AND sent_at + make_interval(secs => $3) <= $4",
      [missing, claimId, RECEIPT_KEPT_SECONDS, now]);
    await client.query(
      "UPDATE push_receipts SET check_after = $3::timestamptz + make_interval(secs => $4), claim_id = NULL, claimed_until = NULL WHERE ticket_id = ANY($1::text[]) AND claim_id = $2",
      [missing, claimId, now, RECEIPT_AFTER_SECONDS]);
    // A failed request says nothing of its receipts: its claim is let go, so the next pass asks again.
    await client.query("UPDATE push_receipts SET claim_id = NULL, claimed_until = NULL WHERE ticket_id = ANY($1::text[]) AND claim_id = $2", [failed, claimId]);
    await client.query("COMMIT");
  });
  // Counts only, so no push token reaches the log.
  if (failed.length > 0) throw new Error(`${failed.length} push receipts could not be read`, { cause });
}
