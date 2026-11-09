import { z } from "zod";
import { RatePercentage, ShopPrice } from "./fields";

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

/** S34: the shop's one rule (null before the first save) and the maximum effective percentage it is held to now. */
export const ShopDiscountResponse = z.strictObject({ rule: ShopDiscountRule.nullable(), maximumPercentage: z.string() });
export type ShopDiscountResponse = z.infer<typeof ShopDiscountResponse>;

/** The default maximum effective shop-funded discount percentage, used until a rate card sets one (MNY-5). */
export const DEFAULT_MAXIMUM_SHOP_DISCOUNT_PERCENTAGE = "20";
