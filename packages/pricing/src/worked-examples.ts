/**
 * The revenue specification's delivered-route scenarios, written once as inputs and expected amounts (Q-6).
 * The server's tests publish each example's cards, run its basket through the public price simulator
 * and compare every amount. The spec gives symbols only; these are concrete stand-ins chosen by #357.
 * The shop-wide discount scenarios (#63) set the shop's rule first; the coupon scenarios (#70) then name a coupon to try. At most one promotion applies (D-7).
 */

export type ExampleCard = {
  /** A category scope names one of the basket's category labels. */
  scope: { type: "global" } | { type: "shop" } | { type: "category"; category: string };
  values: Record<string, unknown>;
};

export type ExampleLine = {
  category: string;
  unitPrice: string;
  count: number;
  /** Bought as a quantity-price option of its listing, not as the pack itself (CAT-2). */
  quantityOption?: true;
};

/** The shop's one shop-wide discount rule (MNY-5), saved before the basket is priced. */
export type ExampleShopDiscount =
  | { form: "percentage"; percentage: string; cap?: string }
  | { form: "flat"; amount: string; minimumOrder: string };

/** A coupon saved before the basket is priced (CRT-3, #70). Shop-funded ones are the quoted shop's own. */
export type ExampleCoupon = { funding: "platform" | "shop" } & (
  | { form: "percentage"; percentage: string; cap?: string; minimumOrder?: string }
  | { form: "flat"; amount: string; minimumOrder?: string }
);

type Fee = { amount: string; platformShare: string; shopShare: string };

export type DeliveredExample = {
  name: string;
  cards: ExampleCard[];
  lines: ExampleLine[];
  shopDiscount?: ExampleShopDiscount;
  /** The coupon the quote is asked to try; its `expected.coupon` says whether it applied and the two funding amounts apart (MNY-6). */
  coupon?: ExampleCoupon;
  expected: {
    /** `shopDiscount` is each line's part in paise; the parts add up to the order's (MNY-6). */
    lines: Array<{ lineTotal: string; commission: string; shopDiscount?: string }>;
    productValue: string;
    /** The shop-wide discount's amount; absent where an example has none. It is 0 when a coupon applied instead (D-7). */
    shopDiscount?: string;
    /** What became of the coupon: whether it applied, why not, and what each side pays. The parts on `lines` add up to the shop-wide amount plus `shopFunded`. */
    coupon?: { applied: boolean; reason: string | null; shopFunded: string; platformFunded: string };
    commission: string;
    deliveryFee: Fee;
    smallCartFee: Fee | null;
    customerTotal: string;
    shopKeeps: string;
    platformContribution: string;
    placeable: boolean;
    reasons: Array<{ code: "BELOW_MINIMUM_CART" | "BELOW_CONTRIBUTION_FLOOR"; shortfall: string }>;
  };
};

/**
 * A commission rule. Its base defaults to after the shop-funded discount, the configured default in CONTEXT.md (Pricing engine), the revenue
 * spec and FR-PRC-04: a shop's own discount lowers what it is charged commission on; a platform-funded one (#70) never will.
 */
const commission = (formula: string, rule: { fixedAmount?: string; percentage?: string; minimum?: string; maximum?: string; base?: "before_shop_discount" | "after_shop_discount" }) => ({
  formula, fixedAmount: rule.fixedAmount ?? null, percentage: rule.percentage ?? null,
  minimum: rule.minimum ?? null, maximum: rule.maximum ?? null, base: rule.base ?? "after_shop_discount",
});

/** A complete global card: 10% commission, ₹30 delivery split 20/80, floor ₹15, minimum cart ₹100. */
const globalCard = (values: Record<string, unknown> = {}): ExampleCard => ({
  scope: { type: "global" },
  values: {
    commission: commission("percentage", { percentage: "10" }),
    deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
    deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
    ...values,
  },
});

const standardDelivery: Fee = { amount: "30.00", platformShare: "6.00", shopShare: "24.00" };

export const DELIVERED_EXAMPLES: DeliveredExample[] = [
  {
    name: "Commission formula: fixed F",
    cards: [globalCard({ commission: commission("fixed", { fixedAmount: "12" }) })],
    lines: [{ category: "Groceries", unitPrice: "99.50", count: 2 }],
    expected: {
      lines: [{ lineTotal: "199.00", commission: "12.00" }], productValue: "199.00", commission: "12.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "229.00", shopKeeps: "211.00",
      platformContribution: "18.00", placeable: true, reasons: [],
    },
  },
  {
    // 12.5% of 98.60 is 12.325 on each line: half-up per line gives 24.66, where rounding the order once would give 24.65 (MNY-2).
    name: "Commission formula: percentage R × P, rounded half-up once per line",
    cards: [globalCard({ commission: commission("percentage", { percentage: "12.5" }) })],
    lines: [{ category: "Groceries", unitPrice: "49.30", count: 2 }, { category: "Groceries", unitPrice: "98.60", count: 1 }],
    expected: {
      lines: [{ lineTotal: "98.60", commission: "12.33" }, { lineTotal: "98.60", commission: "12.33" }],
      productValue: "197.20", commission: "24.66", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "227.20", shopKeeps: "196.54", platformContribution: "30.66", placeable: true, reasons: [],
    },
  },
  {
    name: "Commission formula: F + R × P, then the maximum",
    cards: [globalCard({ commission: commission("fixed_plus_percentage", { fixedAmount: "5", percentage: "4", maximum: "12" }) })],
    lines: [{ category: "Groceries", unitPrice: "250.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "250.00", commission: "12.00" }], productValue: "250.00", commission: "12.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "280.00", shopKeeps: "262.00",
      platformContribution: "18.00", placeable: true, reasons: [],
    },
  },
  {
    name: "Commission formula: max(F, R × P)",
    cards: [globalCard({ commission: commission("higher_of", { fixedAmount: "8", percentage: "5" }) })],
    lines: [{ category: "Groceries", unitPrice: "120.00", count: 1 }, { category: "Groceries", unitPrice: "300.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "120.00", commission: "8.00" }, { lineTotal: "300.00", commission: "15.00" }],
      productValue: "420.00", commission: "23.00", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "450.00", shopKeeps: "421.00", platformContribution: "29.00", placeable: true, reasons: [],
    },
  },
  {
    name: "Commission formula: min(F, R × P), then the minimum",
    cards: [globalCard({ commission: commission("lower_of", { fixedAmount: "20", percentage: "6", minimum: "3" }) })],
    lines: [{ category: "Groceries", unitPrice: "40.00", count: 1 }, { category: "Groceries", unitPrice: "200.00", count: 2 }],
    expected: {
      lines: [{ lineTotal: "40.00", commission: "3.00" }, { lineTotal: "400.00", commission: "20.00" }],
      productValue: "440.00", commission: "23.00", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "470.00", shopKeeps: "441.00", platformContribution: "29.00", placeable: true, reasons: [],
    },
  },
  {
    // The platform share 8.333325 rounds to 8.33 and the shop takes the rest, so the shares add up to the fee.
    name: "Shop-delivered order: a shop's own delivery split",
    cards: [globalCard(), { scope: { type: "shop" }, values: { deliveryFee: { amount: "25", split: { platformPercentage: "33.3333", shopPercentage: "66.6667" } } } }],
    lines: [{ category: "Groceries", unitPrice: "150.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "150.00", commission: "15.00" }], productValue: "150.00", commission: "15.00",
      deliveryFee: { amount: "25.00", platformShare: "8.33", shopShare: "16.67" }, smallCartFee: null,
      customerTotal: "175.00", shopKeeps: "151.67", platformContribution: "23.33", placeable: true, reasons: [],
    },
  },
  {
    name: "Small cart: below the threshold, the fee is capped and split",
    cards: [globalCard({ smallCartFee: { enabled: true, threshold: "150", amount: "20", cap: "15", split: { platformPercentage: "50", shopPercentage: "50" } } })],
    lines: [{ category: "Groceries", unitPrice: "120.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "120.00", commission: "12.00" }], productValue: "120.00", commission: "12.00",
      deliveryFee: standardDelivery, smallCartFee: { amount: "15.00", platformShare: "7.50", shopShare: "7.50" },
      customerTotal: "165.00", shopKeeps: "139.50", platformContribution: "25.50", placeable: true, reasons: [],
    },
  },
  {
    // Dairy's own minimum cart and floor would fail this basket; order-level values ignore category cards (#357).
    name: "Mixed-category order: each line uses its category's commission, one delivery fee",
    cards: [globalCard(), { scope: { type: "category", category: "Dairy" }, values: { commission: commission("fixed", { fixedAmount: "5" }), minimumCart: "500", deliveredContributionFloor: "999" } }],
    lines: [
      { category: "Groceries", unitPrice: "60.00", count: 2 },
      { category: "Groceries", unitPrice: "55.25", count: 2, quantityOption: true },
      { category: "Dairy", unitPrice: "80.00", count: 1 },
    ],
    expected: {
      lines: [{ lineTotal: "120.00", commission: "12.00" }, { lineTotal: "110.50", commission: "11.05" }, { lineTotal: "80.00", commission: "5.00" }],
      productValue: "310.50", commission: "28.05", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "340.50", shopKeeps: "306.45", platformContribution: "34.05", placeable: true, reasons: [],
    },
  },
  {
    name: "Below the minimum cart and the contribution floor: priced, not placeable, with reasons",
    cards: [globalCard()],
    lines: [{ category: "Groceries", unitPrice: "50.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "50.00", commission: "5.00" }], productValue: "50.00", commission: "5.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "80.00", shopKeeps: "69.00",
      platformContribution: "11.00", placeable: false,
      reasons: [{ code: "BELOW_MINIMUM_CART", shortfall: "50.00" }, { code: "BELOW_CONTRIBUTION_FLOOR", shortfall: "4.00" }],
    },
  },
  {
    // 10% of 400 is 40, held to the 20 cap. Commission is on the default base after the discount: 10% of 380.
    name: "Shop-wide discount: a percentage held to its cap",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10", cap: "20" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 2 }],
    expected: {
      lines: [{ lineTotal: "400.00", commission: "38.00", shopDiscount: "20.00" }], productValue: "400.00", shopDiscount: "20.00", commission: "38.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "410.00", shopKeeps: "366.00",
      platformContribution: "44.00", placeable: true, reasons: [],
    },
  },
  {
    name: "Shop-wide discount: a percentage with no cap",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "250.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "250.00", commission: "22.50", shopDiscount: "25.00" }], productValue: "250.00", shopDiscount: "25.00", commission: "22.50",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "255.00", shopKeeps: "226.50",
      platformContribution: "28.50", placeable: true, reasons: [],
    },
  },
  {
    name: "Shop-wide discount: a flat amount on an order at its minimum",
    cards: [globalCard()],
    shopDiscount: { form: "flat", amount: "200", minimumOrder: "1000" },
    lines: [{ category: "Groceries", unitPrice: "600.00", count: 2 }],
    expected: {
      lines: [{ lineTotal: "1200.00", commission: "100.00", shopDiscount: "200.00" }], productValue: "1200.00", shopDiscount: "200.00", commission: "100.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "1030.00", shopKeeps: "924.00",
      platformContribution: "106.00", placeable: true, reasons: [],
    },
  },
  {
    name: "Shop-wide discount: a flat amount below its minimum order takes nothing off",
    cards: [globalCard()],
    shopDiscount: { form: "flat", amount: "200", minimumOrder: "1000" },
    lines: [{ category: "Groceries", unitPrice: "400.00", count: 2 }],
    expected: {
      lines: [{ lineTotal: "800.00", commission: "80.00", shopDiscount: "0.00" }], productValue: "800.00", shopDiscount: "0.00", commission: "80.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "830.00", shopKeeps: "744.00",
      platformContribution: "86.00", placeable: true, reasons: [],
    },
  },
  {
    // 5% of 100.00 is 5.00. The pro-rata parts round down to 1.66, 1.66 and 1.66; the 2 paise left go to the largest line, so 1.66 + 1.66 + 1.68 = 5.00 (MNY-6).
    // Commission is per line on what is left: 10% of 31.67, 31.67 and 31.66, each rounding to 3.17.
    name: "Shop-wide discount: the split across lines in paise adds up, the remainder to the largest line",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "5" },
    lines: [{ category: "Groceries", unitPrice: "33.33", count: 1 }, { category: "Groceries", unitPrice: "33.33", count: 1 }, { category: "Groceries", unitPrice: "33.34", count: 1 }],
    expected: {
      lines: [{ lineTotal: "33.33", commission: "3.17", shopDiscount: "1.66" }, { lineTotal: "33.33", commission: "3.17", shopDiscount: "1.66" }, { lineTotal: "33.34", commission: "3.17", shopDiscount: "1.68" }],
      productValue: "100.00", shopDiscount: "5.00", commission: "9.51", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "125.00", shopKeeps: "109.49", platformContribution: "15.51", placeable: true, reasons: [],
    },
  },
  {
    // The minimum cart tests product value before the discount: 110 passes, though 99 would not.
    name: "Shop-wide discount: the minimum cart is tested before the discount",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "110.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "110.00", commission: "9.90", shopDiscount: "11.00" }], productValue: "110.00", shopDiscount: "11.00", commission: "9.90",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "129.00", shopKeeps: "113.10",
      platformContribution: "15.90", placeable: true, reasons: [],
    },
  },
  {
    name: "Commission base before the shop discount, when Admin chooses it: the discount does not shrink it",
    cards: [globalCard({ commission: commission("percentage", { percentage: "10", base: "before_shop_discount" }) })],
    shopDiscount: { form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "60.00", count: 2 }, { category: "Groceries", unitPrice: "80.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "120.00", commission: "12.00", shopDiscount: "12.00" }, { lineTotal: "80.00", commission: "8.00", shopDiscount: "8.00" }],
      productValue: "200.00", shopDiscount: "20.00", commission: "20.00", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "210.00", shopKeeps: "184.00", platformContribution: "26.00", placeable: true, reasons: [],
    },
  },
  {
    // Each line's commission is on its total less its own part of the discount: 10% of 108.00 and of 72.00.
    name: "Commission base after the shop discount is the default, and uses each line's apportioned share",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "60.00", count: 2 }, { category: "Groceries", unitPrice: "80.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "120.00", commission: "10.80", shopDiscount: "12.00" }, { lineTotal: "80.00", commission: "7.20", shopDiscount: "8.00" }],
      productValue: "200.00", shopDiscount: "20.00", commission: "18.00", deliveryFee: standardDelivery, smallCartFee: null,
      customerTotal: "210.00", shopKeeps: "186.00", platformContribution: "24.00", placeable: true, reasons: [],
    },
  },

  // Coupons (#70): ₹200 earns the platform 20 commission and 6 of the delivery, 26 against the ₹15 floor, a surplus of 11 to spend.
  {
    name: "Shop-funded coupon: comes off the commission base and the shop alone pays it",
    cards: [globalCard()],
    coupon: { funding: "shop", form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "18.00", shopDiscount: "20.00" }], productValue: "200.00", commission: "18.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "210.00", shopKeeps: "186.00", platformContribution: "24.00", placeable: true, reasons: [],
      coupon: { applied: true, reason: null, shopFunded: "20.00", platformFunded: "0.00" },
    },
  },
  {
    name: "Platform-funded coupon within the surplus: commission stays on the full base and the platform pays it",
    cards: [globalCard()],
    coupon: { funding: "platform", form: "percentage", percentage: "5" },
    lines: [{ category: "Groceries", unitPrice: "400.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "400.00", commission: "40.00", shopDiscount: "0.00" }], productValue: "400.00", commission: "40.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "410.00", shopKeeps: "384.00", platformContribution: "26.00", placeable: true, reasons: [],
      coupon: { applied: true, reason: null, shopFunded: "0.00", platformFunded: "20.00" },
    },
  },
  {
    name: "Platform-funded percentage coupon trimmed to the surplus above the floor",
    cards: [globalCard()],
    coupon: { funding: "platform", form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "20.00", shopDiscount: "0.00" }], productValue: "200.00", commission: "20.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "219.00", shopKeeps: "204.00", platformContribution: "15.00", placeable: true, reasons: [],
      coupon: { applied: true, reason: null, shopFunded: "0.00", platformFunded: "11.00" },
    },
  },
  {
    name: "Platform-funded flat coupon the surplus cannot pay in full is not applied",
    cards: [globalCard()],
    coupon: { funding: "platform", form: "flat", amount: "50" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "20.00", shopDiscount: "0.00" }], productValue: "200.00", commission: "20.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "230.00", shopKeeps: "204.00", platformContribution: "26.00", placeable: true, reasons: [],
      coupon: { applied: false, reason: "NO_ROOM", shopFunded: "0.00", platformFunded: "0.00" },
    },
  },
  {
    name: "Coupon below its minimum order takes nothing off",
    cards: [globalCard()],
    coupon: { funding: "shop", form: "percentage", percentage: "10", minimumOrder: "500" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "20.00", shopDiscount: "0.00" }], productValue: "200.00", commission: "20.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "230.00", shopKeeps: "204.00", platformContribution: "26.00", placeable: true, reasons: [],
      coupon: { applied: false, reason: "BELOW_MINIMUM", shopFunded: "0.00", platformFunded: "0.00" },
    },
  },
  {
    name: "A coupon that takes more than the shop-wide discount applies alone, and the discount does not",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "5" },
    coupon: { funding: "shop", form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "18.00", shopDiscount: "20.00" }], productValue: "200.00", shopDiscount: "0.00", commission: "18.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "210.00", shopKeeps: "186.00", platformContribution: "24.00", placeable: true, reasons: [],
      coupon: { applied: true, reason: null, shopFunded: "20.00", platformFunded: "0.00" },
    },
  },
  {
    name: "A coupon that takes less than the shop-wide discount is not applied",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10" },
    coupon: { funding: "platform", form: "percentage", percentage: "5" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "18.00", shopDiscount: "20.00" }], productValue: "200.00", shopDiscount: "20.00", commission: "18.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "210.00", shopKeeps: "186.00", platformContribution: "24.00", placeable: true, reasons: [],
      coupon: { applied: false, reason: "BETTER_OFFER", shopFunded: "0.00", platformFunded: "0.00" },
    },
  },
  {
    name: "A coupon that ties the shop-wide discount gives way to the discount",
    cards: [globalCard()],
    shopDiscount: { form: "percentage", percentage: "10" },
    coupon: { funding: "shop", form: "percentage", percentage: "10" },
    lines: [{ category: "Groceries", unitPrice: "200.00", count: 1 }],
    expected: {
      lines: [{ lineTotal: "200.00", commission: "18.00", shopDiscount: "20.00" }], productValue: "200.00", shopDiscount: "20.00", commission: "18.00",
      deliveryFee: standardDelivery, smallCartFee: null, customerTotal: "210.00", shopKeeps: "186.00", platformContribution: "24.00", placeable: true, reasons: [],
      coupon: { applied: false, reason: "BETTER_OFFER", shopFunded: "0.00", platformFunded: "0.00" },
    },
  },
];

export type CounterBillExample = { name: string; lines: Array<{ unitPrice: string; count: number }>; discount?: string; total: string | null };

/**
 * Counter-bill totals (BIL-9), written once (#51). The phone's arithmetic and the server's SQL check both
 * run them. Whole packs only; part packs and quantity-price options join when counter billing sells them.
 */
export const COUNTER_BILL_EXAMPLES: CounterBillExample[] = [
  { name: "One pack at a whole-rupee price", lines: [{ unitPrice: "21", count: 1 }], total: "21.00" },
  { name: "Paise carried across lines", lines: [{ unitPrice: "99.50", count: 2 }, { unitPrice: "0.05", count: 3 }, { unitPrice: "12.5", count: 1 }], total: "211.65" },
  { name: "Many packs at one paisa", lines: [{ unitPrice: "0.01", count: 9999 }], total: "99.99" },
  { name: "A free pack adds nothing", lines: [{ unitPrice: "0", count: 2 }, { unitPrice: "40", count: 1 }], total: "40.00" },
  { name: "Exact past a float's safe integers", lines: [{ unitPrice: "9999999999.99", count: 9999 }], total: "99989999999900.01" },
  { name: "A discount comes off the sum", lines: [{ unitPrice: "99.50", count: 2 }, { unitPrice: "12.5", count: 1 }], discount: "11.50", total: "200.00" },
  { name: "A discount of the whole sum leaves nothing to pay", lines: [{ unitPrice: "40", count: 2 }], discount: "80", total: "0.00" },
  { name: "A discount of one paisa more than the sum is refused", lines: [{ unitPrice: "40", count: 2 }], discount: "80.01", total: null },
  { name: "A discount in paise on a large sum stays exact", lines: [{ unitPrice: "9999999999.99", count: 9999 }], discount: "0.01", total: "99989999999900.00" },
];

export type PickupExample = {
  name: string;
  rule: { enabled: boolean; customerFee: string; shopFee: string | null; cap: string | null; contributionFloor: string };
  productValue: string;
  shopDiscount: string;
  expected: { pickupFee: string; shopFee: string; total: string; contribution: string; shortfall: string | null };
};

/**
 * The revenue specification's self-pickup scenario (FUL-7, MNY-2, MNY-4): no delivery fee, no commission, booking fees only where switched on,
 * tested against the pickup floor. The delivered examples price the delivered route; these price the pickup route, in `pickupPrice`.
 */
export const PICKUP_EXAMPLES: PickupExample[] = [
  {
    name: "Fees off: the customer pays the product value and the platform earns nothing",
    rule: { enabled: false, customerFee: "5", shopFee: "3", cap: null, contributionFloor: "0" },
    productValue: "250.00", shopDiscount: "0.00",
    expected: { pickupFee: "0.00", shopFee: "0.00", total: "250.00", contribution: "0.00", shortfall: null },
  },
  {
    name: "A customer booking fee is a named line on top of the goods and is the platform's only earning",
    rule: { enabled: true, customerFee: "5", shopFee: null, cap: null, contributionFloor: "5" },
    productValue: "250.00", shopDiscount: "0.00",
    expected: { pickupFee: "5.00", shopFee: "0.00", total: "255.00", contribution: "5.00", shortfall: null },
  },
  {
    name: "A shop booking fee adds to the platform's earning but not to the customer's total",
    rule: { enabled: true, customerFee: "5", shopFee: "2.50", cap: null, contributionFloor: "7.50" },
    productValue: "250.00", shopDiscount: "0.00",
    expected: { pickupFee: "5.00", shopFee: "2.50", total: "255.00", contribution: "7.50", shortfall: null },
  },
  {
    name: "The customer's fee is held to the cap",
    rule: { enabled: true, customerFee: "12", shopFee: null, cap: "10", contributionFloor: "0" },
    productValue: "100.00", shopDiscount: "0.00",
    expected: { pickupFee: "10.00", shopFee: "0.00", total: "110.00", contribution: "10.00", shortfall: null },
  },
  {
    name: "A shop-wide discount comes off the goods and the booking fee is added after it",
    rule: { enabled: true, customerFee: "5", shopFee: null, cap: null, contributionFloor: "0" },
    productValue: "200.00", shopDiscount: "20.00",
    expected: { pickupFee: "5.00", shopFee: "0.00", total: "185.00", contribution: "5.00", shortfall: null },
  },
  {
    name: "Below the pickup floor is not placeable and names the shortfall",
    rule: { enabled: true, customerFee: "5", shopFee: null, cap: null, contributionFloor: "8" },
    productValue: "250.00", shopDiscount: "0.00",
    expected: { pickupFee: "5.00", shopFee: "0.00", total: "255.00", contribution: "5.00", shortfall: "3.00" },
  },
  {
    name: "Fees off with a floor above zero can never be placed",
    rule: { enabled: false, customerFee: "5", shopFee: null, cap: null, contributionFloor: "1" },
    productValue: "250.00", shopDiscount: "0.00",
    expected: { pickupFee: "0.00", shopFee: "0.00", total: "250.00", contribution: "0.00", shortfall: "1.00" },
  },
  {
    name: "Paise stay exact",
    rule: { enabled: true, customerFee: "4.75", shopFee: "1.25", cap: null, contributionFloor: "6" },
    productValue: "99.95", shopDiscount: "9.99",
    expected: { pickupFee: "4.75", shopFee: "1.25", total: "94.71", contribution: "6.00", shortfall: null },
  },
];
