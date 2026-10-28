/**
 * The revenue specification's delivered-route scenarios, written once as inputs and expected amounts (Q-6).
 * The server's tests publish each example's cards, run its basket through the public price simulator
 * and compare every amount. The spec gives symbols only; these are concrete stand-ins chosen by #357.
 * Promotion scenarios join when the promotion tickets land.
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

type Fee = { amount: string; platformShare: string; shopShare: string };

export type DeliveredExample = {
  name: string;
  cards: ExampleCard[];
  lines: ExampleLine[];
  expected: {
    lines: Array<{ lineTotal: string; commission: string }>;
    productValue: string;
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

const commission = (formula: string, rule: { fixedAmount?: string; percentage?: string; minimum?: string; maximum?: string }) => ({
  formula, fixedAmount: rule.fixedAmount ?? null, percentage: rule.percentage ?? null,
  minimum: rule.minimum ?? null, maximum: rule.maximum ?? null, base: "before_shop_discount",
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
];
