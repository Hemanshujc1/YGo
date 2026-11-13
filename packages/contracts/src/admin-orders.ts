import { z } from "zod";
import { AdminActionReason } from "./fields";
import { Fulfilment, OfflineDeliveryIssue, OrderStatus } from "./orders";
import { Amount, PricedQuote } from "./pricing";

const cursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/**
 * The statuses Admin may force an order into (ADM-4, ORD-1, #66). Every one closes an order: forcing never moves one forward and
 * never skips what a forward move needs (the shop's stock check, a deliverer, the handover code, payment or the customer's answer).
 */
export const ForcedOrderStatus = z.enum(["rejected_by_shop", "expired", "cancelled_by_shop", "not_collected", "delivery_failed"]);
export type ForcedOrderStatus = z.infer<typeof ForcedOrderStatus>;

/** What A14 shows: the in-flight orders, the ones nobody has answered for 120 s, or the ones already closed. */
export const AdminOrderGroup = z.enum(["active", "unanswered", "final", "all"]);
export type AdminOrderGroup = z.infer<typeof AdminOrderGroup>;

/** `GET /v1/admin/orders` (A14, ADM-4, ADM-7, #66). Newest placed first; the cursor is `placed_at` to the microsecond, then the order id. */
export const AdminOrdersQuery = z.strictObject({
  group: AdminOrderGroup.default("active"),
  shopId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursor.optional(),
});
export type AdminOrdersQuery = z.infer<typeof AdminOrdersQuery>;

export const AdminOrderRow = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  shopId: z.uuid(),
  shopName: z.string(),
  customerName: z.string().nullable(),
  fulfilment: Fulfilment,
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  statusChangedAt: z.iso.datetime(),
  total: Amount,
  /** Seconds in the current status, by the server's clock. */
  statusAgeSeconds: z.number().int().nonnegative(),
  /** Still placed after `unansweredAfterSeconds` (ADM-7), by the server's clock. */
  unanswered: z.boolean(),
  cursor: z.string(),
});
export type AdminOrderRow = z.infer<typeof AdminOrderRow>;

export const AdminOrdersResponse = z.strictObject({
  orders: z.array(AdminOrderRow),
  nextCursor: z.string().nullable(),
  /** Over every order in scope, not just this page. */
  counts: z.strictObject({ active: z.number().int().nonnegative(), unanswered: z.number().int().nonnegative() }),
  serverTime: z.iso.datetime(),
  unansweredAfterSeconds: z.number().int().positive(),
});
export type AdminOrdersResponse = z.infer<typeof AdminOrdersResponse>;

export const AdminOrderBreakdown = PricedQuote.pick({ rateCardVersion: true, sources: true, commission: true, deliveryFee: true, smallCartFee: true, shopKeeps: true, platformContribution: true, reasons: true });

export const AdminOrderDetail = z.strictObject({
  order: AdminOrderRow.omit({ cursor: true }),
  /** Lines and money exactly as frozen at placement (MNY-7). */
  lines: z.array(z.strictObject({
    name: z.string(),
    brand: z.string().nullable(),
    count: z.number().int().positive(),
    partQuantity: z.string().nullable(),
    packQuantity: z.string(),
    baseUnit: z.string(),
    unitPrice: Amount,
    lineTotal: Amount,
  })),
  money: z.strictObject({
    productValue: Amount,
    shopDiscount: Amount,
    /** What the shop paid and what the platform paid of the order's coupon, apart (MNY-6, #70). */
    shopCoupon: Amount,
    platformCoupon: Amount,
    deliveryFee: Amount,
    smallCartFee: Amount.nullable(),
    pickupFee: Amount.nullable(),
    total: Amount,
  }),
  /** The pricing engine's result stored with the order, which the Customer never sees. Null when the stored quote is not in today's shape (an older order): A15 then shows the frozen money alone. */
  breakdown: AdminOrderBreakdown.nullable(),
  timeline: z.array(z.strictObject({
    at: z.iso.datetime(),
    from: OrderStatus.nullable(),
    to: OrderStatus,
    actorRole: z.enum(["customer", "owner", "staff", "admin", "system"]),
    actorName: z.string().nullable(),
    reasonCode: z.string().nullable(),
  })),
  /** Each forced transition and the Admin's own reason, from the audit record (ADM-4). Empty for an Area Manager. */
  /** Offline delivery actions the server refused or held, oldest first: A15 settles them with a forced move (#616). */
  offlineDeliveryIssues: z.array(OfflineDeliveryIssue).optional(),
  forcedActions: z.array(z.strictObject({
    at: z.iso.datetime(),
    adminName: z.string().nullable(),
    from: OrderStatus,
    to: OrderStatus,
    reason: AdminActionReason,
  })),
  people: z.strictObject({ customerName: z.string().nullable(), delivererName: z.string().nullable() }),
  /** The moves the modal offers: empty for a final order, and for an Area Manager, who only looks (ADM-12). */
  forcedMoves: z.array(ForcedOrderStatus),
});
export type AdminOrderDetail = z.infer<typeof AdminOrderDetail>;

/**
 * `POST /v1/admin/orders/:id/force-transition` (A15, ADM-4). `from` is the status A15 showed: a different current status is ORDER_STATUS_CHANGED.
 * The reason is trimmed and kept in the audit record.
 */
export const ForceTransitionBody = z.strictObject({ from: OrderStatus, to: ForcedOrderStatus, reason: AdminActionReason });
export type ForceTransitionBody = z.infer<typeof ForceTransitionBody>;
