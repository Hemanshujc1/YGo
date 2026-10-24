import { describe, expect, it } from "vitest";
import { CountedPackQuantity, CreatePackBody, EditPackBody, invalidFields, Pack, PackQuantity } from "../src/index";

describe("pack contracts (#205)", () => {
  it("accepts positive quantities through three decimals within NUMERIC(12,3)", () => {
    for (const quantity of ["0.001", "0.123", "1", "1.125", "999999999.999"]) {
      expect(CreatePackBody.parse({ baseUnit: "kg", quantity })).toEqual({ baseUnit: "kg", quantity, barcode: null });
    }
    for (const quantity of ["0", "0.000", "-1", "0.0001", "1.2345", "1000000000", "1e3", "01", " 1 ", 1]) {
      expect(PackQuantity.safeParse(quantity).success).toBe(false);
    }
    expect(CountedPackQuantity.safeParse("12.000").success).toBe(true);
    expect(CountedPackQuantity.safeParse("0.125").success).toBe(false);
  });

  it("rejects fractional counted quantities in both create and edit requests", () => {
    for (const schema of [CreatePackBody, EditPackBody]) {
      for (const quantity of ["0.001", "0.125", "1.5", "12.001"]) {
        const result = schema.safeParse({ baseUnit: "each", quantity });
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected a fractional counted quantity to fail");
        expect(invalidFields(result.error)).toEqual(["quantity"]);
      }
      for (const quantity of ["1", "12.0", "12.000", "999999999"]) {
        expect(schema.safeParse({ baseUnit: "each", quantity }).success).toBe(true);
      }
    }
  });

  it.each(["kg", "l"])("allows up to three decimal places for %s in create and edit requests", (baseUnit) => {
    for (const schema of [CreatePackBody, EditPackBody]) {
      for (const quantity of ["1", "0.1", "0.12", "0.125", "999999999.999"]) {
        expect(schema.safeParse({ baseUnit, quantity }).success).toBe(true);
      }
      for (const quantity of ["0", "-1", "0.0001", "1.2345"]) {
        expect(schema.safeParse({ baseUnit, quantity }).success).toBe(false);
      }
    }
  });

  it("requires unit context for quantities and keeps unit-only edits invalid", () => {
    for (const schema of [CreatePackBody, EditPackBody]) {
      for (const body of [{ quantity: "1" }, { baseUnit: "g", quantity: "1" }]) {
        const result = schema.safeParse(body);
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected missing or invalid unit context to fail");
        expect(invalidFields(result.error)).toEqual(["baseUnit"]);
      }
    }
    expect(EditPackBody.safeParse({ baseUnit: "each" }).success).toBe(false);
    expect(EditPackBody.safeParse({ baseUnit: "kg", reason: "No change" }).success).toBe(false);
  });

  it("preserves a single optional barcode as exact digits", () => {
    for (const barcode of [null, "01234567", "012345678901", "0012345678901"]) {
      expect(CreatePackBody.parse({ baseUnit: "each", quantity: "1", barcode }).barcode).toBe(barcode);
    }
    for (const barcode of ["", "1234567", "123456789", "12345678901234", "1234567a", 12345678, ["12345678"], " 12345678 "]) {
      expect(CreatePackBody.safeParse({ baseUnit: "each", quantity: "1", barcode }).success).toBe(false);
    }
  });

  it("supports clearing barcodes and activation edits without accepting empty or unknown edits", () => {
    expect(EditPackBody.parse({ barcode: null })).toEqual({ barcode: null });
    expect(EditPackBody.parse({ active: false, reason: " Retired " })).toEqual({ active: false, reason: "Retired" });
    for (const body of [{}, { reason: "Retired" }, { barcodes: [] }, { productId: "other" }]) {
      expect(EditPackBody.safeParse(body).success).toBe(false);
    }
    expect(Pack.parse({
      id: "00000000-0000-4000-8000-000000000205", productId: "00000000-0000-4000-8000-000000000203",
      quantity: "0.125", barcode: null, active: true,
    }).quantity).toBe("0.125");
  });
});
