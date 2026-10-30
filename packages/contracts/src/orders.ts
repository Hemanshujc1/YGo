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
});
export type OrderResponse = z.infer<typeof OrderResponse>;
