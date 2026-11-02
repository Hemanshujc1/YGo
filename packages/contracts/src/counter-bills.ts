import { z } from "zod";
import { AdminActionReason } from "./fields";
import { CounterBillHeldReason } from "./sync";

/** Admin's screen of a shop's held and flagged counter bills (#470, BIL-5, BIL-9). */
export const AdminCounterBillParams = z.strictObject({ id: z.uuid(), billId: z.uuid() });
export type AdminCounterBillParams = z.infer<typeof AdminCounterBillParams>;

/**
 * - number: give a held bill the shop's next number. It moves its stock too, unless its reason is
 *   `too_large`, its pack has left the shop, or its total disagrees (BIL-9).
 * - duplicate: a `reference_taken` bill that is the same sale as the first, so it gets no number and no stock.
 * - review: close an `invalid` bill, or a numbered bill whose total disagrees, as looked at.
 * - note: add a note and leave the bill as it is.
 */
export const CounterBillResolutionAction = z.enum(["number", "duplicate", "review", "note"]);
export type CounterBillResolutionAction = z.infer<typeof CounterBillResolutionAction>;

export const ResolveCounterBillBody = z.strictObject({ action: CounterBillResolutionAction, note: AdminActionReason });
export type ResolveCounterBillBody = z.infer<typeof ResolveCounterBillBody>;

const BillLine = z.strictObject({
  packId: z.uuid(),
  /** Null when the pack is no longer in the catalog. */
  name: z.string().nullable(),
  packQuantity: z.string().nullable(),
  baseUnit: z.string().nullable(),
  count: z.number().int(),
  unitPrice: z.string(),
});

/** A line the shop typed at the counter (#53): no pack, so no stock moved. */
const ManualBillLine = z.strictObject({ name: z.string(), count: z.number().int(), unitPrice: z.string() });

export const CounterBillResolution = z.strictObject({
  action: z.enum(["numbered", "duplicate", "reviewed", "noted"]),
  note: z.string(),
  stockMoved: z.boolean(),
  actorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CounterBillResolution = z.infer<typeof CounterBillResolution>;

/** The first bill that holds a clashing reference, for Admin to compare with. */
export const CounterBillOriginal = z.strictObject({
  id: z.uuid(),
  number: z.number().int().nullable(),
  total: z.string().nullable(),
  payment: z.enum(["cash", "upi"]).nullable(),
  madeAt: z.iso.datetime(),
  lines: z.array(BillLine),
  manualLines: z.array(ManualBillLine),
  discount: z.string(),
});

export const AdminCounterBill = z.strictObject({
  id: z.uuid(),
  reference: z.string(),
  number: z.number().int().nullable(),
  heldReason: CounterBillHeldReason.nullable(),
  totalMismatch: z.boolean(),
  payment: z.enum(["cash", "upi"]).nullable(),
  /** The phone's total, which is the total on record. */
  total: z.string().nullable(),
  /** The server's own sum of the lines. */
  checkedTotal: z.string().nullable(),
  clockSuspect: z.boolean(),
  madeAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  /** Null once the person has left the shop. */
  madeBy: z.strictObject({ name: z.string().nullable(), role: z.enum(["owner", "staff"]).nullable() }),
  lines: z.array(BillLine),
  manualLines: z.array(ManualBillLine),
  /** Rupees the shop took off the lines' sum; the phone's total and the server's both come after it. */
  discount: z.string(),
  /** What the phone sent, as the JSON text it sent, for an `invalid` bill. */
  invalidPayload: z.string().nullable(),
  original: CounterBillOriginal.nullable(),
  /** True once an action other than a note has closed the bill. */
  resolved: z.boolean(),
  resolutions: z.array(CounterBillResolution),
});
export type AdminCounterBill = z.infer<typeof AdminCounterBill>;

export const AdminCounterBillsResponse = z.strictObject({ bills: z.array(AdminCounterBill) });
export type AdminCounterBillsResponse = z.infer<typeof AdminCounterBillsResponse>;

/** Why the Owner voids a counter bill (S37, BIL-6). Only `other` takes a typed note. */
export const CounterBillVoidReason = z.enum(["wrong_item", "wrong_price", "billed_twice", "not_taken", "other"]);
export type CounterBillVoidReason = z.infer<typeof CounterBillVoidReason>;

export const CounterBillParams = z.strictObject({ id: z.uuid() });
export type CounterBillParams = z.infer<typeof CounterBillParams>;

export const VoidCounterBillBody = z.discriminatedUnion("reason", [
  z.strictObject({ reason: CounterBillVoidReason.exclude(["other"]) }),
  z.strictObject({ reason: z.literal("other"), note: AdminActionReason }),
]);
export type VoidCounterBillBody = z.infer<typeof VoidCounterBillBody>;

/**
 * One of the shop's counter bills on S37 (#54). `voidable` is decided on the server's clock: the bill has its
 * number, is not voided, `voidUntil` has not passed, and the shop is Live or Suspended. A held bill has no number
 * and is never voidable. A bill the server could not read is held with no total or payment (BIL-5).
 */
export const ShopCounterBill = z.strictObject({
  id: z.uuid(),
  reference: z.string(),
  number: z.number().int().nullable(),
  total: z.string().nullable(),
  payment: z.enum(["cash", "upi"]).nullable(),
  madeAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  voidUntil: z.iso.datetime(),
  voidable: z.boolean(),
  voided: z.strictObject({ reason: CounterBillVoidReason, note: z.string().nullable(), createdAt: z.iso.datetime() }).nullable(),
});
export type ShopCounterBill = z.infer<typeof ShopCounterBill>;

export const ShopCounterBillsResponse = z.strictObject({ bills: z.array(ShopCounterBill) });
export type ShopCounterBillsResponse = z.infer<typeof ShopCounterBillsResponse>;
