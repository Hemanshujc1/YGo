import type { AdminCounterBill, ResolveCounterBillBody } from "@ygo/contracts";
import type { PoolClient } from "pg";
import { stockOf } from "./listings";

/** The largest stock quantity a movement holds (NUMERIC(12,3)); the same limit `applyCounterBill` holds a sale to. */
const largestQuantity = "999999999.999";

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const linesOf = (bill: string) => `COALESCE((SELECT json_agg(json_build_object('packId', l.pack_id, 'name', p.name, 'packQuantity', pk.quantity::text,
    'baseUnit', p.base_unit, 'count', l.count, 'unitPrice', l.unit_price::text) ORDER BY l.position)
  FROM counter_bill_lines l LEFT JOIN packs pk ON pk.id = l.pack_id LEFT JOIN master_products p ON p.id = pk.product_id
  WHERE l.bill_id = ${bill}), '[]'::json)`;
const closing = "r.action <> 'noted'";

const billsSql = `SELECT b.id, b.reference, b.number, b.held_reason AS "heldReason", b.total_mismatch AS "totalMismatch", b.payment,
  b.total::text AS total, b.checked_total::text AS "checkedTotal", b.clock_suspect AS "clockSuspect",
  ${iso("b.made_at")} AS "madeAt", ${iso("b.received_at")} AS "receivedAt", b.invalid_payload AS "invalidPayload",
  json_build_object('name', a.name, 'role', m.role) AS "madeBy", ${linesOf("b.id")} AS lines,
  (SELECT json_build_object('id', o.id, 'number', o.number, 'total', o.total::text, 'payment', o.payment, 'madeAt', ${iso("o.made_at")}, 'lines', ${linesOf("o.id")})
    FROM counter_bills o WHERE b.held_reason = 'reference_taken' AND o.shop_id = b.shop_id AND o.reference = b.reference AND NOT o.reference_clash) AS original,
  EXISTS (SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = b.id AND ${closing}) AS resolved,
  COALESCE((SELECT json_agg(json_build_object('action', r.action, 'note', r.note, 'stockMoved', r.stock_moved, 'actorName', ra.name,
      'createdAt', ${iso("r.created_at")}) ORDER BY r.created_at, r.id)
    FROM counter_bill_resolutions r LEFT JOIN accounts ra ON ra.id = r.actor_id WHERE r.bill_id = b.id), '[]'::json) AS resolutions
  FROM counter_bills b LEFT JOIN accounts a ON a.id = b.actor_id LEFT JOIN shop_members m ON m.account_id = b.actor_id AND m.shop_id = b.shop_id
  WHERE b.shop_id = $1`;

/** A shop's held and flagged bills, and the ones Admin has dealt with, the open ones first. The newest 200 are enough for one shop's queue. */
export async function listCounterBills(client: Pick<PoolClient, "query">, shopId: string): Promise<AdminCounterBill[]> {
  const { rows } = await client.query<AdminCounterBill>(`${billsSql} AND (b.held_reason IS NOT NULL OR b.total_mismatch OR EXISTS (SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = b.id)) ORDER BY resolved, b.received_at DESC, b.id LIMIT 200`, [shopId]);
  return rows;
}

type Row = { id: string; heldReason: string | null; number: number | null; totalMismatch: boolean; actorId: string; clientId: string };

/**
 * Admin's decision on one held or flagged bill (#470). The caller holds the shop's row lock, the one a sync batch
 * holds while it numbers a bill, so the shop's numbers cannot be handed out twice. The bill's row lock and the
 * unique closing row stop two Admins closing it twice; the stock movements share the bill's `client_id`, which
 * the table keeps unique per listing, so a sale cannot be taken from stock twice either.
 */
export async function resolveCounterBill(client: PoolClient, shopId: string, billId: string, adminId: string, body: ResolveCounterBillBody):
  Promise<{ code: "NOT_FOUND" | "COUNTER_BILL_RESOLVED" | "COUNTER_BILL_ACTION_REFUSED" } | { bill: AdminCounterBill }> {
  const { rows: [bill] } = await client.query<Row>(`SELECT id, held_reason AS "heldReason", number, total_mismatch AS "totalMismatch", actor_id AS "actorId", client_id AS "clientId"
    FROM counter_bills WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [billId, shopId]);
  if (!bill) return { code: "NOT_FOUND" };
  if ((await client.query(`SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = $1 AND ${closing}`, [billId])).rowCount) return { code: "COUNTER_BILL_RESOLVED" };

  const held = bill.heldReason;
  const fits = {
    number: held !== null && held !== "invalid",
    duplicate: held === "reference_taken",
    review: held === "invalid" || (bill.number !== null && bill.totalMismatch),
    note: held !== null || bill.totalMismatch,
  }[body.action];
  if (!fits) return { code: "COUNTER_BILL_ACTION_REFUSED" };

  let stockMoved = false;
  if (body.action === "number") {
    const { rows: [given] } = await client.query<{ number: number }>(`INSERT INTO counter_bill_numbers (shop_id, last_number) VALUES ($1, 1)
      ON CONFLICT (shop_id) DO UPDATE SET last_number = counter_bill_numbers.last_number + 1 RETURNING last_number AS number`, [shopId]);
    if (!given) throw new Error("Counter bill number returned no row");
    await client.query("UPDATE counter_bills SET number = $2, held_reason = NULL WHERE id = $1", [billId, given.number]);
    // A sale moves stock only when it can be applied as recorded: not a `too_large` one, not one whose total the
    // server disagrees with (BIL-9), every pack still on the shop's list, and every line fitting one movement.
    if (held !== "too_large" && !bill.totalMismatch) {
      const { rows: [check] } = await client.query<{ lines: number; listed: number; overflow: boolean | null }>(`SELECT count(*)::int AS lines, count(sl.id)::int AS listed,
          bool_or(l.count * pk.quantity > ${largestQuantity} OR ${stockOf("sl")} - l.count * pk.quantity < -${largestQuantity}) AS overflow
        FROM counter_bill_lines l LEFT JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = l.pack_id LEFT JOIN packs pk ON pk.id = l.pack_id
        WHERE l.bill_id = $2`, [shopId, billId]);
      if (check && check.lines === check.listed && !check.overflow) {
        await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
          SELECT sl.id, $3, $4, 'sale', -(l.count * pk.quantity)
          FROM counter_bill_lines l JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = l.pack_id JOIN packs pk ON pk.id = l.pack_id
          WHERE l.bill_id = $2`, [shopId, billId, bill.actorId, bill.clientId]);
        stockMoved = true;
      }
    }
  }
  const action = { number: "numbered", duplicate: "duplicate", review: "reviewed", note: "noted" }[body.action];
  await client.query("INSERT INTO counter_bill_resolutions (bill_id, actor_id, action, note, stock_moved) VALUES ($1, $2, $3, $4, $5)", [billId, adminId, action, body.note, stockMoved]);

  const { rows: [saved] } = await client.query<AdminCounterBill>(`${billsSql} AND b.id = $2`, [shopId, billId]);
  if (!saved) throw new Error("Resolved counter bill vanished");
  return { bill: saved };
}
