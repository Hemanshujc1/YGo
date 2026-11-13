import { describe, expect, it } from "vitest";
import {
  AdminDismissFlaggedQuantityOptionParams,
  AdminFlaggedQuantityOption,
  AdminFlaggedQuantityOptionsResponse,
  DismissFlaggedQuantityOptionBody,
  OpeningStockBody,
  SaveShopListingBody,
  ShopListingsResponse,
  invalidFields,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";

describe("shop listing contracts", () => {
  it("requires prices and keeps measured minimum and step together", () => {
    expect(SaveShopListingBody.safeParse({ onlinePrice: "10.50", counterPrice: "11", mrp: "12", lowStockLevel: "0" }).success).toBe(true);
    const result = SaveShopListingBody.safeParse({
      onlinePrice: "10.50", counterPrice: "11", mrp: "12", lowStockLevel: "0",
      minimumOrderQuantity: "0.25", quantityStep: null,
    });
    if (result.success) throw new Error("expected the measured quantities to be supplied together");
    expect(invalidFields(result.error)).toEqual(["quantityStep"]);
  });

  it("accepts zero opening stock and requires an idempotency ID", () => {
    expect(OpeningStockBody.parse({ quantity: "0", clientId: id })).toEqual({ quantity: "0", clientId: id });
    expect(OpeningStockBody.safeParse({ quantity: "1.25" }).success).toBe(false);
  });

  it("requires a name for each quantity-price option", () => {
    const required = { onlinePrice: "10", counterPrice: "11", mrp: "12", lowStockLevel: "0" };
    expect(SaveShopListingBody.safeParse({ ...required, quantityOptions: [{ name: "Family pack", quantity: "2", price: "38" }] }).success).toBe(true);
    expect(SaveShopListingBody.safeParse({ ...required, quantityOptions: [{ quantity: "2", price: "38" }] }).success).toBe(false);
  });

  it("keeps online and counter prices at or below MRP without floating-point comparisons", () => {
    const valid = { onlinePrice: "10.10", counterPrice: "10.10", mrp: "10.10", lowStockLevel: "0" };
    expect(SaveShopListingBody.safeParse(valid).success).toBe(true);
    expect(SaveShopListingBody.safeParse({ ...valid, onlinePrice: "10.11" }).success).toBe(false);
    expect(SaveShopListingBody.safeParse({ ...valid, counterPrice: "10.11" }).success).toBe(false);
    expect(SaveShopListingBody.safeParse({ ...valid, onlinePrice: "not-a-price" }).success).toBe(false);
  });

  it("requires the API response to expose the first stock movement", () => {
    const response = {
      items: [{
        packId: id, productId: id, name: "Rice", brand: null, baseUnit: "kg", classification: "measured",
        packQuantity: "1", barcode: null, stock: "0", held: "0", openingStockRecorded: false, openingStock: "0", listing: null,
      }],
    };
    expect(ShopListingsResponse.parse(response)).toEqual(response);
    expect(ShopListingsResponse.safeParse({ items: [{ ...response.items[0], stock: "not-a-quantity" }] }).success).toBe(false);
    expect(ShopListingsResponse.parse({ items: [{ ...response.items[0], stock: "-0.250" }] }).items[0]?.stock).toBe("-0.250");
    // What accepted orders hold is never negative (#436).
    expect(ShopListingsResponse.safeParse({ items: [{ ...response.items[0], held: "-1" }] }).success).toBe(false);
  });

  it("validates flagged quantity option contracts and dismiss body", () => {
    const validOption = {
      id,
      listingId: id,
      packId: id,
      productName: "Basmati Rice",
      packQuantity: "1",
      baseUnit: "kg" as const,
      name: "Family pack",
      quantity: "5",
      price: "250",
      flagged: true,
    };
    expect(AdminFlaggedQuantityOption.parse(validOption)).toEqual(validOption);
    expect(AdminFlaggedQuantityOptionsResponse.parse({ options: [validOption] })).toEqual({ options: [validOption] });
    expect(AdminFlaggedQuantityOption.safeParse({ ...validOption, baseUnit: "litres" }).success).toBe(false);

    expect(AdminDismissFlaggedQuantityOptionParams.parse({ id, optionId: id })).toEqual({ id, optionId: id });
    expect(AdminDismissFlaggedQuantityOptionParams.safeParse({ id: "invalid", optionId: id }).success).toBe(false);

    expect(DismissFlaggedQuantityOptionBody.parse({ reason: "Legitimate deal" })).toEqual({ reason: "Legitimate deal" });
    expect(DismissFlaggedQuantityOptionBody.safeParse({ reason: "   " }).success).toBe(false);
  });
});
