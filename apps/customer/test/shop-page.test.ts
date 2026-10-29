import { describe, expect, it } from "vitest";
import { offLabel, packLabel } from "../src/lib/shop-page";

describe("shop page labels (#370)", () => {
  it("shows a pack below 1 kg or 1 L in g or ml, and counts pieces", () => {
    expect([packLabel("0.5", "kg"), packLabel("0.25", "l"), packLabel("1", "kg"), packLabel("1.5", "l"), packLabel("1", "each"), packLabel("12", "each")])
      .toEqual(["500 g", "250 ml", "1 kg", "1.5 L", "1 pc", "12 pcs"]);
  });

  it("names a whole percent off, and nothing below 1%", () => {
    expect([offLabel({ discountPercent: 10 }), offLabel({ discountPercent: 0 }), offLabel({ discountPercent: null })]).toEqual(["10% off", null, null]);
  });
});
