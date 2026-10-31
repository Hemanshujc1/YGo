import { describe, expect, it } from "vitest";
import { stockLine } from "../src/lib/stock-line";

describe("stockLine (#436)", () => {
  it("shows what's left, and what accepted orders hold only when they hold some", () => {
    expect(stockLine("1.000", "2.000", "kg")).toBe("1 kg left · 2 kg held for orders");
    expect(stockLine("3.000", "0", "kg")).toBe("3 kg left");
    expect(stockLine("-0.500", "0.750", "l")).toBe("-0.5 l left · 0.75 l held for orders");
  });

  it("leaves out the held part for a Stock item saved before #436", () => {
    expect(stockLine("4", undefined, "each")).toBe("4 each left");
  });
});
