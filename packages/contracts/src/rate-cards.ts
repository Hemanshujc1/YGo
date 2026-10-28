import { z } from "zod";
import { AdminActionReason, percentageUnits, RatePercentage, ShopPrice } from "./fields";

export const RATE_CARD_KEYS = [
  "commission", "deliveryFee", "smallCartFee", "deliveredContributionFloor", "minimumCart",
  "pickup", "counterBillCharge", "statementGraceDays", "balanceLimit", "bargainMinimumCommission",
  "maximumShopDiscountPercentage",
] as const;
export const RateCardKey = z.enum(RATE_CARD_KEYS);
export type RateCardKey = z.infer<typeof RateCardKey>;

const OptionalMoney = ShopPrice.nullable().default(null);
export const CommissionRule = z.strictObject({
  formula: z.enum(["fixed", "percentage", "fixed_plus_percentage", "higher_of", "lower_of"]),
  fixedAmount: OptionalMoney,
  percentage: RatePercentage.nullable().default(null),
  minimum: OptionalMoney,
  maximum: OptionalMoney,
  base: z.enum(["before_shop_discount", "after_shop_discount"]),
}).refine((rule) => rule.formula === "percentage" || rule.fixedAmount !== null, { path: ["fixedAmount"] })
  .refine((rule) => rule.formula === "fixed" || rule.percentage !== null, { path: ["percentage"] });

export const FeeSplit = z.strictObject({
  platformPercentage: RatePercentage,
  shopPercentage: RatePercentage,
}).refine((split) => percentageUnits(split.platformPercentage) + percentageUnits(split.shopPercentage) === 1_000_000, { path: ["shopPercentage"] });

export const DeliveryFeeRule = z.strictObject({ amount: ShopPrice, split: FeeSplit });
export const SmallCartFeeRule = z.strictObject({
  enabled: z.boolean(), threshold: ShopPrice, amount: ShopPrice, cap: OptionalMoney, split: FeeSplit,
});
export const PickupRule = z.strictObject({
  enabled: z.boolean(), customerFee: ShopPrice, shopFee: OptionalMoney, cap: OptionalMoney,
  contributionFloor: ShopPrice.nullable().default(null),
});
export const CounterBillChargeRule = z.strictObject({ enabled: z.literal(false), amount: ShopPrice });

export const RateCardValues = z.strictObject({
  commission: CommissionRule.optional(),
  deliveryFee: DeliveryFeeRule.optional(),
  smallCartFee: SmallCartFeeRule.optional(),
  deliveredContributionFloor: ShopPrice.optional(),
  minimumCart: ShopPrice.optional(),
  pickup: PickupRule.optional(),
  counterBillCharge: CounterBillChargeRule.optional(),
  statementGraceDays: z.number().int().nonnegative().optional(),
  balanceLimit: ShopPrice.optional(),
  bargainMinimumCommission: ShopPrice.optional(),
  maximumShopDiscountPercentage: RatePercentage.optional(),
});
export type RateCardValues = z.infer<typeof RateCardValues>;

export const RateCardScope = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("global") }),
  z.strictObject({ type: z.literal("category"), id: z.uuid() }),
  z.strictObject({ type: z.literal("shop"), id: z.uuid() }),
]);
export type RateCardScope = z.infer<typeof RateCardScope>;

export const PublishRateCardBody = z.strictObject({ scope: RateCardScope, values: RateCardValues, reason: AdminActionReason });
export type PublishRateCardBody = z.infer<typeof PublishRateCardBody>;
export const ResolveRateCardQuery = z.strictObject({ shopId: z.uuid(), categoryId: z.uuid().optional(), version: z.coerce.number().int().positive().optional() });

export const RateCardSource = z.strictObject({ type: z.enum(["global", "category", "shop"]), id: z.uuid().nullable(), version: z.number().int().positive() });
export const EffectiveRateCardValue = z.strictObject({ value: z.unknown(), source: RateCardSource });
export const RateCardResponse = z.strictObject({
  version: z.number().int().nonnegative(),
  values: z.partialRecord(RateCardKey, EffectiveRateCardValue),
  missing: z.array(RateCardKey),
  complete: z.boolean(),
});
export type RateCardResponse = z.infer<typeof RateCardResponse>;
export const PublishedRateCardResponse = z.strictObject({ version: z.number().int().positive() });
export type PublishedRateCardResponse = z.infer<typeof PublishedRateCardResponse>;
