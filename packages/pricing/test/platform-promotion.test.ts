import { describe, expect, it } from "vitest";
import { platformPromotionCap } from "../src/platform-promotion";

describe("platformPromotionCap (ORD-4, D-5)", () => {
  it("caps promotion budget at zero when contribution before promotion is negative", () => {
    expect(platformPromotionCap(-5.5)).toBe(0);
    expect(platformPromotionCap(-0.01)).toBe(0);
  });

  it("returns zero when contribution before promotion is zero", () => {
    expect(platformPromotionCap(0)).toBe(0);
  });

  it("returns the exact contribution when positive", () => {
    expect(platformPromotionCap(12.5)).toBe(12.5);
    expect(platformPromotionCap(100)).toBe(100);
  });
});

