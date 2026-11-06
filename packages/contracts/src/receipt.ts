import { z } from "zod";
import { AddressLabel } from "./addresses";
import { OrderLine } from "./orders";
import { Amount } from "./pricing";

/**
 * `GET /v1/orders/:id/receipt` (#61): what the shop's online receipt shows, as the order froze it. The Customer's app
 * makes the PDF. Only delivered and picked-up orders have one; any other status is ORDER_STATUS_CHANGED.
 * - `shop`: name and address as the shop holds them when the receipt is read, not as they were at placement (a later
 *   rename shows). There is no GSTIN yet, so none is shown.
 * - `payment`: how it was paid, only when recorded (at delivery); null otherwise, never assumed.
 */
export const ReceiptResponse = z.strictObject({
  number: z.number().int().positive(),
  placedAt: z.iso.datetime(),
  shop: z.strictObject({ name: z.string(), address: z.string(), pincode: z.string() }),
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
