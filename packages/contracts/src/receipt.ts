import { z } from "zod";
import { AddressLabel } from "./addresses";
import { OrderLine } from "./orders";
import { Amount } from "./pricing";

/**
 * `GET /v1/orders/:id/receipt` (#61): what the shop's online receipt shows, as the order froze it. The Customer's app
 * makes the PDF. Only delivered and picked-up orders have one; any other status is ORDER_STATUS_CHANGED.
 * - `shop`: name, address, pincode and GSTIN as they were frozen on the order at placement (#537), so a later rename
 *   or address change doesn't alter it. `gstin` is null when the shop had none.
 * - `payment`: how it was paid, only when recorded (at delivery); null otherwise, never assumed.
 */
export const ReceiptResponse = z.strictObject({
  number: z.number().int().positive(),
  /** Only these two have a receipt; the PDF words the address "Delivered to" or "Order address" by it. */
  status: z.enum(["delivered", "picked_up"]),
  placedAt: z.iso.datetime(),
  shop: z.strictObject({ name: z.string(), address: z.string(), pincode: z.string(), gstin: z.string().nullable() }),
  /** Where it was delivered, as frozen: the label and area line only, never the Customer's phone. */
  address: z.strictObject({ label: AddressLabel, areaLine: z.string().nullable() }),
  lines: z.array(OrderLine),
  productValue: Amount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  total: Amount,
  payment: z.enum(["cash", "upi"]).nullable(),
});
export type ReceiptResponse = z.infer<typeof ReceiptResponse>;
