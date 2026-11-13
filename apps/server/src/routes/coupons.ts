import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  AdminCouponBody, CouponParams, CouponResponse, CouponsResponse, ErrorEnvelope, OwnerCouponBody, type AdminCouponBody as AdminCouponInput, type OwnerCouponBody as OwnerCouponInput,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { couponAboveMaximum, couponSql, couponView, couponsWithUse, recordCouponVersion, RELEASING_STATUSES, type CouponRow } from "../coupons";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { maximumDiscountPercentage } from "../shop-discounts";

type Terms = (AdminCouponInput | OwnerCouponInput) & { funding?: "platform" | "shop"; shopId?: string };

/**
 * Coupons (CRT-3, ADM-5, #70). Admin manages every coupon, naming the funding and, for a shop-funded one, the shop. An Owner manages only the shop-funded coupons of
 * their own shop: a coupon of another shop, or a platform-funded one, is 404 to them, and Staff get 403. Every save keeps a new version (MNY-6), checks a shop-funded
 * coupon against the shop's maximum effective percentage on the form's worst case (D-12), and keeps its code unique whatever the case, in the database.
 */
export function registerCouponRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  const used = async (client: Pool | PoolClient, row: CouponRow) => (await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM coupon_uses u JOIN orders o ON o.id = u.order_id WHERE u.coupon_id = $1 AND o.status <> ALL($2::text[])", [row.id, RELEASING_STATUSES])).rows[0]?.n ?? 0;
  const read = async (client: Pool | PoolClient, id: string) => (await client.query<CouponRow>(`SELECT ${couponSql("c")} FROM coupons c WHERE c.id = $1`, [id])).rows[0];

  // The one save, for a new coupon (`id` null) or a change. Answers the saved row, or the reply it refused with.
  const save = async (client: PoolClient, reply: FastifyReply, id: string | null, terms: Terms, actorId: string): Promise<CouponRow | FastifyReply> => {
    const funding = terms.funding ?? "shop";
    const shopId = funding === "shop" ? terms.shopId ?? null : null;
    const percentage = terms.form === "percentage" ? terms.percentage : null;
    const cap = terms.form === "percentage" ? terms.cap : null;
    const amount = terms.form === "flat" ? terms.amount : null;
    // A shop-funded flat coupon needs a minimum order, so its worst case can be held to the maximum (D-12).
    if (funding === "shop" && terms.form === "flat" && terms.minimumOrder === null) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["minimumOrder"] } });
    if (shopId && !(await client.query("SELECT 1 FROM shops WHERE id = $1", [shopId])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const unknown = async (table: "areas" | "categories", ids: string[]) => ids.length > 0
      && (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).rows[0]?.n !== new Set(ids).size;
    if (await unknown("areas", terms.areaIds)) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["areaIds"] } });
    if (await unknown("categories", terms.categoryIds)) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["categoryIds"] } });
    // A rate-card publish holds the first lock while it works out which coupons it pauses, so this save reads the maximum after it, or the publish pauses it after:
    // a coupon over the maximum is never left active. The second keeps one coupon's saves in turn (#63).
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('rate_card.publish'))");
    if (id) await client.query("SELECT pg_advisory_xact_lock(hashtext('coupon'), hashtext($1))", [id]);
    const { above, maximum } = await couponAboveMaximum(client, { funding, shopId, form: terms.form, percentage, amount, minimumOrder: terms.minimumOrder });
    if (above) return reply.code(400).send({ error: { code: "COUPON_ABOVE_MAXIMUM", maximumPercentage: maximum ?? undefined } });
    const now = clock.now();
    const status = terms.active ? "active" : "off";
    const values = [terms.code, funding, shopId, terms.form, percentage, cap, amount, terms.minimumOrder, status, terms.startsAt, terms.expiresAt, terms.usageLimit,
      terms.perCustomerLimit, terms.firstOrderOnly, terms.areaIds, terms.categoryIds];
    try {
      if (!id) {
        const { rows: [created] } = await client.query<{ id: string }>(
          `INSERT INTO coupons (version, code, funding, shop_id, form, percentage, cap, flat_amount, minimum_order, status, starts_at, expires_at, usage_limit, per_customer_limit,
              first_order_only, area_ids, category_ids, updated_at)
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`, [...values, now]);
        if (!created) throw new Error("A saved coupon returned no row");
        id = created.id;
        await recordCouponVersion(client, id, actorId, now);
      } else {
        const { rows: [current] } = await client.query<{ same: boolean }>(
          `SELECT code = $1 AND funding = $2 AND shop_id IS NOT DISTINCT FROM $3::uuid AND form = $4 AND percentage IS NOT DISTINCT FROM $5::numeric AND cap IS NOT DISTINCT FROM $6::numeric
              AND flat_amount IS NOT DISTINCT FROM $7::numeric AND minimum_order IS NOT DISTINCT FROM $8::numeric AND status = $9 AND starts_at IS NOT DISTINCT FROM $10::timestamptz
              AND expires_at = $11::timestamptz AND usage_limit IS NOT DISTINCT FROM $12::int AND per_customer_limit = $13 AND first_order_only = $14
              AND area_ids = $15::uuid[] AND category_ids = $16::uuid[] AS same FROM coupons WHERE id = $17 FOR UPDATE`, [...values, id]);
        if (!current) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        if (!current.same) {
          await client.query(
            `UPDATE coupons SET version = version + 1, code = $1, funding = $2, shop_id = $3, form = $4, percentage = $5, cap = $6, flat_amount = $7, minimum_order = $8, status = $9,
                starts_at = $10, expires_at = $11, usage_limit = $12, per_customer_limit = $13, first_order_only = $14, area_ids = $15, category_ids = $16, updated_at = $17 WHERE id = $18`,
            [...values, now, id]);
          await recordCouponVersion(client, id, actorId, now);
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "COUPON_CODE_TAKEN" } });
      throw error;
    }
    const saved = await read(client, id);
    if (!saved) throw new Error("A saved coupon disappeared");
    return saved;
  };
  const answer = async (client: Pool | PoolClient, reply: FastifyReply, row: CouponRow | FastifyReply, created: boolean) =>
    "code" in row && "funding" in row ? reply.code(created ? 201 : 200).send({ coupon: couponView(row, await used(client, row)) }) : row;

  // ADM-5: Admin's coupons, every funding.
  app.get("/v1/admin/coupons", { schema: { response: { 200: CouponsResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    return { coupons: await couponsWithUse(pool, null), maximumPercentage: null };
  });
  app.post("/v1/admin/coupons", { schema: { body: AdminCouponBody, response: { 201: CouponResponse, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const row = await save(client, reply, null, request.body as AdminCouponInput, who.accountId);
      if ("statusCode" in row) return row;
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'coupon.create', $2, 'coupon', 'Coupon created')", [who.accountId, row.id]);
      await client.query("COMMIT");
      return answer(client, reply, row, true);
    });
  });
  app.put("/v1/admin/coupons/:id", { schema: { params: CouponParams, body: AdminCouponBody, response: { 200: CouponResponse, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as CouponParams;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const row = await save(client, reply, id, request.body as AdminCouponInput, who.accountId);
      if ("statusCode" in row) return row;
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'coupon.update', $2, 'coupon', 'Coupon updated')", [who.accountId, row.id]);
      await client.query("COMMIT");
      return answer(client, reply, row, false);
    });
  });

  // S45 (#77) will show these: the Owner's own shop's coupons, nothing else.
  const owner = async (client: Pool | PoolClient, accountId: string) => (await client.query<{ shopId: string; role: string; state: string }>(
    "SELECT s.id AS \"shopId\", m.role, s.state FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.account_id = $1", [accountId])).rows[0];
  app.get("/v1/me/coupons", { schema: { response: { 200: CouponsResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await owner(pool, who.accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return { coupons: await couponsWithUse(pool, shop.shopId), maximumPercentage: await maximumDiscountPercentage(pool, shop.shopId) };
  });
  const ownerSave = async (request: { body: unknown }, reply: FastifyReply, accountId: string, id: string | null) => withTransaction(pool, async (client) => {
    const shop = await owner(client, accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
    // The shop is the Owner's own, never the body's, and a coupon is theirs only if their shop pays for it.
    if (id && !(await client.query("SELECT 1 FROM coupons WHERE id = $1 AND shop_id = $2 AND funding = 'shop'", [id, shop.shopId])).rowCount) {
      return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    }
    const row = await save(client, reply, id, { ...(request.body as OwnerCouponInput), funding: "shop", shopId: shop.shopId }, accountId);
    if ("statusCode" in row) return row;
    await client.query("COMMIT");
    return answer(client, reply, row, id === null);
  });
  app.post("/v1/me/coupons", { schema: { body: OwnerCouponBody, response: { 201: CouponResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    return who ? ownerSave(request, reply, who.accountId, null) : reply;
  });
  app.put("/v1/me/coupons/:id", { schema: { params: CouponParams, body: OwnerCouponBody, response: { 200: CouponResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    return who ? ownerSave(request, reply, who.accountId, (request.params as CouponParams).id) : reply;
  });
}
