import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { CounterBillParams, ErrorEnvelope, ShopCounterBill, ShopCounterBillsResponse, VoidCounterBillBody } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { largestQuantity } from "../counter-bills";
import { withTransaction } from "../db";
import { stockOf } from "../listings";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** How far back S37 lists the shop's bills (owner's answer 9 on #54), and never less than the void window. */
const listedMs = (voidSeconds: number) => Math.max(2 * 86400_000, voidSeconds * 1000);

const iso = (column: string) => `to_char((${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// $2 is the server's clock and $3 the void window in seconds; the phone's clock never decides (owner's answers 3 and 4 on #54).
// The window starts at numbered_at: on arrival, or when Admin numbered a held bill (#497), both on the server's
// clock. A held bill has neither, so no window yet.
// Only a Live or Suspended shop voids, as only it bills (ONB-7, owner's answer 8).
const voidUntil = "b.numbered_at + make_interval(secs => $3)";
const billsSql = (extra = "") => `SELECT ${extra}b.id, b.reference, b.number, b.total::text AS total, b.payment, ${iso("b.made_at")} AS "madeAt", ${iso("b.received_at")} AS "receivedAt",
    CASE WHEN b.numbered_at IS NULL THEN NULL ELSE ${iso(voidUntil)} END AS "voidUntil",
    (s.state IN ('live', 'suspended') AND b.numbered_at IS NOT NULL AND v.id IS NULL AND $2::timestamptz < ${voidUntil}) AS voidable,
    CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object('reason', v.reason, 'note', v.note, 'createdAt', ${iso("v.created_at")}) END AS voided
  FROM counter_bills b JOIN shops s ON s.id = b.shop_id LEFT JOIN counter_bill_voids v ON v.bill_id = b.id
  WHERE b.shop_id = $1`;

type Member = { shopId: string; state: string; role: "owner" | "staff" };

/**
 * S37 Void a bill (#54, BIL-6). The list is any member's; the void is the Owner's, online only, in one
 * transaction that holds the shop's row lock, the lock a sync batch and Admin's numbering also take, so two voids
 * of one bill, or a void beside its numbering, run one after the other.
 */
export function registerShopCounterBillRoutes(app: FastifyInstance, { pool, clock, secret, voidSeconds }: { pool: Pool; clock: Clock; secret: string; voidSeconds: number }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const member = (client: Pool | PoolClient, accountId: string, lock: string) => client.query<Member>(`SELECT s.id AS "shopId", s.state, m.role FROM shops s
    JOIN shop_members m ON m.shop_id = s.id WHERE m.account_id = $1 AND m.role IN ('owner', 'staff') ${lock}`, [accountId]);

  // The shop's bills received or numbered in the last 2 days (or the void window, if longer), held and unreadable
  // ones included, newest first. A bill Admin just numbered sorts by that time, so the Owner sees it while it can be voided.
  app.get("/v1/me/counter-bills", { schema: { response: { 200: ShopCounterBillsResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [shop] } = await member(pool, who.accountId, "");
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const now = clock.now();
    const { rows } = await pool.query<ShopCounterBill>(`${billsSql()} AND COALESCE(b.numbered_at, b.received_at) > $4 ORDER BY COALESCE(b.numbered_at, b.received_at) DESC, b.id`,
      [shop.shopId, now, voidSeconds, new Date(now.getTime() - listedMs(voidSeconds))]);
    return { bills: rows };
  });

  app.post("/v1/me/counter-bills/:id/void", { schema: { params: CounterBillParams, body: VoidCounterBillBody, response: { 201: ShopCounterBill, 400: ErrorEnvelope, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as CounterBillParams;
    const body = request.body as VoidCounterBillBody;
    return withTransaction(pool, async (client) => {
      const { rows: [shop] } = await member(client, who.accountId, "FOR UPDATE OF s");
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      // Billing's own rule: refused before Live and once Closed, while Suspended still bills (ONB-7).
      if (shop.state !== "live" && shop.state !== "suspended") return reply.code(409).send({ error: { code: "SHOP_NOT_BILLING" } });
      // Read after the lock, on the server's clock, so a void can't slip past its window or past another void.
      const now = clock.now();
      const { rows: [bill] } = await client.query<ShopCounterBill & { clientId: string; actorId: string }>(`${billsSql('b.client_id AS "clientId", b.actor_id AS "actorId", ')} AND b.id = $4 FOR UPDATE OF b`,
        [shop.shopId, now, voidSeconds, id]);
      if (!bill) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (bill.voided) return reply.code(409).send({ error: { code: "COUNTER_BILL_VOIDED" } });
      if (!bill.voidable) return reply.code(409).send({ error: { code: "COUNTER_BILL_NOT_VOIDABLE" } });

      // The bill's sale movements: one per listing at most (the table keeps client_id unique per listing), written
      // with the bill's own client_id and actor, by sync or by Admin's numbering. None for a bill that moved no stock.
      const sales = `FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id
        WHERE sl.shop_id = $1 AND sm.client_id = $2 AND sm.actor_id = $3 AND sm.kind = 'sale'`;
      // Stock given back must stay within what Stock can show, as a sale's must (#471); otherwise every pull would fail.
      if ((await client.query(`SELECT 1 ${sales} AND ${stockOf("sl")} - sm.quantity > ${largestQuantity}`, [shop.shopId, bill.clientId, bill.actorId])).rowCount) {
        return reply.code(409).send({ error: { code: "COUNTER_BILL_NOT_VOIDABLE" } });
      }
      const note = body.reason === "other" ? body.note : null;
      // Give back exactly what the sales took, in new movements that share the void's id, so one void can't
      // return stock twice. A pack taken off the list since still gets its stock back.
      const voidId = randomUUID();
      const moved = await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity, created_at)
        SELECT sm.listing_id, $4, $5, 'void', -sm.quantity, $6 ${sales}`, [shop.shopId, bill.clientId, bill.actorId, who.accountId, voidId, now]);
      // The unique index on the bill keeps a second void out even if the checks above were ever bypassed.
      await client.query(`INSERT INTO counter_bill_voids (id, bill_id, actor_id, reason, note, stock_moved, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [voidId, id, who.accountId, body.reason, note, (moved.rowCount ?? 0) > 0, now]);
      const { rows: [saved] } = await client.query<ShopCounterBill>(`${billsSql()} AND b.id = $4`, [shop.shopId, now, voidSeconds, id]);
      await client.query("COMMIT");
      return reply.code(201).send(saved);
    });
  });
}
