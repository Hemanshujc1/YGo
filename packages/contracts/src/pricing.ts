import { z } from "zod";
import { RateCardKey, RateCardScope, RateCardSource, RateCardValues } from "./rate-cards";
import { RateCardVersion } from "./fields";

const LineCount = z.number().int().min(1).max(999);

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
});
export type PriceSimulatorBody = z.infer<typeof PriceSimulatorBody>;

/** Rupees with exactly two decimals, as the SQL engine writes them. */
const Amount = z.string().regex(/^\d+\.\d{2}$/);
const SplitFee = z.strictObject({ amount: Amount, platformShare: Amount, shopShare: Amount });

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
  })),
  /** Order-level values come from shop and global cards only; a category card's minimum cart or floor is ignored (#357). */
  sources: z.partialRecord(RateCardKey, RateCardSource),
  productValue: Amount,
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
