import { counterBillReference, CounterBillPayload, type CounterBillResponse } from "@ygo/contracts";
import type { PoolClient } from "pg";

type Bill = {
  accountId: string; shopId: string; actionId: string; madeAt: string; receivedAt: Date;
  /** Older than the server's limit: kept, but held for Admin (BIL-5). */
  tooOld: boolean; clockSuspect: boolean;
};

type Row = { billId: string; actorId: string; reference: string; number: number | null; heldReason: CounterBillResponse["heldReason"]; totalMismatch: boolean; recordedAt: Date };

const billColumns = `id AS "billId", actor_id AS "actorId", reference, number, held_reason AS "heldReason", total_mismatch AS "totalMismatch", received_at AS "recordedAt"`;
const answer = (row: Row): { result: CounterBillResponse } => ({ result: {
  billId: row.billId, reference: row.reference, number: row.number, heldReason: row.heldReason, totalMismatch: row.totalMismatch, recordedAt: row.recordedAt.toISOString(),
} });

/**
 * Records one counter bill (#51) inside the sync transaction, which holds the shop's row lock.
 *
 * A bill that can be applied as recorded gets the shop's next number and one `sale` movement per line. Stock
 * may go negative (BIL-4). A bill the server cannot read, whose pack has left the shop's list, or which is
 * older than the server's limit, is kept with no number and moves no stock (BIL-5). So is a bill whose
 * reference another bill already has: the unique index refuses it, and it is kept beside the first. A total
 * that differs from the server's sum still gets its number, but moves no stock (owner's answer on #51).
 */
export async function applyCounterBill(client: PoolClient, bill: Bill, payload: unknown): Promise<{ code: "ACTION_CONFLICT" } | { result: CounterBillResponse }> {
  // The same action id can only reach here again through a phone bug; it gets its first answer, and only its own.
  const { rows: [saved] } = await client.query<Row>(`SELECT ${billColumns} FROM counter_bills WHERE shop_id = $1 AND client_id = $2`, [bill.shopId, bill.actionId]);
  if (saved) return saved.actorId === bill.accountId ? answer(saved) : { code: "ACTION_CONFLICT" };

  const parsed = CounterBillPayload.safeParse(payload);
  const lines = parsed.success ? JSON.stringify(parsed.data.lines) : null;
  // The server's check of the phone's total runs on NUMERIC (MNY-15).
  const checked = lines && (await client.query<{ total: string }>(`SELECT sum((line->>'count')::integer * (line->>'unitPrice')::numeric)::text AS total
    FROM jsonb_array_elements($1::jsonb) line`, [lines])).rows[0]?.total;
  // On the shop's list means what the phone's Stock shows: listed, with pack, product and category active.
  const listed = parsed.success && (await client.query(`SELECT 1 FROM shop_listings sl JOIN packs pk ON pk.id = sl.pack_id
      JOIN master_products p ON p.id = pk.product_id JOIN categories c ON c.id = p.category_id LEFT JOIN categories parent ON parent.id = c.parent_id
    WHERE sl.shop_id = $1 AND sl.pack_id = ANY($2::uuid[]) AND pk.active AND p.active AND p.published AND c.active AND COALESCE(parent.active, true)`,
  [bill.shopId, parsed.data.lines.map((line) => line.packId)])).rowCount === parsed.data.lines.length;
  const held = !parsed.success ? "invalid" : bill.tooOld ? "too_old" : listed ? null : "not_listed";

  const insert = (heldReason: string | null, number: number | null, clash: boolean) => client.query<Row>(`INSERT INTO counter_bills (shop_id, actor_id, client_id,
      reference, reference_clash, number, held_reason, invalid_payload, payment, total, checked_total, clock_suspect, made_at, received_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (shop_id, reference) WHERE NOT reference_clash DO NOTHING RETURNING ${billColumns}`,
  [bill.shopId, bill.accountId, bill.actionId, counterBillReference(bill.actionId), clash, number, heldReason,
    parsed.success ? null : JSON.stringify(payload ?? null), parsed.data?.payment ?? null, parsed.data?.total ?? null, checked ?? null,
    bill.clockSuspect, bill.madeAt, bill.receivedAt]);
  // A refused insert rolls its number back too, so the shop's numbers keep no gap (BIL-5).
  await client.query("SAVEPOINT counter_bill");
  const number = held ? null : (await client.query<{ number: number }>(`INSERT INTO counter_bill_numbers (shop_id, last_number) VALUES ($1, 1)
    ON CONFLICT (shop_id) DO UPDATE SET last_number = counter_bill_numbers.last_number + 1 RETURNING last_number AS number`, [bill.shopId])).rows[0]?.number ?? null;
  let row = (await insert(held, number, false)).rows[0];
  if (!row) {
    await client.query("ROLLBACK TO SAVEPOINT counter_bill");
    row = (await insert(held ?? "reference_taken", null, true)).rows[0];
  }
  await client.query("RELEASE SAVEPOINT counter_bill");
  if (!row) throw new Error("Counter bill insert returned no row");

  if (lines) {
    await client.query(`INSERT INTO counter_bill_lines (bill_id, position, pack_id, count, unit_price)
      SELECT $1, line.position, (line.value->>'packId')::uuid, (line.value->>'count')::integer, (line.value->>'unitPrice')::numeric
      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS line(value, position)`, [row.billId, lines]);
  }
  if (row.number !== null && !row.totalMismatch) {
    await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
      SELECT sl.id, $3, $4, 'sale', -(line.count * pk.quantity)
      FROM counter_bill_lines line JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = line.pack_id JOIN packs pk ON pk.id = line.pack_id
      WHERE line.bill_id = $2`, [bill.shopId, row.billId, bill.accountId, bill.actionId]);
  }
  return answer(row);
}
