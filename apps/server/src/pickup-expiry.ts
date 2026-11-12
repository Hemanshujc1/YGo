import type { Pool } from "pg";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";
import { orderTiming } from "./order-timing";
import { moveOrder } from "./orders";

/** A pickup nobody collected is closed with this reason in its status history (FUL-7, #65). */
export const NOT_COLLECTED = "not_collected";

const BATCH = 100;

/**
 * Moves every pickup that has been Ready for `PICKUP_COLLECT_SECONDS` (counted from `status_changed_at`, the moment it went Ready) to Not collected, and
 * returns how many it moved. Nobody pays or is charged anything for it: the booking fee is charged only on completion, and the order's stock hold ends with
 * its status. Each order is its own transaction, locked and re-read as still Ready and due, so a rerun, a second job or the shop completing the pickup at the
 * same moment can never close it twice. Orders that fail do not stop the others; the first failure is thrown once the rest are done, so the job records the run as failed.
 */
export async function expireUncollectedPickups(pool: Pool, clock: Clock, batch = BATCH): Promise<number> {
  const now = clock.now();
  const due = `fulfilment = 'pickup' AND status = 'ready' AND status_changed_at + make_interval(secs => $1) <= $2::timestamptz`;
  let closed = 0;
  let failure: unknown;
  // Each batch starts after the last order of the one before, so an order that failed or was skipped is not read again and nothing is remembered per order (#601).
  // The time travels as text so its microseconds survive the round trip; a Date would cut them to milliseconds and the same order could come back.
  type Cursor = { at: string; id: string };
  let after = null as Cursor | null;
  for (;;) {
    const { rows }: { rows: Array<Cursor> } = await pool.query<Cursor>(
      `SELECT id, status_changed_at::text AS at FROM orders WHERE ${due} AND ($4::timestamptz IS NULL OR (status_changed_at, id) > ($4::timestamptz, $5::uuid))
       ORDER BY status_changed_at, id LIMIT $3`,
      [orderTiming.collectSeconds, now, batch, after?.at ?? null, after?.id ?? null]);
    if (rows.length === 0) break;
    const last: Cursor | undefined = rows[rows.length - 1];
    if (last) after = { at: last.at, id: last.id };
    for (const { id } of rows) {
      try {
        const moved = await withTransaction(pool, async (client) => {
          const { rows: [order] } = await client.query<{ id: string; status: "ready" }>(
            `SELECT id, status FROM orders WHERE id = $3 AND ${due} FOR UPDATE SKIP LOCKED`,
            [orderTiming.collectSeconds, now, id]);
          if (!order || !await moveOrder(client, order, "not_collected", { id: null, role: "system" }, now, NOT_COLLECTED)) return false;
          await client.query("COMMIT");
          return true;
        });
        if (moved) closed += 1;
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw new Error("Some pickups could not be closed", { cause: failure });
  return closed;
}
