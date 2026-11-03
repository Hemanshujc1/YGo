import { type NotificationKind, ORDER_ANSWER_SECONDS, type OrderStatus, type RejectReason } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";
import type { Push, PushSender } from "./adapters/push-sender";
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

/** A push that can't be sent is tried this many times in all, then dropped (NOT-2). */
const MAX_TRIES = 3;
const RETRY_SECONDS = 30;

/**
 * Sends the queued pushes due by now to every phone signed in to the recipient's account in that app. A new order's
 * push is dropped once the order has been answered, cancelled or left past its answer time, and a shop's push once its
 * recipient has left the shop. Rows taken here are locked, so two runs never send one twice. Throws, once the retries
 * are recorded, when any push failed, so the caller can log it.
 */
export async function sendDuePushes(pool: Pool, sender: PushSender, now: Date, batch = 100): Promise<void> {
  await withTransaction(pool, async (client) => {
    type Row = { id: string; tries: number; app: string; loud: boolean; pushes: Array<Omit<Push, "loud">> };
    const { rows } = await client.query<Row>(
      `SELECT q.id, q.tries, n.app, n.loud, COALESCE((SELECT json_agg(json_build_object('to', t.token, 'title', n.title, 'body', n.body,
            'data', json_build_object('notificationId', n.id, 'orderId', n.order_id)) ORDER BY t.token)
          FROM push_tokens t JOIN sessions s ON s.id = t.session_id
          WHERE s.account_id = n.account_id AND t.app = n.app AND s.expires_at > $1
            AND NOT (n.kind = 'order_placed' AND (o.status <> 'placed' OR o.placed_at + make_interval(secs => $3) <= $1))
            AND (n.app = 'customer' OR EXISTS (SELECT 1 FROM shop_members m WHERE m.account_id = n.account_id AND m.shop_id = o.shop_id))), '[]') AS pushes
        FROM push_queue q JOIN notifications n ON n.id = q.notification_id LEFT JOIN orders o ON o.id = n.order_id
        WHERE q.send_after <= $1 ORDER BY q.send_after, q.id LIMIT $2 FOR UPDATE OF q SKIP LOCKED`, [now, batch, ORDER_ANSWER_SECONDS]);
    if (rows.length === 0) return;
    const failedRows: string[] = [];
    const deadTokens: string[] = [];
    // Expo refuses one request for two apps, as each is its own project.
    for (const app of new Set(rows.map((row) => row.app))) {
      const mine = rows.filter((row) => row.app === app);
      const pushes = mine.flatMap((row) => row.pushes.map((push) => ({ ...push, loud: row.loud })));
      const rowOf = mine.flatMap((row) => row.pushes.map(() => row.id));
      if (pushes.length === 0) continue;
      const results = await sender.send(pushes).catch(() => pushes.map(() => "failed" as const));
      pushes.forEach((push, i) => {
        const row = rowOf[i] ?? "";
        if (results[i] === "dead") deadTokens.push(push.to);
        if (results[i] === "failed" && !failedRows.includes(row)) failedRows.push(row);
      });
    }
    const retried = rows.filter((row) => failedRows.includes(row.id) && row.tries + 1 < MAX_TRIES).map((row) => row.id);
    await client.query("DELETE FROM push_queue WHERE id = ANY($1::bigint[]) AND NOT id = ANY($2::bigint[])", [rows.map((row) => row.id), retried]);
    await client.query("UPDATE push_queue SET tries = tries + 1, send_after = $2::timestamptz + make_interval(secs => $3) WHERE id = ANY($1::bigint[])",
      [retried, now, RETRY_SECONDS]);
    await client.query("DELETE FROM push_tokens WHERE token = ANY($1::text[])", [deadTokens]);
    await client.query("COMMIT");
    if (failedRows.length > 0) throw new Error(`${failedRows.length} queued pushes could not be sent`);
  });
}
