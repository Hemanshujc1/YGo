import { describe, expect, it } from "vitest";
import { commissionText, rateCardLines } from "../src/lib/agreement";

const rule = { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" } as const;

describe("commissionText", () => {
  it("words each formula, with its bounds and base", () => {
    expect(commissionText(rule)).toBe("10% of each item line");
    expect(commissionText({ ...rule, formula: "fixed", fixedAmount: "12", percentage: null })).toBe("₹12 on each item line");
    expect(commissionText({ ...rule, formula: "higher_of", fixedAmount: "5", minimum: "2", maximum: "50.5" }))
      .toBe("₹5 or 10% of each item line, whichever is higher, at least ₹2, at most ₹50.50");
    expect(commissionText({ ...rule, formula: "fixed_plus_percentage", fixedAmount: "1", percentage: "2.5", base: "after_shop_discount" }))
      .toBe("₹1 plus 2.5% of each item line after your discount");
    expect(commissionText({ ...rule, percentage: "10.00" })).toBe("10% of each item line");
    expect(commissionText({ ...rule, percentage: "12.50" })).toBe("12.5% of each item line");
  });
});

describe("rateCardLines", () => {
  it("lists the card's values in order and leaves out switched-off rules", () => {
    const lines = rateCardLines({
      statementGraceDays: 7,
      minimumCart: "100",
      commission: rule,
      deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
      smallCartFee: { enabled: false, threshold: "100", amount: "10", cap: null, split: { platformPercentage: "50", shopPercentage: "50" } },
      pickup: { enabled: true, customerFee: "0", shopFee: "5", cap: null, contributionFloor: "3" },
      deliveredContributionFloor: "0",
    });
    expect(lines.map(({ label, value }) => `${label}: ${value}`)).toEqual([
      "Commission: 10% of each item line",
      "Delivery fee: ₹30 on each order. YGo keeps 20%, your shop 80%.",
      "Least YGo earns on a delivered order: ₹0",
      "Minimum order: ₹100",
      "Pickup: The customer pays ₹0. Your shop pays ₹5. YGo earns at least ₹3 on a pickup order.",
      "Time to pay a weekly statement: 7 days",
    ]);
  });
});
