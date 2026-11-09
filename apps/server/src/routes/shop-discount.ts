import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { ErrorEnvelope, ShopDiscountBody, ShopDiscountResponse, type ShopDiscountRule } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { exceedsMaximum, maximumDiscountPercentage, recordVersion } from "../shop-discounts";
import { deriveKeys, mobileSignedIn } from "../tokens";

/**
 * S34, the Owner's shop-wide discount (MNY-5, CRT-3, #63): one rule per shop, read and saved by the Owner only. Staff get 403 and an
 * account with no shop 404. Every save keeps a new version, so an order can name the exact terms it was priced under (MNY-6).
 */
export function registerShopDiscountRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 200: ShopDiscountResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const member = async (client: Pool | PoolClient, accountId: string) => (await client.query<{ shopId: string; role: string; state: string }>(
    "SELECT s.id AS \"shopId\", m.role, s.state FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.account_id = $1", [accountId])).rows[0];
  const read = async (client: Pool | PoolClient, shopId: string): Promise<ShopDiscountResponse> => {
    const { rows: [rule] } = await client.query<ShopDiscountRule>(
      `SELECT id, version, form, trim_scale(percentage)::text AS percentage, trim_scale(cap)::text AS cap, trim_scale(flat_amount)::text AS amount,
          trim_scale(minimum_order)::text AS "minimumOrder", status FROM shop_discounts WHERE shop_id = $1`, [shopId]);
    return { rule: rule ?? null, maximumPercentage: await maximumDiscountPercentage(client, shopId) };
  };

  app.get("/v1/me/shop-discount", { schema: { response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await member(pool, who.accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return read(pool, shop.shopId);
  });

  app.put("/v1/me/shop-discount", { schema: { body: ShopDiscountBody, response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as ShopDiscountBody;
    const terms = body.form === "percentage"
      ? { percentage: body.percentage, cap: body.cap, amount: null, minimumOrder: null }
      : { percentage: null, cap: null, amount: body.amount, minimumOrder: body.minimumOrder };
    const status = body.active ? "active" : "off";
    return withTransaction(pool, async (client) => {
      const shop = await member(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
      // A rate-card publish holds the first lock for as long as it works out which rules it pauses, so this save reads the maximum
      // after it, or the publish pauses this rule after it: a rule over the maximum is never left active. The second keeps one shop's saves in turn.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('rate_card.publish'))");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('shop_discount'), hashtext($1))", [shop.shopId]);
      const maximum = await maximumDiscountPercentage(client, shop.shopId);
      if (await exceedsMaximum(client, { form: body.form, ...terms }, maximum)) {
        return reply.code(400).send({ error: { code: "DISCOUNT_ABOVE_MAXIMUM", maximumPercentage: maximum } });
      }
      const now = clock.now();
      const values = [shop.shopId, body.form, terms.percentage, terms.cap, terms.amount, terms.minimumOrder, status, now];
      const { rows: [current] } = await client.query<{ id: string; same: boolean }>(
        `SELECT id, form = $2 AND percentage IS NOT DISTINCT FROM $3::numeric AND cap IS NOT DISTINCT FROM $4::numeric AND flat_amount IS NOT DISTINCT FROM $5::numeric
            AND minimum_order IS NOT DISTINCT FROM $6::numeric AND status = $7 AS same
          FROM shop_discounts WHERE shop_id = $1 FOR UPDATE`, values.slice(0, 7));
      if (!current) {
        const { rows: [created] } = await client.query<{ id: string }>(
          `INSERT INTO shop_discounts (shop_id, version, form, percentage, cap, flat_amount, minimum_order, status, updated_at)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, values);
        if (!created) throw new Error("A saved discount returned no row");
        await recordVersion(client, created.id, who.accountId, now);
      } else if (!current.same) {
        await client.query(
          `UPDATE shop_discounts SET version = version + 1, form = $2, percentage = $3, cap = $4, flat_amount = $5, minimum_order = $6, status = $7, updated_at = $8
            WHERE id = $1`, [current.id, ...values.slice(1)]);
        await recordVersion(client, current.id, who.accountId, now);
      }
      const saved = await read(client, shop.shopId);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });
}
