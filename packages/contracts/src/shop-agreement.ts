import { z } from "zod";
import { RateCardVersion } from "./fields";
import { CommissionRule, RateCardKey, RateCardValues } from "./rate-cards";

/**
 * The onboarding agreement's wording version (ONB-5, #362). The Shopkeeper
 * app's strings hold the text: change both together, and every Owner accepts again.
 */
export const AGREEMENT_VERSION = 1;
export const AgreementVersion = z.number().int().positive();

/** One category whose commission differs from the shop's own card, so the Owner sees what each line costs. */
export const CategoryCommission = z.strictObject({ categoryId: z.uuid(), name: z.string(), commission: CommissionRule });
export type CategoryCommission = z.infer<typeof CategoryCommission>;

export const ShopAgreementAcceptance = z.strictObject({
  agreementVersion: AgreementVersion,
  rateCardVersion: RateCardVersion,
  acceptedAt: z.iso.datetime(),
});
export type ShopAgreementAcceptance = z.infer<typeof ShopAgreementAcceptance>;

/**
 * GET /v1/me/shop-agreement, from Approved on (S19). `rateCardVersion` is the
 * newest publication that affects this shop: global, any category, or this
 * shop; "0" before any. `rateCard` is the shop's card (global, then shop);
 * `missing` names what keeps it incomplete. `current` is true when the last
 * acceptance names this agreement and this rate-card version.
 */
export const ShopAgreementResponse = z.strictObject({
  agreementVersion: AgreementVersion,
  rateCardVersion: z.union([z.literal("0"), RateCardVersion]),
  rateCard: RateCardValues,
  missing: z.array(RateCardKey),
  categoryCommissions: z.array(CategoryCommission),
  accepted: ShopAgreementAcceptance.nullable(),
  current: z.boolean(),
});
export type ShopAgreementResponse = z.infer<typeof ShopAgreementResponse>;

/** POST /v1/me/shop-agreement: the versions the Owner read; the server refuses any that is no longer current. */
export const AcceptShopAgreementBody = z.strictObject({ agreementVersion: AgreementVersion, rateCardVersion: RateCardVersion });
export type AcceptShopAgreementBody = z.infer<typeof AcceptShopAgreementBody>;
