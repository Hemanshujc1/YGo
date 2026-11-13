import type { Pool, PoolClient } from "pg";

/** TRU-5 counts refusals and failed deliveries over this many days. */
export const REFUSAL_WINDOW_DAYS = 30;
export const CUSTOMER_TRUST_FLAG_THRESHOLD = 2;

/** Parameters: $1 is the window end. Shared by the single-customer and Admin list queries. */
export const customerFailureCountsSql = `SELECT account_id, count(*)::int AS failed,
  (count(*) FILTER (WHERE failed_delivery_reason = 'customer_refused'))::int AS refused,
  count(*) >= ${CUSTOMER_TRUST_FLAG_THRESHOLD} AS flagged
  FROM orders
  WHERE status = 'delivery_failed'
    AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = orders.id AND h.to_status = 'delivery_failed' AND h.reason_code = 'admin_forced')
    AND status_changed_at >= $1::timestamptz - make_interval(days => ${REFUSAL_WINDOW_DAYS}) AND status_changed_at <= $1
  GROUP BY account_id`;

/**
 * A Customer's failed deliveries in the 30 days up to `now` (TRU-5, #60). Worked out from the orders, never stored.
 * `failed` is every delivery that ended `delivery_failed`, whatever the reason; `refused` is the part of it where the
 * deliverer chose "Customer refused", so a refusal is counted once and never in addition to a failed delivery. Two
 * `failed` in the window flag the Customer for Admin; the flag and the block belong to #72, and nothing here blocks anyone.
 * The window runs from exactly 30 days before `now` to `now`, both ends counted.
 */
export async function customerFailedDeliveries(db: Pool | PoolClient, accountId: string, now: Date): Promise<{ failed: number; refused: number }> {
  const { rows: [row] } = await db.query<{ failed: number; refused: number }>(
    `SELECT failed, refused FROM (${customerFailureCountsSql}) counts WHERE account_id = $2`,
    [now, accountId]);
  return row ?? { failed: 0, refused: 0 };
}
