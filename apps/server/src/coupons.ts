import type { Pool, PoolClient } from "pg";
import type { Coupon, CouponReason } from "@ygo/contracts";
import { notifyShopOwner } from "./notifications";
import { exceedsMaximum, maximumDiscountPercentage } from "./shop-discounts";

/**
 * A coupon as the server works with it (CRT-3, #70). Dates are Dates, amounts are text without trailing zeros.
 * `amount` is the flat form's amount, like the shop-wide discount's rule.
 */
export type CouponRow = {
  id: string; version: number; code: string; funding: "platform" | "shop"; shopId: string | null; form: "percentage" | "flat";
  percentage: string | null; cap: string | null; amount: string | null; minimumOrder: string | null;
  startsAt: Date | null; expiresAt: Date; usageLimit: number | null; perCustomerLimit: number; firstOrderOnly: boolean;
  areaIds: string[]; categoryIds: string[]; status: "active" | "off" | "paused";
};

export const couponSql = (c: string) => `${c}.id, ${c}.version, ${c}.code, ${c}.funding, ${c}.shop_id AS "shopId", ${c}.form,
  trim_scale(${c}.percentage)::text AS percentage, trim_scale(${c}.cap)::text AS cap, trim_scale(${c}.flat_amount)::text AS amount,
  trim_scale(${c}.minimum_order)::text AS "minimumOrder", ${c}.starts_at AS "startsAt", ${c}.expires_at AS "expiresAt", ${c}.usage_limit AS "usageLimit",
  ${c}.per_customer_limit AS "perCustomerLimit", ${c}.first_order_only AS "firstOrderOnly", ${c}.area_ids AS "areaIds", ${c}.category_ids AS "categoryIds", ${c}.status`;

/** The statuses that give a use back: an order cancelled, rejected or expired before the shop took it leaves its coupon unused (CRT-3, agreed decision 4). A failed delivery still counts. */
export const RELEASING_STATUSES = ["cancelled_by_customer", "cancelled_by_shop", "rejected_by_shop", "expired"];

export async function couponByCode(client: Pool | PoolClient, code: string): Promise<CouponRow | undefined> {
  return (await client.query<CouponRow>(`SELECT ${couponSql("c")} FROM coupons c WHERE lower(c.code) = lower($1)`, [code])).rows[0];
}

/** The same row as the API shows it. `used` is the orders it is in force on now. */
export function couponView(row: CouponRow, used: number): Coupon {
  return {
    id: row.id, version: row.version, code: row.code, funding: row.funding, shopId: row.shopId, form: row.form, percentage: row.percentage, cap: row.cap,
    amount: row.amount, minimumOrder: row.minimumOrder, startsAt: row.startsAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString(),
    usageLimit: row.usageLimit, perCustomerLimit: row.perCustomerLimit, firstOrderOnly: row.firstOrderOnly, areaIds: row.areaIds, categoryIds: row.categoryIds,
    status: row.status, used,
  };
}

/** Every coupon (or the ones of one shop) with its count of uses in force, newest first. */
export async function couponsWithUse(client: Pool | PoolClient, shopId: string | null): Promise<Coupon[]> {
  const { rows } = await client.query<CouponRow & { used: number }>(
    `SELECT ${couponSql("c")}, (SELECT count(*)::int FROM coupon_uses u JOIN orders o ON o.id = u.order_id WHERE u.coupon_id = c.id AND o.status <> ALL($2::text[])) AS used
       FROM coupons c WHERE $1::uuid IS NULL OR c.shop_id = $1 ORDER BY c.updated_at DESC, c.code`, [shopId, RELEASING_STATUSES]);
  return rows.map(({ used, ...row }) => couponView(row, used));
}

/** Keeps one more version of a coupon: its terms as they now stand, who changed them (null: YGo), and when. */
export async function recordCouponVersion(client: PoolClient, couponId: string, actorId: string | null, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO coupon_versions (coupon_id, version, code, funding, shop_id, form, percentage, cap, flat_amount, minimum_order, status, starts_at, expires_at,
        usage_limit, per_customer_limit, first_order_only, area_ids, category_ids, actor_id, created_at)
     SELECT id, version, code, funding, shop_id, form, percentage, cap, flat_amount, minimum_order, status, starts_at, expires_at,
        usage_limit, per_customer_limit, first_order_only, area_ids, category_ids, $2, $3 FROM coupons WHERE id = $1`, [couponId, actorId, at]);
}

/**
 * Whether a shop-funded coupon's worst case is over the shop's maximum (D-12, MNY-5). A platform-funded coupon is held to the contribution surplus
 * instead, at order time, so it has no maximum. `maximum` is passed when a draft rate card has set one to try (MNY-10).
 */
export async function couponAboveMaximum(client: Pool | PoolClient, coupon: Pick<CouponRow, "funding" | "shopId" | "form" | "percentage" | "amount" | "minimumOrder">, maximum?: string): Promise<{ above: boolean; maximum: string | null }> {
  if (coupon.funding !== "shop" || !coupon.shopId) return { above: false, maximum: null };
  const limit = maximum ?? await maximumDiscountPercentage(client, coupon.shopId);
  return { above: await exceedsMaximum(client, coupon, limit), maximum: limit };
}

/**
 * Pauses every active shop-funded coupon that is now over its shop's maximum, never reducing one, and tells its Owner once, naming the code (D-12, NOT-6).
 * Runs in the transaction that published the rate card, like `pauseOverMaximum`, so no coupon stays active over the new maximum.
 */
export async function pauseCouponsOverMaximum(client: PoolClient, shopId: string | null, at: Date): Promise<void> {
  const { rows } = await client.query<CouponRow>(
    `SELECT ${couponSql("c")} FROM coupons c WHERE c.status = 'active' AND c.funding = 'shop' AND ($1::uuid IS NULL OR c.shop_id = $1) ORDER BY c.id FOR UPDATE`, [shopId]);
  for (const coupon of rows) {
    const { above, maximum } = await couponAboveMaximum(client, coupon);
    if (!above || !coupon.shopId) continue;
    await client.query("UPDATE coupons SET status = 'paused', version = version + 1, updated_at = $2 WHERE id = $1", [coupon.id, at]);
    await recordCouponVersion(client, coupon.id, null, at);
    await notifyShopOwner(client, coupon.shopId, "coupon_paused", `Your coupon ${coupon.code} is paused`,
      `The largest discount YGo allows is now ${maximum}%, and coupon ${coupon.code} is over it. Lower it to turn it back on.`, at, `coupon_paused:${coupon.id}:${coupon.version + 1}`);
  }
}

export type CartContext = { accountId: string | null; shopId: string; now: Date; bargained: boolean; maximum?: string };

/**
 * Why `coupon` cannot go on this Customer's cart now, or null when it can (CRT-3, CRT-4). Checked in the order the Customer can act on:
 * whether it is theirs to use, its dates, a bargained line, then its limits. Uses are counted only while their order is in force (`RELEASING_STATUSES`).
 * Facts that depend on the basket's amounts (minimum order, categories, the contribution surplus) are the pricing engine's to decide.
 * `accountId` is null for the Admin simulator, which has no Customer: the Customer's own limits are then not checked.
 */
export async function couponRefusal(client: Pool | PoolClient, coupon: CouponRow, ctx: CartContext): Promise<CouponReason | null> {
  if (coupon.status !== "active" || (coupon.shopId !== null && coupon.shopId !== ctx.shopId)) return "NOT_AVAILABLE";
  if (coupon.areaIds.length) {
    const { rowCount } = await client.query(
      "SELECT 1 FROM shops s JOIN area_pincodes p ON p.pincode = s.pincode WHERE s.id = $1 AND p.area_id = ANY($2::uuid[])", [ctx.shopId, coupon.areaIds]);
    if (!rowCount) return "NOT_AVAILABLE";
  }
  if ((await couponAboveMaximum(client, coupon, ctx.maximum)).above) return "NOT_AVAILABLE";
  if (coupon.startsAt && coupon.startsAt > ctx.now) return "NOT_STARTED";
  if (coupon.expiresAt <= ctx.now) return "EXPIRED";
  if (ctx.bargained) return "WITH_BARGAIN";
  const { rows: [used] } = await client.query<{ total: number; mine: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE u.account_id = $2)::int AS mine
       FROM coupon_uses u JOIN orders o ON o.id = u.order_id WHERE u.coupon_id = $1 AND o.status <> ALL($3::text[])`, [coupon.id, ctx.accountId, RELEASING_STATUSES]);
  if (coupon.usageLimit !== null && (used?.total ?? 0) >= coupon.usageLimit) return "LIMIT_REACHED";
  if (ctx.accountId === null) return null;
  if ((used?.mine ?? 0) >= coupon.perCustomerLimit) return "ALREADY_USED";
  if (coupon.firstOrderOnly && (await client.query("SELECT 1 FROM orders WHERE account_id = $1 AND status <> ALL($2::text[]) LIMIT 1", [ctx.accountId, RELEASING_STATUSES])).rowCount) return "FIRST_ORDER_ONLY";
  return null;
}

/** The terms the pricing engine takes (`coupon` in `pricing_delivered_quote`). */
export const engineCoupon = (coupon: CouponRow) => ({
  funding: coupon.funding, form: coupon.form, percentage: coupon.percentage, cap: coupon.cap, amount: coupon.amount,
  // A flat coupon with no minimum order is met by any basket: the engine tests a flat form against its minimum, so it is given 0.
  minimumOrder: coupon.minimumOrder ?? (coupon.form === "flat" ? "0" : null),
});

/**
 * Whether each line may take the coupon: its category, or the category's parent, is among the coupon's, or the coupon names none (FR-PRC-08).
 * Answered in the order of `categoryIds`.
 */
export async function couponCategoryEligibility(client: Pool | PoolClient, coupon: Pick<CouponRow, "categoryIds">, categoryIds: string[]): Promise<boolean[]> {
  if (!coupon.categoryIds.length) return categoryIds.map(() => true);
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM categories WHERE id = ANY($1::uuid[]) AND (id = ANY($2::uuid[]) OR parent_id = ANY($2::uuid[]))", [categoryIds, coupon.categoryIds]);
  const allowed = new Set(rows.map((row) => row.id));
  return categoryIds.map((id) => allowed.has(id));
}
