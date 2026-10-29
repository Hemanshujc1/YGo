import { z } from "zod";
import { ProductBaseUnit } from "./catalog";
import { ShopPrice } from "./fields";
import { Amount, LineCount } from "./pricing";

/** `GET` and `PUT /v1/carts/:shopId` take the feed's query: where the order would go (#405). */
export const CartParams = z.strictObject({ shopId: z.uuid() });
export type CartParams = z.infer<typeof CartParams>;

/**
 * The whole cart: each pack once, with how many. `revision` is the one the phone last saw;
 * a save based on an older one is refused with CART_CHANGED (owner's clarification 1 on #50).
 */
export const SaveCartBody = z.strictObject({
  revision: z.number().int().min(0),
  lines: z.array(z.strictObject({ listingId: z.uuid(), count: LineCount })).max(100)
    .refine((lines) => new Set(lines.map((line) => line.listingId)).size === lines.length),
});
export type SaveCartBody = z.infer<typeof SaveCartBody>;

/** One pack in the cart; only an `orderable` line is priced. */
export const CartLine = z.strictObject({
  listingId: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  /** The pack size in the product's base unit, such as "0.5" kg. */
  quantity: z.string(),
  price: ShopPrice,
  count: LineCount,
  /** `unavailable`: the shop no longer sells it; `outOfStock`: not one pack left. */
  state: z.enum(["orderable", "outOfStock", "unavailable"]),
  /** Packs left when the count is held at stock; null otherwise. */
  left: z.number().int().positive().nullable(),
  /** From the pricing engine; null for a line that isn't priced. */
  lineTotal: Amount.nullable(),
});
export type CartLine = z.infer<typeof CartLine>;

/** What the Customer pays, every fee named; commission and the shop's and platform's shares never leave the server (FR-CRT-05). */
export const CartQuote = z.strictObject({
  productValue: Amount,
  deliveryFee: Amount,
  /** Null when the cart is not below the small-cart threshold. */
  smallCartFee: Amount.nullable(),
  total: Amount,
});
export type CartQuote = z.infer<typeof CartQuote>;

/** Why the cart can't be ordered yet (CRT-4); the contribution floor names no figure (owner's answer 7 on #50). */
export const CartReason = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("NOT_DELIVERING") }),
  z.strictObject({ code: z.literal("SHOP_CLOSED"), opensAt: z.iso.datetime().nullable() }),
  z.strictObject({ code: z.literal("LINE_UNAVAILABLE") }),
  z.strictObject({ code: z.literal("BELOW_MINIMUM_CART"), shortfall: Amount }),
  z.strictObject({ code: z.literal("BELOW_CONTRIBUTION_FLOOR") }),
]);
export type CartReason = z.infer<typeof CartReason>;

export const CartResponse = z.strictObject({
  shop: z.strictObject({ id: z.uuid(), name: z.string() }),
  /** 0 before the first save. */
  revision: z.number().int().min(0),
  lines: z.array(CartLine),
  /** Null when nothing is priced: an empty cart, no orderable line, or a shop that can't deliver here. */
  quote: CartQuote.nullable(),
  /** True only with a quote and no reason. */
  placeable: z.boolean(),
  reasons: z.array(CartReason),
});
export type CartResponse = z.infer<typeof CartResponse>;
