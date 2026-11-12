import type { StockChangePayload, StockChangeResponse } from "@ygo/contracts";
import type { PoolClient } from "pg";
import { isWholeBaseUnitQuantity } from "./routes/shop-listings";

const largestQuantity = "999999999.999";

/**
 * Records one stock change with its reason (BIL-7, #67) as a signed `adjustment` movement, so on-hand stays the sum of the movement log.
 * The listing row lock serializes stock changes: a counted total is turned into a difference against the latest committed on-hand figure inside that lock,
 * so two phones counting never overwrite each other. A sale or delivery takes no such lock (a counter sale is never blocked, BIL-4); one that commits
 * after the count is read is a later event and lands on top of it. Nothing here refuses for lack of stock: damaged goods may take a count below zero, as a counter sale may (BIL-4).
 * The action id is the movement's `client_id`, so a retry changes nothing, and the same id with another change is refused.
 */
export async function applyStockChange(client: PoolClient, accountId: string, shopId: string, actionId: string, change: StockChangePayload): Promise<
  { code: "NOT_FOUND" | "VALIDATION_FAILED" } | { status: 200 | 201; result: StockChangeResponse }
> {
  const { rows: [listing] } = await client.query<{ id: string; baseUnit: string }>(
    `SELECT sl.id, p.base_unit AS "baseUnit" FROM shop_listings sl
     JOIN packs pk ON pk.id = sl.pack_id JOIN master_products p ON p.id = pk.product_id
     WHERE sl.shop_id = $1 AND sl.pack_id = $2 AND NOT sl.removed_from_counter FOR UPDATE OF sl`, [shopId, change.packId]);
  if (!listing) return { code: "NOT_FOUND" };
  const asked = change.reason === "counted" ? change.total : change.quantity;
  if (listing.baseUnit === "each" && !isWholeBaseUnitQuantity(asked.replace("-", ""))) return { code: "VALIDATION_FAILED" };

  const { rows: [same] } = await client.query<{ kind: string; reason: string | null; actorId: string; quantity: string; target: string | null; createdAt: Date; sameAsked: boolean }>(
    `SELECT kind, reason, actor_id AS "actorId", quantity::text, target_quantity::text AS target, created_at AS "createdAt",
       COALESCE(CASE WHEN reason = 'counted' THEN target_quantity = $3::numeric ELSE quantity = $3::numeric END, false) AS "sameAsked"
     FROM stock_movements WHERE listing_id = $1 AND client_id = $2`, [listing.id, actionId, asked]);
  const { rows: [now] } = await client.query<{ onHand: string }>(`SELECT COALESCE(sum(quantity), 0)::text AS "onHand" FROM stock_movements WHERE listing_id = $1`, [listing.id]);
  const onHand = now?.onHand ?? "0";
  if (same) {
    if (same.kind !== "adjustment" || same.reason !== change.reason || same.actorId !== accountId || !same.sameAsked) return { code: "VALIDATION_FAILED" };
    return { status: 200, result: { listingId: listing.id, reason: change.reason, change: same.quantity, onHand, recordedAt: same.createdAt.toISOString() } };
  }
  const { rows: [bound] } = await client.query<{ over: boolean }>(`SELECT abs(CASE WHEN $4::boolean THEN $2::numeric ELSE $1::numeric + $2::numeric END) > $3::numeric AS over`,
    [onHand, asked, largestQuantity, change.reason === "counted"]);
  if (bound?.over) return { code: "VALIDATION_FAILED" };
  const inserted = await client.query<{ quantity: string; createdAt: Date }>(
    change.reason === "counted"
      ? `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, reason, quantity, target_quantity)
         VALUES ($1, $2, $3, 'adjustment', 'counted', $4::numeric - $5::numeric, $4::numeric) RETURNING quantity::text, created_at AS "createdAt"`
      : `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, reason, quantity)
         VALUES ($1, $2, $3, 'adjustment', $5, $4::numeric) RETURNING quantity::text, created_at AS "createdAt"`,
    change.reason === "counted" ? [listing.id, accountId, actionId, change.total, onHand] : [listing.id, accountId, actionId, change.quantity, change.reason]);
  const movement = inserted.rows[0];
  if (!movement) throw new Error("Stock change insert returned no row");
  const { rows: [after] } = await client.query<{ onHand: string }>(`SELECT COALESCE(sum(quantity), 0)::text AS "onHand" FROM stock_movements WHERE listing_id = $1`, [listing.id]);
  return { status: 201, result: { listingId: listing.id, reason: change.reason, change: movement.quantity, onHand: after?.onHand ?? "0", recordedAt: movement.createdAt.toISOString() } };
}
