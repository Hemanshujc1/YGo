import type { Pool } from "pg";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";

/**
 * Checks each listing's on-hand figure (the sum of its movement log) against what its documents say it should be, and records any difference (#67).
 * Expected on-hand is: the opening, correction, adjustment and transfer movements, less what every delivered or picked-up order took (the confirmed
 * revision's lines when it has one, else its placement lines), less what every applied counter bill took, plus what voided bills gave back. A bill is applied when any of
 * its sale movements exists, because a held bill or one whose total disagrees moves no stock (BIL-5, BIL-9); a bill that moved some lines and not others is a difference.
 * Reservations are not physical stock and stay out of it (an accepted order holds, it does not move). Negative stock is no difference: a counter sale is never
 * blocked (BIL-4). The job only reports: it never writes a movement. One open row per listing, closed by the next run that finds it right.
 */
const differences = `
WITH logged AS (
  SELECT listing_id, sum(quantity) AS on_hand, COALESCE(sum(quantity) FILTER (WHERE kind NOT IN ('sale', 'void')), 0) AS recorded
  FROM stock_movements GROUP BY listing_id),
orders_took AS (
  SELECT line.listing_id, sum(line.stock_quantity) AS took
  FROM orders o
  CROSS JOIN LATERAL (
    SELECT (SELECT r.id FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1) AS revision_id) rev
  CROSS JOIN LATERAL (
    SELECT rl.listing_id, rl.stock_quantity FROM order_revision_lines rl WHERE rev.revision_id IS NOT NULL AND rl.revision_id = rev.revision_id
    UNION ALL
    SELECT ol.listing_id, ol.stock_quantity FROM order_lines ol WHERE rev.revision_id IS NULL AND ol.order_id = o.id) line
  WHERE o.status IN ('delivered', 'picked_up')
  GROUP BY line.listing_id),
bills_took AS (
  SELECT sl.id AS listing_id, sum(l.count * pk.quantity) AS took, COALESCE(sum(l.count * pk.quantity) FILTER (WHERE v.stock_moved), 0) AS given_back
  FROM counter_bills b
  JOIN counter_bill_lines l ON l.bill_id = b.id
  JOIN packs pk ON pk.id = l.pack_id
  JOIN shop_listings sl ON sl.shop_id = b.shop_id AND sl.pack_id = l.pack_id
  LEFT JOIN counter_bill_voids v ON v.bill_id = b.id
  WHERE EXISTS (SELECT 1 FROM stock_movements sm JOIN shop_listings own ON own.id = sm.listing_id
    WHERE own.shop_id = b.shop_id AND sm.client_id = b.client_id AND sm.kind = 'sale')
  GROUP BY sl.id)
SELECT sl.id AS "listingId", sl.shop_id AS "shopId", COALESCE(logged.on_hand, 0)::text AS "onHand",
  (COALESCE(logged.recorded, 0) - COALESCE(orders_took.took, 0) - COALESCE(bills_took.took, 0) + COALESCE(bills_took.given_back, 0))::text AS expected
FROM shop_listings sl
LEFT JOIN logged ON logged.listing_id = sl.id
LEFT JOIN orders_took ON orders_took.listing_id = sl.id
LEFT JOIN bills_took ON bills_took.listing_id = sl.id
WHERE COALESCE(logged.on_hand, 0) <> COALESCE(logged.recorded, 0) - COALESCE(orders_took.took, 0) - COALESCE(bills_took.took, 0) + COALESCE(bills_took.given_back, 0)`;

/** Runs the check and returns how many listings differ. Writes only the report rows, never stock. */
export async function reconcileStock(pool: Pool, clock: Clock): Promise<number> {
  const now = clock.now();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ listingId: string; shopId: string; onHand: string; expected: string }>(differences);
    for (const row of rows) {
      await client.query(
        `INSERT INTO stock_reconciliation_issues (shop_id, listing_id, on_hand, expected, difference, first_found_at, last_found_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, $3::numeric - $4::numeric, $5, $5)
         ON CONFLICT (listing_id) WHERE resolved_at IS NULL
         DO UPDATE SET on_hand = EXCLUDED.on_hand, expected = EXCLUDED.expected, difference = EXCLUDED.difference, last_found_at = EXCLUDED.last_found_at`,
        [row.shopId, row.listingId, row.onHand, row.expected, now]);
    }
    await client.query(`UPDATE stock_reconciliation_issues SET resolved_at = $2 WHERE resolved_at IS NULL AND NOT (listing_id = ANY($1::uuid[]))`, [rows.map((row) => row.listingId), now]);
    await client.query("COMMIT");
    return rows.length;
  });
}
