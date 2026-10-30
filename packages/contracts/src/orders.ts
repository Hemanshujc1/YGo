import { z } from "zod";
import { AddressLabel } from "./addresses";
import { ProductBaseUnit } from "./catalog";
import { Amount, LineCount } from "./pricing";

/** Every status an order can be in (#9); the terminal ones end it. */
export const OrderStatus = z.enum([
  "placed", "scheduled_pending_review", "awaiting_customer_confirm", "accepted", "scheduled_confirmed",
  "preparing", "ready", "out_for_delivery", "arrived",
  "delivered", "picked_up", "rejected_by_shop", "expired", "not_collected", "cancelled_by_customer", "cancelled_by_shop", "delivery_failed",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "delivered", "picked_up", "rejected_by_shop", "expired", "not_collected", "cancelled_by_customer", "cancelled_by_shop", "delivery_failed",
];

/**
 * `POST /v1/carts/:shopId/order` (#424): places the cart for delivery to a saved address with a pin.
 * `revision` and `total` are what C07 showed; either differing from the server's fresh quote is CART_CHANGED (CRT-2).
 */
export const PlaceOrderBody = z.strictObject({ revision: z.number().int().min(1), total: Amount, addressId: z.uuid() });
export type PlaceOrderBody = z.infer<typeof PlaceOrderBody>;

export const OrderParams = z.strictObject({ id: z.uuid() });
export type OrderParams = z.infer<typeof OrderParams>;

/** S05's fixed Reject list (#425); each app words them in its own strings. */
export const RejectReason = z.enum(["out_of_stock", "too_busy", "closing_soon", "cannot_deliver"]);
export type RejectReason = z.infer<typeof RejectReason>;

/** A line as it was frozen at placement (MNY-7). */
export const OrderLine = z.strictObject({
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  /** The pack size in the product's base unit. */
  quantity: z.string(),
  count: LineCount,
  /** Set for the remainder of a pack (#377): the quantity bought, in the base unit. */
  part: z.string().nullable(),
  unitPrice: Amount,
  lineTotal: Amount,
});
export type OrderLine = z.infer<typeof OrderLine>;

/** C09 and C19. Paid in cash or UPI at the door, nothing before (MNY-1). */
export const OrderResponse = z.strictObject({
  id: z.uuid(),
  /** One running number for all shops, said on a phone call as "Order #1042". */
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  /** `phone` is the Owner's, for Call the shop (ORD-8); null when the Owner has none. */
  shop: z.strictObject({ id: z.uuid(), name: z.string(), phone: z.string().nullable() }),
  address: z.strictObject({ label: AddressLabel, flat: z.string(), areaLine: z.string().nullable(), pincode: z.string() }),
  lines: z.array(OrderLine),
  productValue: Amount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  total: Amount,
  /** Why the shop rejected it, shown on C19 in the Customer's own words (owner's answer 3 on #425); null otherwise. */
  rejectReason: RejectReason.nullable(),
  /**
   * Still placed, but past ORDER_ANSWER_SECONDS by the server's clock: the shop can no longer answer. Until #57 moves
   * such an order to Expired, C18 and C19 show "Shop did not answer" from this, and the status stays as stored (owner's answer 4 on #426).
   */
  answerExpired: z.boolean(),
});
export type OrderResponse = z.infer<typeof OrderResponse>;

/** A row on C18 (#426). */
export const OrderSummary = OrderResponse.pick({ id: true, number: true, status: true, placedAt: true, shop: true, total: true, answerExpired: true });
export type OrderSummary = z.infer<typeof OrderSummary>;

/**
 * `GET /v1/orders`, C18's two groups (owner's answers on #426).
 * - `active`: not final and not `answerExpired`. Those waiting on the Customer (awaiting_customer_confirm, arrived) first, then newest placed first.
 * - `past`: final or `answerExpired`, newest placed first, at most the newest 50.
 * Ties fall to the higher order number.
 */
export const OrdersResponse = z.strictObject({ active: z.array(OrderSummary), past: z.array(OrderSummary) });
export type OrdersResponse = z.infer<typeof OrdersResponse>;

/**
 * A placed order the shop hasn't answered expires this long after placement (ORD-2). Accept and Reject refuse
 * from this moment with ORDER_EXPIRED; #57's worker moves it to Expired. One value, so it can be changed in one place.
 */
export const ORDER_ANSWER_SECONDS = 600;

/** The statuses whose lines hold stock (#425): from Accept until the order leaves the shop's hands. */
export const STOCK_HOLDING_ORDER_STATUSES: readonly OrderStatus[] = ["accepted", "preparing", "ready", "out_for_delivery", "arrived"];

/** `POST /v1/me/shop-orders/:id/reject`. */
export const RejectOrderBody = z.strictObject({ reason: RejectReason });
export type RejectOrderBody = z.infer<typeof RejectOrderBody>;

/** A row on S04 (#425). `itemCount` is the number of distinct lines; `expiresAt` is set only while the order is placed. */
export const ShopOrderSummary = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  itemCount: z.number().int().positive(),
  total: Amount,
  address: z.strictObject({ flat: z.string(), areaLine: z.string().nullable() }),
});
export type ShopOrderSummary = z.infer<typeof ShopOrderSummary>;

/**
 * `GET /v1/me/shop-orders`, S04's three groups. `now` is the server's clock, so a countdown is
 * `expiresAt - now` and doesn't depend on the phone's own clock.
 * - `new`: placed orders still inside ORDER_ANSWER_SECONDS, oldest first.
 * - `accepted`: the STOCK_HOLDING_ORDER_STATUSES, oldest placed first.
 * - `doneToday`: final statuses whose last status change fell on today in India time, newest change first.
 */
export const ShopOrdersResponse = z.strictObject({
  now: z.iso.datetime(),
  new: z.array(ShopOrderSummary),
  accepted: z.array(ShopOrderSummary),
  doneToday: z.array(ShopOrderSummary),
});
export type ShopOrdersResponse = z.infer<typeof ShopOrdersResponse>;

/** S05: one of the shop's orders, as it was frozen. No Customer phone (owner's answer 11 on #425). */
export const ShopOrderResponse = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  now: z.iso.datetime(),
  address: z.strictObject({ label: AddressLabel, flat: z.string(), areaLine: z.string().nullable(), pincode: z.string() }),
  lines: z.array(OrderLine),
  productValue: Amount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  /** To collect at the door (MNY-1). */
  total: Amount,
  rejectReason: RejectReason.nullable(),
});
export type ShopOrderResponse = z.infer<typeof ShopOrderResponse>;

/**
 * A line Accept can't fill from the stock left (NOT_ENOUGH_STOCK). `available` is what is left in the base unit, never packs:
 * the app divides it by `quantity` and rounds down for a whole-pack line (3 kg of 2 kg packs is "Only 1 left of Toor Dal 2 kg"),
 * and shows it as is for a part line ("Only 300 g left of Toor Dal").
 */
export const ShortLine = OrderLine.pick({ name: true, brand: true, baseUnit: true, quantity: true, count: true, part: true })
  .extend({ available: z.string() });
export type ShortLine = z.infer<typeof ShortLine>;
