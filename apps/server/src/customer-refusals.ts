import type { Pool, PoolClient } from "pg";

/** TRU-5 counts refusals and failed deliveries over this many days. */
export const REFUSAL_WINDOW_DAYS = 30;

/**
 * A Customer's failed deliveries in the 30 days up to `now` (TRU-5, #60). Worked out from the orders, never stored.
 * `failed` is every delivery that ended `delivery_failed`, whatever the reason; `refused` is the part of it where the
 * deliverer chose "Customer refused", so a refusal is counted once and never in addition to a failed delivery. Two
 * `failed` in the window flag the Customer for Admin; the flag and the block belong to #72, and nothing here blocks anyone.
 * The window runs from exactly 30 days before `now` to `now`, both ends counted.
 */
export async function customerFailedDeliveries(db: Pool | PoolClient, accountId: string, now: Date): Promise<{ failed: number; refused: number }> {
  const { rows: [row] } = await db.query<{ failed: number; refused: number }>(
    `SELECT count(*)::int AS failed, (count(*) FILTER (WHERE failed_delivery_reason = 'customer_refused'))::int AS refused
     FROM orders
     WHERE account_id = $1 AND status = 'delivery_failed'
       AND status_changed_at >= $2::timestamptz - make_interval(days => $3) AND status_changed_at <= $2`,
    [accountId, now, REFUSAL_WINDOW_DAYS]);
  return row ?? { failed: 0, refused: 0 };
}
