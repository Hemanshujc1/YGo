import { describe, expect, it } from "vitest";
import { buildStockChange } from "../src/lib/stock-change";

const packId = "00000000-0000-4000-8000-000000000002";

describe("the stock change a shop types (S11, BIL-7, #67)", () => {
  it("adds, takes away or counts, by the reason and the choice", () => {
    expect(buildStockChange(packId, "received", false, "10", "kg")).toEqual({ packId, reason: "received", quantity: "10" });
    expect(buildStockChange(packId, "returned", true, " 2.50 ", "kg")).toEqual({ packId, reason: "returned", quantity: "-2.5" });
    expect(buildStockChange(packId, "damaged", false, "3", "kg")).toEqual({ packId, reason: "damaged", quantity: "-3" });
    expect(buildStockChange(packId, "expired", true, "1", "l")).toEqual({ packId, reason: "expired", quantity: "-1" });
    expect(buildStockChange(packId, "counted", true, "42", "kg")).toEqual({ packId, reason: "counted", total: "42" });
    expect(buildStockChange(packId, "counted", false, "0", "kg")).toEqual({ packId, reason: "counted", total: "0" });
  });

  it("refuses an empty, zero, negative, too fine or fractional-for-counted amount", () => {
    for (const typed of ["", "abc", "-5", "1.2345", "1e3"]) expect(buildStockChange(packId, "received", false, typed, "kg"), typed).toBeNull();
    expect(buildStockChange(packId, "received", false, "0", "kg")).toBeNull();
    expect(buildStockChange(packId, "damaged", false, "0", "kg")).toBeNull();
    expect(buildStockChange(packId, "received", false, "1.5", "each")).toBeNull();
    expect(buildStockChange(packId, "counted", false, "2.5", "each")).toBeNull();
    expect(buildStockChange(packId, "received", false, "2", "each")).toEqual({ packId, reason: "received", quantity: "2" });
  });
});
