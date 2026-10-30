import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ErrorEnvelope, ORDER_ANSWER_SECONDS, OrderParams, type OrderStatus, RejectOrderBody, ShopOrderResponse, type ShopOrderSummary,
  ShopOrdersResponse, type ShortLine, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { stockOf } from "../listings";
import { moveOrder } from "../orders";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { answerExpired, frozenOrder } from "./orders";

const answerMs = ORDER_ANSWER_SECONDS * 1000;

/** Until when the shop can answer, while the order still waits for it. */
const expiresAt = (status: OrderStatus, placedAt: Date) => status === "placed" ? new Date(placedAt.getTime() + answerMs).toISOString() : null;

/** S05: one order of the shop the account is Owner or Staff of, whether or not the shop is Live now (owner's answer 13 on #425). */
async function shopOrderView(client: Pool | PoolClient, orderId: string, accountId: string, now: Date): Promise<ShopOrderResponse | undefined> {
  const { rows: [row] } = await client.query<Omit<ShopOrderResponse, "placedAt" | "expiresAt" | "now"> & { placedAt: Date }>(
    `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", ${frozenOrder("o")}
      FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
      WHERE o.id = $1 AND m.account_id = $2`, [orderId, accountId]);
  return row && { ...row, placedAt: row.placedAt.toISOString(), expiresAt: expiresAt(row.status, row.placedAt), now: now.toISOString() };
}

export function registerShopOrderRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  // S04: the shop's orders in three groups (owner's answers 5 and 8 on #425).
  app.get("/v1/me/shop-orders", { schema: { response: { 200: ShopOrdersResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [member] } = await pool.query<{ shopId: string }>('SELECT shop_id AS "shopId" FROM shop_members WHERE account_id = $1', [who.accountId]);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const now = clock.now();
    type Row = Omit<ShopOrderSummary, "placedAt" | "expiresAt"> & { placedAt: Date };
    // A placed order past its time is in no group until #57 moves it to Expired, so no Accept shows that can't work.
    const { rows } = await pool.query<Row>(
      `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", o.total::text AS total,
          (SELECT count(*)::int FROM order_lines l WHERE l.order_id = o.id) AS "itemCount",
          json_build_object('flat', o.address_flat, 'areaLine', o.address_area_line) AS address
        FROM orders o
        WHERE o.shop_id = $1 AND (
          (o.status = 'placed' AND NOT ${answerExpired("o", "$2")})
          OR o.status = ANY($3::text[])
          OR (o.status = ANY($4::text[]) AND (o.status_changed_at AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date))
        ORDER BY CASE WHEN o.status = ANY($4::text[]) THEN -extract(epoch FROM o.status_changed_at) ELSE extract(epoch FROM o.placed_at) END`,
      [member.shopId, now, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES]);
    const summary = (row: Row): ShopOrderSummary => ({ ...row, placedAt: row.placedAt.toISOString(), expiresAt: expiresAt(row.status, row.placedAt) });
    return {
      now: now.toISOString(),
      new: rows.filter((row) => row.status === "placed").map(summary),
      accepted: rows.filter((row) => STOCK_HOLDING_ORDER_STATUSES.includes(row.status)).map(summary),
      doneToday: rows.filter((row) => TERMINAL_ORDER_STATUSES.includes(row.status)).map(summary),
    };
  });

  app.get("/v1/me/shop-orders/:id", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const order = await shopOrderView(pool, (request.params as OrderParams).id, who.accountId, clock.now());
    return order ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  /**
   * Accept or Reject on S05, in one transaction: the order is locked first, then (for Accept) its listings
   * in id order, so two Accepts for the last stock take turns and the second sees the first's hold.
   */
  const answer = (to: "accepted" | "rejected_by_shop") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const reason = to === "rejected_by_shop" ? (request.body as RejectOrderBody).reason : null;
    type Outcome = { code: "NOT_FOUND" | "ORDER_STATUS_CHANGED" | "ORDER_EXPIRED" } | { code: "NOT_ENOUGH_STOCK"; shortLines: ShortLine[] } | { now: Date };
    const outcome = await withTransaction(pool, async (client): Promise<Outcome> => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; placedAt: Date; role: "owner" | "staff" }>(
        `SELECT o.id, o.status, o.placed_at AS "placedAt", m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return { code: "NOT_FOUND" };
      if (order.status !== "placed") return { code: "ORDER_STATUS_CHANGED" };
      // Read after the lock, so a wait on it can't stamp an earlier time.
      const now = clock.now();
      if (now.getTime() >= order.placedAt.getTime() + answerMs) return { code: "ORDER_EXPIRED" };
      if (to === "accepted") {
        // A listing switched off or repriced since placement doesn't block Accept: the order keeps its price (answer 14).
        // NO KEY UPDATE queues behind placement's FOR SHARE and other Accepts, but not behind cart saves' key checks.
        await client.query("SELECT 1 FROM shop_listings WHERE id IN (SELECT listing_id FROM order_lines WHERE order_id = $1) ORDER BY id FOR NO KEY UPDATE", [id]);
        const { rows: shortLines } = await client.query<ShortLine>(
          `SELECT l.name, l.brand, l.base_unit AS "baseUnit", trim_scale(l.pack_quantity)::text AS quantity, l.count,
              trim_scale(l.part_quantity)::text AS part, trim_scale(GREATEST(stock.left, 0))::text AS available
            FROM order_lines l JOIN shop_listings listing ON listing.id = l.listing_id
            CROSS JOIN LATERAL (SELECT ${stockOf("listing")} AS left) stock
            WHERE l.order_id = $1 AND stock.left < l.stock_quantity
            ORDER BY l.position`, [id]);
        // A cart holds one line per listing, so each line is checked against its listing's stock alone.
        if (shortLines.length > 0) return { code: "NOT_ENOUGH_STOCK", shortLines };
      }
      if (!await moveOrder(client, order, to, { id: who.accountId, role: order.role }, now, reason)) return { code: "ORDER_STATUS_CHANGED" };
      await client.query("COMMIT");
      return { now };
    });
    if (!("now" in outcome)) return reply.code(outcome.code === "NOT_FOUND" ? 404 : 409).send({ error: outcome });
    return shopOrderView(pool, id, who.accountId, outcome.now);
  };

  app.post("/v1/me/shop-orders/:id/accept", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, answer("accepted"));
  app.post("/v1/me/shop-orders/:id/reject", { schema: { params: OrderParams, body: RejectOrderBody, response: { 200: ShopOrderResponse, ...errors } } },
    answer("rejected_by_shop"));
}
