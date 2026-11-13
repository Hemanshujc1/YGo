import { z } from "zod";
import { ShopState } from "./shops";
import { BillAmount, CounterBillName, PackQuantity, Phone, ShopPrice } from "./fields";
import { BaseUnitQuantity, SignedBaseUnitQuantity, OpeningStockResponse } from "./shop-listings";
import { CompleteDeliveryBody, FailDeliveryBody, OrderStatus, ProofExceptionBody } from "./orders";

/**
 * Explicit access result: only an authenticated absence/closure ends cached access.
 * `shopName` is kept with the phone's access record so a bill PDF can name the shop offline (#53); a Draft may have none yet.
 * `shopGstin` is the shop's GSTIN for the counter bill, kept the same way (#543); null when the shop has none, and when a reply or saved record predates it.
 * `limits` are the offline limits the server enforces (BIL-3, #642); a reply from before them reads as 500 actions and 72 hours.
 * `role` is the account's role in that shop, so the phone can hide what only the Owner does (#494); the server still enforces it.
 */
export const SyncLimits = z.strictObject({ maxActions: z.number().int().min(1).max(500), maxOfflineHours: z.number().int().min(1).max(24 * 30) });
export type SyncLimits = z.infer<typeof SyncLimits>;
/** The phone's fallback until the server has told it (BIL-3, #642). */
export const DEFAULT_SYNC_LIMITS: SyncLimits = { maxActions: 500, maxOfflineHours: 72 };
export const SyncAccessResponse = z.strictObject({ limits: SyncLimits.default(DEFAULT_SYNC_LIMITS), shopId: z.uuid().nullable(), state: ShopState.nullable(), shopName: z.string().nullable(), shopGstin: z.string().nullable().default(null), role: z.enum(["owner", "staff"]).nullable(), canDeliver: z.boolean().default(false) })
  .refine((value) => (value.shopId === null) === (value.state === null) && (value.shopId === null) === (value.role === null) && (value.shopId !== null || (value.shopName === null && value.shopGstin === null)));
export type SyncAccessResponse = z.infer<typeof SyncAccessResponse>;

export const OpeningStockPayload = z.strictObject({ packId: z.uuid(), quantity: BaseUnitQuantity });
export const StockFlagPayload = z.strictObject({ packId: z.uuid(), outOfStock: z.boolean() });
export const StockFlagResponse = z.strictObject({ listingId: z.uuid(), outOfStock: z.boolean(), recordedAt: z.iso.datetime() });
/** Why stock changed (BIL-7, CONTEXT.md): the fixed list every stock change takes. Damaged and expired only take stock away; counted sets the total. */
export const STOCK_CHANGE_REASONS = ["received", "counted", "damaged", "expired", "returned", "correction"] as const;
export const StockChangeReason = z.enum(STOCK_CHANGE_REASONS);
export type StockChangeReason = z.infer<typeof StockChangeReason>;
/**
 * One stock change from the phone, offline or not (#67). `quantity` is a signed change in base units; "counted" carries the total the shop counted
 * instead, and the server works the difference out against the latest on-hand figure, so two phones counting at once never overwrite each other.
 */
export const StockChangePayload = z.discriminatedUnion("reason", [
  z.strictObject({ packId: z.uuid(), reason: z.literal("counted"), total: BaseUnitQuantity }),
  z.strictObject({ packId: z.uuid(), reason: z.enum(["received", "returned", "correction"]), quantity: SignedBaseUnitQuantity })
    .refine((change) => Number(change.quantity) !== 0),
  z.strictObject({ packId: z.uuid(), reason: z.enum(["damaged", "expired"]), quantity: SignedBaseUnitQuantity })
    .refine((change) => Number(change.quantity) < 0),
]);
export type StockChangePayload = z.infer<typeof StockChangePayload>;
export const StockChangeResponse = z.strictObject({ listingId: z.uuid(), reason: StockChangeReason, change: SignedBaseUnitQuantity, onHand: SignedBaseUnitQuantity, recordedAt: z.iso.datetime() });
export type StockChangeResponse = z.infer<typeof StockChangeResponse>;
export const ShopStockResponse = z.strictObject({
  shopId: z.uuid(), state: z.enum(["live", "suspended"]), items: z.array(z.strictObject({
    listingId: z.uuid(), packId: z.uuid(), name: z.string(), packQuantity: PackQuantity,
    baseUnit: z.enum(["each", "kg", "l"]), quantity: SignedBaseUnitQuantity, held: BaseUnitQuantity, outOfStock: z.boolean(),
    // The price a counter bill charges for one pack, kept on the phone so billing works offline (#468).
    counterPrice: ShopPrice,
    // Some stock is left to sell but no more than the shop's low-stock level: the Stock list's "Low" word (#67). Out of stock is `outOfStock` or nothing left.
    lowStock: z.boolean().optional(),
  })),
});
export const StockCursor = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,18})$/);
export const SyncChangesQuery = z.strictObject({ since: StockCursor.optional() });
export type SyncChangesQuery = z.infer<typeof SyncChangesQuery>;
export const SyncChangesResponse = z.strictObject({
  shopId: z.uuid(), state: ShopStockResponse.shape.state, cursor: StockCursor,
  changes: z.array(z.strictObject({ packId: z.uuid(), item: ShopStockResponse.shape.items.element.nullable(), deletedAt: z.iso.datetime().nullable() })
    .refine((row) => row.item ? row.item.packId === row.packId && row.deletedAt === null : row.deletedAt !== null)),
}).refine((page) => page.cursor.startsWith(`${page.shopId}:`));
export type SyncChangesResponse = z.infer<typeof SyncChangesResponse>;
export type ShopStockResponse = z.infer<typeof ShopStockResponse>;
/**
 * A counter bill made on the phone (#51, BIL-1, BIL-9): whole packs only for now, each line at the unit price
 * the phone showed. Amounts are rupees with at most two decimals, so whole paise, like every money field.
 */
export const CounterBillLine = z.strictObject({ packId: z.uuid(), count: z.number().int().positive().max(9999), unitPrice: ShopPrice });
/** A line typed at the counter (#53, BIL-1): a name, a count and a unit price. It names no pack and moves no stock. */
export const CounterBillManualLine = z.strictObject({ name: CounterBillName, count: CounterBillLine.shape.count, unitPrice: ShopPrice });
/** Who the bill is for: a name, a phone, or both. The offers tick needs a phone to send them to. */
export const CounterBillCustomer = z.strictObject({ name: CounterBillName.optional(), phone: Phone.optional(), offers: z.boolean() })
  .refine((customer) => customer.name !== undefined || customer.phone !== undefined)
  .refine((customer) => !customer.offers || customer.phone !== undefined);
/**
 * `discount` is rupees taken off the lines' sum, and `total` is that sum less the discount (BIL-9). Both new
 * parts are left out of a bill that has none, so a bill queued before #53 is still valid.
 */
export const CounterBillPayload = z.strictObject({
  lines: z.array(CounterBillLine).max(100),
  manualLines: z.array(CounterBillManualLine).max(100).optional(),
  discount: BillAmount.optional(),
  customer: CounterBillCustomer.optional(),
  total: BillAmount,
  payment: z.enum(["cash", "upi"]),
}).refine((bill) => new Set(bill.lines.map((line) => line.packId)).size === bill.lines.length)
  .refine((bill) => bill.lines.length + (bill.manualLines?.length ?? 0) >= 1 && bill.lines.length + (bill.manualLines?.length ?? 0) <= 100);
export type CounterBillLine = z.infer<typeof CounterBillLine>;
export type CounterBillManualLine = z.infer<typeof CounterBillManualLine>;
export type CounterBillPayload = z.infer<typeof CounterBillPayload>;
/** Why the server kept a bill without a number; Admin resolves it (BIL-5). */
export const CounterBillHeldReason = z.enum(["reference_taken", "not_listed", "too_old", "too_large", "invalid"]);
export const CounterBillResponse = z.strictObject({
  billId: z.uuid(), reference: z.string().regex(/^[0-9A-F]{4}-[0-9A-F]{4}$/), number: z.number().int().positive().nullable(),
  heldReason: CounterBillHeldReason.nullable(), totalMismatch: z.boolean(), recordedAt: z.iso.datetime(),
}).refine((bill) => (bill.number === null) === (bill.heldReason !== null));
export type CounterBillResponse = z.infer<typeof CounterBillResponse>;

/** The permanent bill reference (BIL-5): the first eight hex digits of the bill's action id, "0F3A-91BC". */
export function counterBillReference(actionId: string): string {
  const hex = actionId.replaceAll("-", "").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/**
 * The deliverer's offline actions (#616, DLV-3). Each names the order and carries its online body; the photo is uploaded first and named by `photoUploadId`.
 * The server runs the same rules as the online routes when the phone reconnects, so a code is checked then, not on the phone.
 */
const DeliveryOrder = { orderId: z.uuid() };
export const DELIVERY_ACTION_TYPES = ["delivery_call_attempt", "delivery_complete", "delivery_proof_exception", "delivery_failed"] as const;
export const DeliveryCallAttemptPayload = z.strictObject(DeliveryOrder);
export const DeliveryCompletePayload = z.strictObject({ ...DeliveryOrder, ...CompleteDeliveryBody.shape });
export const DeliveryProofExceptionPayload = z.strictObject({ ...DeliveryOrder, ...ProofExceptionBody.shape });
export const DeliveryFailedPayload = z.strictObject({ ...DeliveryOrder, ...FailDeliveryBody.shape });
/** What a delivery action did: the order and where it now stands. */
export const DeliveryActionResponse = z.strictObject({ orderId: z.uuid(), status: OrderStatus });
export type DeliveryActionResponse = z.infer<typeof DeliveryActionResponse>;

export const SyncAction = z.strictObject({
  id: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), shopId: z.uuid(),
  type: z.string().min(1).max(80), payload: z.unknown(), createdAt: z.iso.datetime(), clockSuspect: z.boolean(),
});
export const SyncActionsBody = z.strictObject({
  deviceId: z.uuid(), sentAt: z.iso.datetime(), actions: z.array(SyncAction).min(1).max(500),
});
export const SyncActionCode = z.enum([
  "VALIDATION_FAILED", "NOT_FOUND", "SHOP_LISTING_NOT_READY", "OPENING_STOCK_ALREADY_RECORDED",
  "OPENING_STOCK_NOT_RECORDED", "ACTION_TOO_OLD", "SEQUENCE_MISSING", "ACTION_CONFLICT", "SHOP_NOT_BILLING",
  // Delivery actions (#616): a refusal leaves the order where it was and is shown to the shop and Admin.
  "ORDER_STATUS_CHANGED", "HANDOVER_CODE_WRONG", "HANDOVER_CODE_LOCKED", "DELIVERY_PHOTO_INVALID", "ITEM_CHECK_WAIT",
  "PROOF_EXCEPTION_CALL_REQUIRED", "DELIVERY_FAILURE_CALL_REQUIRED", "DELIVERY_FAILURE_WAIT", "DELIVERY_CLOCK_SUSPECT", "UNAVAILABLE",
]);
export type SyncActionCode = z.infer<typeof SyncActionCode>;
export const SyncActionResult = z.strictObject({
  actionId: z.uuid(), sequence: z.number().int().positive(), status: z.enum(["applied", "rejected", "retry"]),
  code: SyncActionCode.nullable(), result: z.union([OpeningStockResponse, StockFlagResponse, StockChangeResponse, CounterBillResponse, DeliveryActionResponse]).nullable(), clockSuspect: z.boolean(),
}).refine((row) => row.status === "applied" ? row.code === null && row.result !== null : row.code !== null && row.result === null);
export const SyncActionsResponse = z.strictObject({ results: z.array(SyncActionResult) });
export type SyncAction = z.infer<typeof SyncAction>;
export type SyncActionsBody = z.infer<typeof SyncActionsBody>;
export type SyncActionResult = z.infer<typeof SyncActionResult>;
export type SyncActionsResponse = z.infer<typeof SyncActionsResponse>;
