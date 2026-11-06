import type { Pool } from "pg";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";
import { moveOrder } from "./orders";

/** An order that timed out in awaiting_customer_confirm is closed with this reason in status history (#64). */
export const NO_CONFIRMATION = "no_confirmation";

const BATCH = 100;

/**
 * Moves every order in awaiting_customer_confirm whose proposal has expired to cancelled_by_customer
 * (actor system, reason no_confirmation) and marks the proposal expired (#64).
 * Each order is its own transaction, locking both the order and proposal row.
 */
export async function expireUnconfirmedOrders(pool: Pool, clock: Clock): Promise<number> {
  const now = clock.now();
  let expired = 0;
  let failure: unknown;
  let skip: string[] = [];

  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT o.id FROM orders o
       JOIN order_revisions r ON r.order_id = o.id AND r.status = 'proposed'
       WHERE o.status = 'awaiting_customer_confirm' AND r.confirm_by_at <= $1::timestamptz
         AND o.id <> ALL($2::uuid[])
       ORDER BY r.confirm_by_at, o.id LIMIT $3`,
      [now, skip, BATCH],
    );
    if (rows.length === 0) break;

    for (const { id } of rows) {
      try {
        const moved = await withTransaction(pool, async (client) => {
          const { rows: [order] } = await client.query<{ id: string; status: "awaiting_customer_confirm" }>(
            `SELECT id, status FROM orders WHERE id = $1 AND status = 'awaiting_customer_confirm' FOR UPDATE SKIP LOCKED`,
            [id],
          );
          if (!order) return false;

          const { rows: [revision] } = await client.query<{ id: string }>(
            `SELECT id FROM order_revisions WHERE order_id = $1 AND status = 'proposed' AND confirm_by_at <= $2::timestamptz FOR UPDATE`,
            [id, now],
          );
          if (!revision) return false;

          await client.query("UPDATE order_revisions SET status = 'expired' WHERE id = $1", [revision.id]);
          if (!await moveOrder(client, order, "cancelled_by_customer", { id: null, role: "system" }, now, NO_CONFIRMATION)) {
            return false;
          }
          await client.query("COMMIT");
          return true;
        });
        if (moved) expired += 1;
        else skip = [...skip, id];
      } catch (error) {
        failure ??= error;
        skip = [...skip, id];
      }
    }
  }

  if (failure) throw new Error("Some unconfirmed orders could not be expired", { cause: failure });
  return expired;
}

