import type { Pool } from "pg";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";
import { orderTiming } from "./order-timing";
import { moveOrder } from "./orders";

/** An order the shop never answered is closed with this reason in its status history (ORD-2). */
export const NO_ANSWER = "no_answer";

const BATCH = 100;

/**
 * Moves every placed order that is `ORDER_EXPIRE_SECONDS` old to Expired, and returns how many it moved (ORD-2). Each
 * order is its own transaction: the status, its history row and the customer's notification land together or not at
 * all. The row is locked and re-read as still placed and due, so a rerun, a second job or a shop answering at the
 * same moment can never expire it twice or send its notification twice. Orders that fail do not stop the others; the
 * first failure is thrown once the rest are done, so the job records the run as failed.
 */
export async function expireUnansweredOrders(pool: Pool, clock: Clock): Promise<number> {
  const now = clock.now();
  const due = `status = 'placed' AND placed_at + make_interval(secs => $1) <= $2::timestamptz`;
  let expired = 0;
  let failure: unknown;
  let skip: string[] = [];
  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE ${due} AND id <> ALL($4::uuid[]) ORDER BY placed_at, id LIMIT $3`,
      [orderTiming.expireSeconds, now, BATCH, skip]);
    if (rows.length === 0) break;
    for (const { id } of rows) {
      try {
        const moved = await withTransaction(pool, async (client) => {
          const { rows: [order] } = await client.query<{ id: string; status: "placed" }>(
            `SELECT id, status FROM orders WHERE id = $3 AND ${due} FOR UPDATE SKIP LOCKED`,
            [orderTiming.expireSeconds, now, id]);
          if (!order || !await moveOrder(client, order, "expired", { id: null, role: "system" }, now, NO_ANSWER)) return false;
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
  if (failure) throw new Error("Some orders could not be expired", { cause: failure });
  return expired;
}
