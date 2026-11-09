import { DEFAULT_MAXIMUM_SHOP_DISCOUNT_PERCENTAGE } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";
import { notifyShopOwner } from "./notifications";
import { resolveRateCard } from "./routes/rate-cards";

/**
 * The largest effective shop-funded discount percentage this shop is held to: its rate card's value, shop over global,
 * or the default (MNY-5). A category card never sets it, because the discount is order-level.
 */
export async function maximumDiscountPercentage(client: Pool | PoolClient, shopId: string): Promise<string> {
  const card = await resolveRateCard(client, shopId);
  const value = card?.values.maximumShopDiscountPercentage?.value;
  return typeof value === "string" ? value : DEFAULT_MAXIMUM_SHOP_DISCOUNT_PERCENTAGE;
}

/** Whether a rule's worst case is over `maximum`; the comparison is exact, in the database (MNY-5). */
export async function exceedsMaximum(
  client: Pool | PoolClient, rule: { form: string; percentage: string | null; amount: string | null; minimumOrder: string | null }, maximum: string,
): Promise<boolean> {
  const { rows: [row] } = await client.query<{ exceeds: boolean }>(
    "SELECT shop_discount_exceeds($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric) AS exceeds", [rule.form, rule.percentage, rule.amount, rule.minimumOrder, maximum]);
  return row?.exceeds ?? false;
}

/** Keeps one more version of a rule: its terms as they now stand, who changed them (null: YGo), and when. */
export async function recordVersion(client: PoolClient, ruleId: string, actorId: string | null, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO shop_discount_versions (rule_id, version, form, percentage, cap, flat_amount, minimum_order, status, actor_id, created_at)
     SELECT id, version, form, percentage, cap, flat_amount, minimum_order, status, $2, $3 FROM shop_discounts WHERE id = $1`, [ruleId, actorId, at]);
}

/**
 * Pauses every active rule that is now over its shop's maximum, never reducing one (NOT-6), and tells its Owner once.
 * Runs inside the transaction that published the rate card, holding the publish lock, so no Owner save can slip a rule
 * in between and none stays active over the new maximum. `shopId` narrows it to one shop's own card; null is a global one.
 */
export async function pauseOverMaximum(client: PoolClient, shopId: string | null, at: Date): Promise<void> {
  const { rows } = await client.query<{ id: string; shopId: string; version: number; form: string; percentage: string | null; amount: string | null; minimumOrder: string | null }>(
    `SELECT id, shop_id AS "shopId", version, form, trim_scale(percentage)::text AS percentage, trim_scale(flat_amount)::text AS amount,
        trim_scale(minimum_order)::text AS "minimumOrder"
      FROM shop_discounts WHERE status = 'active' AND ($1::uuid IS NULL OR shop_id = $1) ORDER BY id FOR UPDATE`, [shopId]);
  for (const rule of rows) {
    const maximum = await maximumDiscountPercentage(client, rule.shopId);
    if (!await exceedsMaximum(client, rule, maximum)) continue;
    await client.query("UPDATE shop_discounts SET status = 'paused', version = version + 1, updated_at = $2 WHERE id = $1", [rule.id, at]);
    await recordVersion(client, rule.id, null, at);
    await notifyShopOwner(client, rule.shopId, "shop_discount_paused", "Your shop discount is paused",
      `The largest discount YGo allows is now ${maximum}%, and yours is over it. Lower it on the Shop discount screen to turn it back on.`, at,
      `shop_discount_paused:${rule.id}:${rule.version + 1}`);
  }
}
