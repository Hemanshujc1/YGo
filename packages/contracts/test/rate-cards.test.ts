import { describe, expect, it } from "vitest";
import { CommissionRule, FeeSplit, PublishedRateCardResponse, RateCardResponse, RateCardSource, RateCardVersion, RatePercentage, ResolveRateCardQuery } from "../src/index";

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

  it("carries versions as exact canonical bigint strings on every surface (#355)", () => {
    for (const value of ["1", "9007199254740993", "9223372036854775807"]) expect(RateCardVersion.parse(value)).toBe(value);
    for (const value of ["0", "007", "+3", "-1", "1.0", "1e3", " 1", "", "9223372036854775808", "99999999999999999999"]) {
      expect(RateCardVersion.safeParse(value).success, value).toBe(false);
    }
    for (const value of [1, 9007199254740993n]) expect(RateCardVersion.safeParse(value).success).toBe(false);
    const shopId = "00000000-0000-4000-8000-000000000000";
    expect(ResolveRateCardQuery.parse({ shopId, version: "9223372036854775807" }).version).toBe("9223372036854775807");
    expect(ResolveRateCardQuery.safeParse({ shopId, version: "9223372036854775808" }).success).toBe(false);
    expect(PublishedRateCardResponse.safeParse({ version: 3 }).success).toBe(false);
    expect(RateCardSource.safeParse({ type: "global", id: null, version: "9007199254740993" }).success).toBe(true);
    const empty = { values: {}, missing: [], complete: true };
    expect(RateCardResponse.safeParse({ ...empty, version: "0" }).success).toBe(true);
    expect(RateCardResponse.safeParse({ ...empty, version: 0 }).success).toBe(false);
  });
});
