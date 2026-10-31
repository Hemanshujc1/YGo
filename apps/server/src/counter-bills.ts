import { counterBillReference, type CounterBillPayload, type CounterBillResponse } from "@ygo/contracts";
import type { PoolClient } from "pg";
import { catalogSql } from "./routes/shop-listings";

type Bill = {
  accountId: string; shopId: string; actionId: string; madeAt: string; receivedAt: Date;
  /** Older than the server's limit: kept, but held for Admin (BIL-5). */
  tooOld: boolean; clockSuspect: boolean;
};

type Row = { billId: string; reference: string; number: number | null; heldReason: CounterBillResponse["heldReason"]; totalMismatch: boolean; recordedAt: Date };

const billColumns = `id AS "billId", reference, number, held_reason AS "heldReason", total_mismatch AS "totalMismatch", received_at AS "recordedAt"`;
const answer = ({ recordedAt, ...row }: Row): CounterBillResponse => ({ ...row, recordedAt: recordedAt.toISOString() });

/**
 * Records one counter bill (#51) inside the sync transaction, which holds the shop's row lock.
 *
 * A bill that can be applied as recorded gets the shop's next number and one `sale` movement per line. Stock
 * may go negative (BIL-4). A bill whose pack has left the shop's list, or which is older than the server's
 * limit, is kept with no number and moves no stock (BIL-5). So is a bill whose reference another bill already
 * has: the unique index refuses it, and it is kept beside the first, held. A total that differs from the
 * server's sum still gets its number, but moves no stock until Admin looks at it (owner's answer on #51).
 */
export async function applyCounterBill(client: PoolClient, bill: Bill, payload: CounterBillPayload): Promise<CounterBillResponse> {
  // The same action id can only reach here again through a phone bug; it still gets its first answer.
  const saved = await client.query<Row>(`SELECT ${billColumns} FROM counter_bills WHERE shop_id = $1 AND client_id = $2`, [bill.shopId, bill.actionId]);
  if (saved.rows[0]) return answer(saved.rows[0]);
  const lines = JSON.stringify(payload.lines);
  // The server's check of the phone's total runs on NUMERIC (MNY-15).
  const { rows: [checked] } = await client.query<{ total: string }>(`SELECT sum((line->>'count')::integer * (line->>'unitPrice')::numeric)::text AS total
    FROM jsonb_array_elements($1::jsonb) line`, [lines]);
  const listed = await client.query(`SELECT 1 FROM (${catalogSql} AND sl.id IS NOT NULL AND pk.id = ANY($2::uuid[])) listed`,
    [bill.shopId, payload.lines.map((line) => line.packId)]);
  const held = bill.tooOld ? "too_old" : listed.rowCount === payload.lines.length ? null : "not_listed";

  const insert = (heldReason: string | null, number: number | null) => client.query<Row>(`INSERT INTO counter_bills
      (shop_id, actor_id, client_id, reference, number, held_reason, payment, total, checked_total, clock_suspect, made_at, received_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (shop_id, reference) WHERE held_reason IS DISTINCT FROM 'reference_taken' DO NOTHING RETURNING ${billColumns}`,
  [bill.shopId, bill.accountId, bill.actionId, counterBillReference(bill.actionId), number, heldReason, payload.payment,
    payload.total, checked?.total, bill.clockSuspect, bill.madeAt, bill.receivedAt]);
  // A refused insert rolls its number back too, so the shop's numbers keep no gap (BIL-5).
  await client.query("SAVEPOINT counter_bill");
  const number = held ? null : (await client.query<{ number: number }>(`INSERT INTO counter_bill_numbers (shop_id, last_number) VALUES ($1, 1)
    ON CONFLICT (shop_id) DO UPDATE SET last_number = counter_bill_numbers.last_number + 1 RETURNING last_number AS number`, [bill.shopId])).rows[0]?.number ?? null;
  let row = (await insert(held, number)).rows[0];
  if (row) await client.query("RELEASE SAVEPOINT counter_bill");
  else {
    await client.query("ROLLBACK TO SAVEPOINT counter_bill");
    row = (await insert("reference_taken", null)).rows[0];
  }
  if (!row) throw new Error("Counter bill insert returned no row");

  await client.query(`INSERT INTO counter_bill_lines (bill_id, position, pack_id, count, unit_price)
    SELECT $1, line.position, (line.value->>'packId')::uuid, (line.value->>'count')::integer, (line.value->>'unitPrice')::numeric
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS line(value, position)`, [row.billId, lines]);
  if (row.number !== null && !row.totalMismatch) {
    await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
      SELECT sl.id, $3, $4, 'sale', -(line.count * pk.quantity)
      FROM counter_bill_lines line JOIN shop_listings sl ON sl.shop_id = $1 AND sl.pack_id = line.pack_id JOIN packs pk ON pk.id = line.pack_id
      WHERE line.bill_id = $2`, [bill.shopId, row.billId, bill.accountId, bill.actionId]);
  }
  return answer(row);
}
