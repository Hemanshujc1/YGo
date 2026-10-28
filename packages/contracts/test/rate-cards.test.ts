import { describe, expect, it } from "vitest";
import { FeeSplit, RatePercentage } from "../src/index";

describe("rate-card percentage input (#44)", () => {
  it("refuses malformed percentages without throwing and sums decimal shares exactly", () => {
    for (const value of ["abc", "", "1.00001", "100.0001", "-1"]) expect(RatePercentage.safeParse(value).success).toBe(false);
    expect(FeeSplit.safeParse({ platformPercentage: "33.3333", shopPercentage: "66.6667" }).success).toBe(true);
    expect(FeeSplit.safeParse({ platformPercentage: "abc", shopPercentage: "100" }).success).toBe(false);
  });
});
