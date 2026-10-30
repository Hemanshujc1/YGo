import type { RateCardKey, RateCardValues } from "@ygo/contracts";
import { formatMoney, formatNumber } from "@ygo/format";
import { strings } from "../strings";

type Commission = NonNullable<RateCardValues["commission"]>;
type Split = NonNullable<RateCardValues["deliveryFee"]>["split"];

const words = strings.agreement;
// Display only: the server keeps every amount exact, and this only shows it (ADR-0004).
const money = (amount: string) => formatMoney(Number(amount));
const percent = (value: string) => `${formatNumber(Number(value))}%`;
const split = (shares: Split) => words.split(percent(shares.platformPercentage), percent(shares.shopPercentage));

/** A commission rule in words, such as "10% of each item line, at least ₹2". */
export function commissionText(rule: Commission): string {
  const fixed = money(rule.fixedAmount ?? "0");
  const share = percent(rule.percentage ?? "0");
  const main = rule.formula === "fixed" ? words.commission.fixed(fixed)
    : (rule.formula === "percentage" ? words.commission.percentage(share) : words.commission[rule.formula](fixed, share))
      + (rule.base === "after_shop_discount" ? ` ${words.commission.afterDiscount}` : "");
  const bounds = [rule.minimum && words.commission.minimum(money(rule.minimum)), rule.maximum && words.commission.maximum(money(rule.maximum))];
  return [main, ...bounds].filter(Boolean).join(", ");
}

/** Each value on the card, in the rate-card order, as a label and its words. A switched-off rule is left out. */
export function rateCardLines(card: RateCardValues): { key: RateCardKey; label: string; value: string }[] {
  const lines: { key: RateCardKey; value: string | undefined }[] = [
    { key: "commission", value: card.commission && commissionText(card.commission) },
    { key: "deliveryFee", value: card.deliveryFee && words.deliveryFee(money(card.deliveryFee.amount), split(card.deliveryFee.split)) },
    { key: "smallCartFee", value: card.smallCartFee?.enabled ? [
      words.smallCartFee(money(card.smallCartFee.amount), money(card.smallCartFee.threshold), split(card.smallCartFee.split)),
      card.smallCartFee.cap && words.smallCartCap(money(card.smallCartFee.cap)),
    ].filter(Boolean).join(" ") : undefined },
    { key: "deliveredContributionFloor", value: card.deliveredContributionFloor && money(card.deliveredContributionFloor) },
    { key: "minimumCart", value: card.minimumCart && money(card.minimumCart) },
    { key: "pickup", value: card.pickup?.enabled ? [
      words.pickup(money(card.pickup.customerFee)),
      card.pickup.shopFee && words.pickupShop(money(card.pickup.shopFee)),
      card.pickup.contributionFloor && words.pickupFloor(money(card.pickup.contributionFloor)),
    ].filter(Boolean).join(" ") : undefined },
    { key: "statementGraceDays", value: card.statementGraceDays === undefined ? undefined : words.days(card.statementGraceDays) },
    { key: "balanceLimit", value: card.balanceLimit && money(card.balanceLimit) },
    { key: "bargainMinimumCommission", value: card.bargainMinimumCommission && money(card.bargainMinimumCommission) },
    { key: "maximumShopDiscountPercentage", value: card.maximumShopDiscountPercentage && percent(card.maximumShopDiscountPercentage) },
  ];
  return lines.flatMap(({ key, value }) => value ? [{ key, label: words.labels[key as keyof typeof words.labels], value }] : []);
}
