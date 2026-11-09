import { z } from "zod";
import { RatePercentage, ShopPrice } from "./fields";
import { Amount } from "./pricing";

const positive = (value: string) => Number(value) > 0;

/**
 * The Owner's shop-wide discount (MNY-5): two forms and no other. A percentage with an optional cap in rupees,
 * or a flat amount with a required minimum order. `active` turns it on or off; the maximum effective percentage
 * is checked on the form's worst case at save, so a rule over it is never stored (#63).
 */
export const ShopDiscountBody = z.discriminatedUnion("form", [
  z.strictObject({ form: z.literal("percentage"), percentage: RatePercentage.refine(positive), cap: ShopPrice.refine(positive).nullable(), active: z.boolean() }),
  z.strictObject({ form: z.literal("flat"), amount: ShopPrice.refine(positive), minimumOrder: ShopPrice.refine(positive), active: z.boolean() }),
]);
export type ShopDiscountBody = z.infer<typeof ShopDiscountBody>;

/** `paused` is only ever set by YGo, when the maximum was lowered under the rule (NOT-6); the Owner saves it back under the maximum to turn it on. */
export const ShopDiscountStatus = z.enum(["active", "off", "paused"]);

export const ShopDiscountRule = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  form: z.enum(["percentage", "flat"]),
  percentage: z.string().nullable(),
  cap: z.string().nullable(),
  amount: z.string().nullable(),
  minimumOrder: z.string().nullable(),
  status: ShopDiscountStatus,
});
export type ShopDiscountRule = z.infer<typeof ShopDiscountRule>;

/**
 * S34: the shop's one rule (null before the first save), the maximum effective percentage it is held to now, and whether a rule may be
 * turned on yet. `available` stays false until customers see the discount in their cart, order and receipt (#571): until then a rule
 * can be saved off but not turned on, so no customer is charged a total that is not the sum of what they were shown.
 */
export const ShopDiscountResponse = z.strictObject({ rule: ShopDiscountRule.nullable(), maximumPercentage: z.string(), available: z.boolean() });
export type ShopDiscountResponse = z.infer<typeof ShopDiscountResponse>;

/** The default maximum effective shop-funded discount percentage, used until a rate card sets one (MNY-5). */
export const DEFAULT_MAXIMUM_SHOP_DISCOUNT_PERCENTAGE = "20";

/**
 * The offer a discount came from, exactly as the rule version that priced the order held it (frozen with the order: a later edit of the
 * rule never changes it). Numbers only; each app words them from its own strings (#571).
 */
export const ShopDiscountOffer = z.discriminatedUnion("form", [
  z.strictObject({ form: z.literal("percentage"), percentage: z.string(), cap: z.string().nullable() }),
  z.strictObject({ form: z.literal("flat"), amount: z.string(), minimumOrder: z.string() }),
]);
export type ShopDiscountOffer = z.infer<typeof ShopDiscountOffer>;

/** What the Customer sees on the cart, order and receipt: the amount taken off and the offer it came from. Null when no discount applied (CRT-5, MNY-6). */
export const AppliedShopDiscount = z.strictObject({ amount: Amount, offer: ShopDiscountOffer }).nullable();
export type AppliedShopDiscount = z.infer<typeof AppliedShopDiscount>;
