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
const manualOf = (bill: string) => `COALESCE((SELECT json_agg(json_build_object('name', m.name, 'count', m.count, 'unitPrice', m.unit_price::text) ORDER BY m.position)
  FROM counter_bill_manual_lines m WHERE m.bill_id = ${bill}), '[]'::json)`;
const closing = "r.action <> 'noted'";
/** A bill's void as Admin reads it (#495): why, when, whether stock came back, and who voided it. */
const voidOf = (bill: string) => `(SELECT json_build_object('reason', v.reason, 'note', v.note, 'stockMoved', v.stock_moved, 'actorName', va.name, 'createdAt', ${iso("v.created_at")})
  FROM counter_bill_voids v LEFT JOIN accounts va ON va.id = v.actor_id WHERE v.bill_id = ${bill})`;

const billsSql = `SELECT b.id, b.reference, b.number, b.held_reason AS "heldReason", b.total_mismatch AS "totalMismatch",
  b.flagged_denylist AS "flaggedDenylist", b.payment,
  b.total::text AS total, b.checked_total::text AS "checkedTotal", b.clock_suspect AS "clockSuspect",
  ${iso("b.made_at")} AS "madeAt", ${iso("b.received_at")} AS "receivedAt", b.invalid_payload AS "invalidPayload",
  json_build_object('name', a.name, 'role', m.role) AS "madeBy", ${linesOf("b.id")} AS lines, ${manualOf("b.id")} AS "manualLines", b.discount::text AS discount,
  (SELECT json_build_object('id', o.id, 'number', o.number, 'total', o.total::text, 'payment', o.payment, 'madeAt', ${iso("o.made_at")}, 'lines', ${linesOf("o.id")}, 'manualLines', ${manualOf("o.id")}, 'discount', o.discount::text, 'voided', ${voidOf("o.id")})
    FROM counter_bills o WHERE b.held_reason = 'reference_taken' AND o.shop_id = b.shop_id AND o.reference = b.reference AND NOT o.reference_clash) AS original,
  ${voidOf("b.id")} AS voided,
  (EXISTS (SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = b.id AND ${closing}) OR EXISTS (SELECT 1 FROM counter_bill_voids v WHERE v.bill_id = b.id)) AS resolved,
  COALESCE((SELECT json_agg(json_build_object('action', r.action, 'note', r.note, 'stockMoved', r.stock_moved, 'actorName', ra.name,
      'createdAt', ${iso("r.created_at")}) ORDER BY r.created_at, r.id)
    FROM counter_bill_resolutions r LEFT JOIN accounts ra ON ra.id = r.actor_id WHERE r.bill_id = b.id), '[]'::json) AS resolutions
  FROM counter_bills b LEFT JOIN accounts a ON a.id = b.actor_id LEFT JOIN shop_members m ON m.account_id = b.actor_id AND m.shop_id = b.shop_id
  WHERE b.shop_id = $1`;

const hidden = "[hidden]";
/** A key the bill does not have: its name could itself be a customer's name or phone, so only its place is kept. */
const unknownKey = (index: number) => `[hidden key ${index + 1}]`;
/** At most 9 digits in all (6 whole, 3 after the point), one fewer than a phone number, so a phone number put in an amount is hidden, dot or no dot. A larger amount in an unreadable bill is hidden too. */
const money = /^\d{1,6}(\.\d{1,3})?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMoney = (value: unknown) => typeof value === "string" && money.test(value);

/** One line of a bill: its pack's id, count and price, each only when it has the form the contract gives it; a typed line's name is always hidden. */
const lineOf = (line: unknown, typed: boolean): unknown => {
  if (!isRecord(line)) return hidden;
  return Object.fromEntries(Object.entries(line).map(([key, value], index) => {
    switch (key) {
      case "count": return [key, typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 1e6 ? value : hidden];
      case "unitPrice": return [key, isMoney(value) ? value : hidden];
      case "packId": return [key, !typed && typeof value === "string" && uuid.test(value) ? value : hidden];
      case "name": return [key, hidden];
      default: return [unknownKey(index), hidden];
    }
  }));
};

const readableLines = (typed: boolean) => (value: unknown) => (Array.isArray(value) && value.length <= 100 ? value.map((line) => lineOf(line, typed)) : hidden);
const readableOf: Record<string, (value: unknown) => unknown> = {
  lines: readableLines(false),
  manualLines: readableLines(true),
  discount: (value) => (isMoney(value) ? value : hidden),
  total: (value) => (isMoney(value) ? value : hidden),
  payment: (value) => (value === "cash" || value === "upi" ? value : hidden),
};

/**
 * An unreadable bill's stored text for Admin (#53): the bill's own keys, and a value only where it is a known field of
 * the bill with the form the contract gives it (an id, a count, an amount, cash or upi). Every other key and value
 * becomes "[hidden]", so a customer's name, phone or consent never reaches Admin wherever the phone put it, and a
 * typed line's name is hidden too. Text that is not a JSON object is hidden whole. No recursion, so no depth can break it.
 */
export function readableInvalidPayload(text: string | null): string | null {
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return hidden; }
  if (!isRecord(parsed)) return hidden;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([key, value], index) => Object.hasOwn(readableOf, key) ? [key, readableOf[key]?.(value)] : [unknownKey(index), hidden])));
}

/** A shop's held and flagged bills, and the ones Admin has dealt with, the open ones first. The newest 200 are enough for one shop's queue. */
export async function listCounterBills(client: Pick<PoolClient, "query">, shopId: string): Promise<AdminCounterBill[]> {
  const { rows } = await client.query<AdminCounterBill>(`${billsSql} AND (b.held_reason IS NOT NULL OR b.total_mismatch OR b.flagged_denylist OR EXISTS (SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = b.id)) ORDER BY resolved, b.received_at DESC, b.id LIMIT 200`, [shopId]);
  return rows.map((row) => ({ ...row, invalidPayload: readableInvalidPayload(row.invalidPayload) }));
}

type Row = { id: string; heldReason: string | null; number: number | null; totalMismatch: boolean; flaggedDenylist: boolean; actorId: string; clientId: string };

/**
 * Admin's decision on one held or flagged bill (#470). The caller holds the shop's row lock, the one a sync batch
 * holds while it numbers a bill, so the shop's numbers cannot be handed out twice. The bill's row lock and the
 * unique closing row stop two Admins closing it twice; the stock movements share the bill's `client_id`, which
 * the table keeps unique per listing, so a sale cannot be taken from stock twice either.
 */
export async function resolveCounterBill(client: PoolClient, shopId: string, billId: string, adminId: string, body: ResolveCounterBillBody, now: Date):
  Promise<{ code: "NOT_FOUND" | "COUNTER_BILL_RESOLVED" | "COUNTER_BILL_ACTION_REFUSED" } | { bill: AdminCounterBill }> {
  const { rows: [bill] } = await client.query<Row>(`SELECT id, held_reason AS "heldReason", number, total_mismatch AS "totalMismatch", flagged_denylist AS "flaggedDenylist", actor_id AS "actorId", client_id AS "clientId"
    FROM counter_bills WHERE id = $1 AND shop_id = $2 FOR UPDATE`, [billId, shopId]);
  if (!bill) return { code: "NOT_FOUND" };
  if ((await client.query(`SELECT 1 FROM counter_bill_resolutions r WHERE r.bill_id = $1 AND ${closing}`, [billId])).rowCount) return { code: "COUNTER_BILL_RESOLVED" };

  const held = bill.heldReason;
  const voided = (await client.query("SELECT 1 FROM counter_bill_voids WHERE bill_id = $1", [billId])).rowCount !== 0;
  const fits = {
    number: !voided && held !== null && held !== "invalid",
    duplicate: !voided && held === "reference_taken",
    review: !voided && (held === "invalid" || (bill.number !== null && (bill.totalMismatch || bill.flaggedDenylist))),
    note: held !== null || bill.totalMismatch || bill.flaggedDenylist,
  }[body.action];
  if (!fits) return { code: "COUNTER_BILL_ACTION_REFUSED" };

  let stockMoved = false;
  if (body.action === "number") {
    const { rows: [given] } = await client.query<{ number: number }>(`INSERT INTO counter_bill_numbers (shop_id, last_number) VALUES ($1, 1)
      ON CONFLICT (shop_id) DO UPDATE SET last_number = counter_bill_numbers.last_number + 1 RETURNING last_number AS number`, [shopId]);
    if (!given) throw new Error("Counter bill number returned no row");
    // On the server's clock: the Owner's void window starts here (#497).
    await client.query("UPDATE counter_bills SET number = $2, held_reason = NULL, numbered_at = $3 WHERE id = $1", [billId, given.number, now]);
    // A sale moves stock only when it can be applied as recorded: not a `too_large` one, not one whose total the
    // server disagrees with (BIL-9), every pack still on the shop's list, and every line fitting one movement.
    if (held !== "too_large" && !bill.totalMismatch) {
      const { rows: [check] } = await client.query<{ lines: number; listed: number; overflow: boolean | null }>(`SELECT count(*)::int AS lines, count(sl.id)::int AS listed,
          bool_or(l.count * pk.quantity > ${largestQuantity} OR ${stockOf("sl")} - l.count * pk.quantity < -${largestQuantity}) AS overflow
        FROM counter_bill_lines l LEFT JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = l.pack_id LEFT JOIN packs pk ON pk.id = l.pack_id
        WHERE l.bill_id = $2`, [shopId, billId]);
      if (check && check.lines === check.listed && !check.overflow) {
        const moved = await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
          SELECT sl.id, $3, $4, 'sale', -(l.count * pk.quantity)
          FROM counter_bill_lines l JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = l.pack_id JOIN packs pk ON pk.id = l.pack_id
          WHERE l.bill_id = $2`, [shopId, billId, bill.actorId, bill.clientId]);
        // A bill of typed lines only (#53) passes the check with no lines and moves nothing.
        stockMoved = (moved.rowCount ?? 0) > 0;
      }
    }
  }
  const action = { number: "numbered", duplicate: "duplicate", review: "reviewed", note: "noted" }[body.action];
  await client.query("INSERT INTO counter_bill_resolutions (bill_id, actor_id, action, note, stock_moved) VALUES ($1, $2, $3, $4, $5)", [billId, adminId, action, body.note, stockMoved]);

  const { rows: [saved] } = await client.query<AdminCounterBill>(`${billsSql} AND b.id = $2`, [shopId, billId]);
  if (!saved) throw new Error("Resolved counter bill vanished");
  return { bill: { ...saved, invalidPayload: readableInvalidPayload(saved.invalidPayload) } };
}
