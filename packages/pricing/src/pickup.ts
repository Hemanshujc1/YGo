import { fromPaise, toPaise } from "./paise";

/** The pickup rule of a rate card (MNY-3, FUL-7): the booking fees, ships disabled, and the contribution floor of the pickup route alone (MNY-4). */
export type PickupRuleAmounts = {
  /** Whether the booking fees apply at all. Off, a pickup earns the platform nothing. */
  enabled: boolean;
  customerFee: string;
  shopFee: string | null;
  /** The most the customer's booking fee can be; null for no cap. */
  cap: string | null;
  contributionFloor: string;
};

export type PickupPrice = {
  /** The customer's booking fee inside `total`, charged only when the pickup is completed; "0.00" when none. */
  pickupFee: string;
  /** The fixed fee the shop is charged on completion; "0.00" when none. */
  shopFee: string;
  /** What the customer pays at the counter: the product value less any discount, plus the booking fee. */
  total: string;
  /** The platform's earnings from the order: both booking fees. A pickup earns no product commission (MNY-2). */
  contribution: string;
  /** What `contribution` falls short of the pickup floor by, or null when it meets it. */
  shortfall: string | null;
};

/**
 * Prices a self-pickup in integer paise (ADR-0007): no delivery fee and no commission, a booking fee only where the card has one on, and the
 * result tested against the pickup floor, never the delivered one (FUL-7, MNY-2, MNY-4). The customer's fee is held to the cap; the shop's is fixed.
 * `productValue` and `shopDiscount` are rupees with at most two decimals, as the pricing engine returns them.
 */
export function pickupPrice({ productValue, shopDiscount, rule }: { productValue: string; shopDiscount: string; rule: PickupRuleAmounts }): PickupPrice {
  const customerPaise = !rule.enabled ? 0n : rule.cap === null ? toPaise(rule.customerFee) : min(toPaise(rule.customerFee), toPaise(rule.cap));
  const shopPaise = rule.enabled && rule.shopFee !== null ? toPaise(rule.shopFee) : 0n;
  const contribution = customerPaise + shopPaise;
  const floor = toPaise(rule.contributionFloor);
  return {
    pickupFee: fromPaise(customerPaise),
    shopFee: fromPaise(shopPaise),
    total: fromPaise(toPaise(productValue) - toPaise(shopDiscount) + customerPaise),
    contribution: fromPaise(contribution),
    shortfall: contribution < floor ? fromPaise(floor - contribution) : null,
  };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
