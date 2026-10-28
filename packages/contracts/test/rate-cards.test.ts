import { describe, expect, it } from "vitest";
import { CommissionRule, FeeSplit, RatePercentage } from "../src/index";

describe("rate-card percentage input (#44)", () => {
  it("refuses malformed percentages without throwing and sums decimal shares exactly", () => {
    for (const value of ["abc", "", "1.00001", "100.0001", "-1"]) expect(RatePercentage.safeParse(value).success).toBe(false);
    expect(FeeSplit.safeParse({ platformPercentage: "33.3333", shopPercentage: "66.6667" }).success).toBe(true);
    expect(FeeSplit.safeParse({ platformPercentage: "abc", shopPercentage: "100" }).success).toBe(false);
  });

  it("requires exactly the operands used by each commission formula and ordered bounds", () => {
    const base = { base: "after_shop_discount", minimum: "1.01", maximum: "1.1" };
    for (const formula of ["fixed", "percentage", "fixed_plus_percentage", "higher_of", "lower_of"]) {
      const rule = { ...base, formula, fixedAmount: formula === "percentage" ? null : "0", percentage: formula === "fixed" ? null : "0" };
      expect(CommissionRule.safeParse(rule).success).toBe(true);
      expect(CommissionRule.safeParse({ ...rule, minimum: "1.10", maximum: "1.1" }).success).toBe(true);
      expect(CommissionRule.safeParse({ ...rule, minimum: "9999999999.99", maximum: "9999999999.98" }).success).toBe(false);
      expect(CommissionRule.safeParse({ ...rule, minimum: "oops" }).success).toBe(false);
      expect(CommissionRule.safeParse({ ...rule, fixedAmount: formula === "percentage" ? "1" : null }).success).toBe(false);
      expect(CommissionRule.safeParse({ ...rule, percentage: formula === "fixed" ? "1" : null }).success).toBe(false);
    }
  });
});
