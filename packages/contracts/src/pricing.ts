import { z } from "zod";
import { RateCardKey, RateCardScope, RateCardSource, RateCardValues } from "./rate-cards";
import { PackQuantity, RateCardVersion, ShopPrice } from "./fields";
import { CouponCode, CouponReason } from "./coupons";

export const LineCount = z.number().int().min(1).max(999);

/** A pack at its online price, or one of the shop's quantity-price options, bought `count` times (CAT-2). */
export const QuoteLine = z.union([
  z.strictObject({ listingId: z.uuid(), count: LineCount }),
  z.strictObject({ quantityOptionId: z.uuid(), count: LineCount }),
]);
export type QuoteLine = z.infer<typeof QuoteLine>;

/** An unsaved rule shaped like a publish: tried as if it were published next (#357). */
export const RateCardDraft = z.strictObject({ scope: RateCardScope, values: RateCardValues });
export type RateCardDraft = z.infer<typeof RateCardDraft>;

export const PriceSimulatorBody = z.strictObject({
  shopId: z.uuid(),
  lines: z.array(QuoteLine).min(1).max(100),
  draft: RateCardDraft.optional(),
  /** A saved coupon to try on this basket, by its code (ADM-5, MNY-10); the quote says whether it applied and, if not, why. */
  couponCode: CouponCode.optional(),
});
export type PriceSimulatorBody = z.infer<typeof PriceSimulatorBody>;

/** Rupees with exactly two decimals, as the SQL engine writes them; what the shop keeps can go below zero. */
export const Amount = z.string().regex(/^-?\d+\.\d{2}$/);
const SplitFee = z.strictObject({ amount: Amount, platformShare: Amount, shopShare: Amount });

/** The coupon on a cart: what it took off when it applied, or why it did not. Never says who pays (MNY-11). */
export const AppliedCoupon = z.strictObject({
  code: z.string(),
  applied: z.boolean(),
  amount: Amount,
  reason: CouponReason.nullable(),
});
export type AppliedCoupon = z.infer<typeof AppliedCoupon>;

/** A coupon this cart could take now, with what it would take off; ones that cannot apply are left out (FR-CRT-07). */
export const CartCouponsResponse = z.strictObject({
  coupons: z.array(z.strictObject({ id: z.uuid(), code: z.string(), amount: Amount })),
});
export type CartCouponsResponse = z.infer<typeof CartCouponsResponse>;

/** What the pricing engine did with the coupon, with the funding amounts kept apart (MNY-6). */
export const QuotedCoupon = z.strictObject({
  couponId: z.uuid(),
  couponVersion: z.number().int().positive(),
  code: z.string(),
  funding: z.enum(["platform", "shop"]),
  applied: z.boolean(),
  /** Null when it applied; otherwise why not. */
  reason: CouponReason.nullable(),
  shopFunded: Amount,
  platformFunded: Amount,
});
export type QuotedCoupon = z.infer<typeof QuotedCoupon>;

export const QuoteReasonCode = z.enum(["BELOW_MINIMUM_CART", "BELOW_CONTRIBUTION_FLOOR"]);
export const QuoteReason = z.strictObject({ code: QuoteReasonCode, shortfall: Amount });

export const PricedQuote = z.strictObject({
  status: z.literal("priced"),
  rateCardVersion: RateCardVersion,
  lines: z.array(z.strictObject({
    listingId: z.uuid(),
    quantityOptionId: z.uuid().nullable(),
    categoryId: z.uuid(),
    unitPrice: Amount,
    count: LineCount,
    lineTotal: Amount,
    commission: Amount,
    commissionSource: RateCardSource,
    /** This line's part of the shop-funded discount, in whole paise; the parts add up to the order's (MNY-6). */
    shopDiscount: Amount,
  })),
  /** Order-level values come from shop and global cards only; a category card's minimum cart or floor is ignored (#357). */
  sources: z.partialRecord(RateCardKey, RateCardSource),
  /** Before any discount, fees and taxes. */
  productValue: Amount,
  /** The shop-funded discount and the rule it came from, or null when none applied. A coupon's funding amounts are in `coupon`, never added here (MNY-6). */
  shopDiscount: z.strictObject({ amount: Amount, ruleId: z.uuid(), ruleVersion: z.number().int().positive() }).nullable(),
  /** The coupon the quote was asked to apply and what became of it; null when none was asked (#70). Never beside a shop-wide discount (D-7). */
  coupon: QuotedCoupon.nullable().optional(),
  commission: Amount,
  deliveryFee: SplitFee,
  /** Null when the basket is not below an enabled small-cart threshold. */
  smallCartFee: SplitFee.nullable(),
  customerTotal: Amount,
  /** What remains with the shop after what it owes YGo, never its profit (MNY-11). */
  shopKeeps: Amount,
  platformContribution: Amount,
  placeable: z.boolean(),
  reasons: z.array(QuoteReason),
});
export type PricedQuote = z.infer<typeof PricedQuote>;

/** The rate card lacks a value the delivered quote needs. */
export const IncompleteQuote = z.strictObject({
  status: z.literal("incomplete"),
  rateCardVersion: z.union([z.literal("0"), RateCardVersion]),
  missing: z.array(RateCardKey),
});

export const DeliveredQuote = z.discriminatedUnion("status", [PricedQuote, IncompleteQuote]);
export type DeliveredQuote = z.infer<typeof DeliveredQuote>;

export const PriceSimulatorResponse = z.strictObject({ now: DeliveredQuote, draft: DeliveredQuote.nullable() });
export type PriceSimulatorResponse = z.infer<typeof PriceSimulatorResponse>;

export const SimulatorListingsParams = z.strictObject({ id: z.uuid() });
export type SimulatorListingsParams = z.infer<typeof SimulatorListingsParams>;

/** A pack the shop lists, at its online price, with the quantity-price options a basket line can name instead (#358). */
export const SimulatorListing = z.strictObject({
  listingId: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: z.enum(["each", "kg", "l"]),
  packQuantity: PackQuantity,
  onlinePrice: ShopPrice,
  quantityOptions: z.array(z.strictObject({ id: z.uuid(), name: z.string(), quantity: PackQuantity, price: ShopPrice })),
});
export type SimulatorListing = z.infer<typeof SimulatorListing>;

export const SimulatorListingsResponse = z.strictObject({ listings: z.array(SimulatorListing) });
export type SimulatorListingsResponse = z.infer<typeof SimulatorListingsResponse>;
