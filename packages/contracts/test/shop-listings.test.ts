import { describe, expect, it } from "vitest";
import { OpeningStockBody, SaveShopListingBody, ShopListingsResponse, invalidFields } from "../src/index";

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

  it("requires the API response to expose the first stock movement", () => {
    const response = {
      items: [{
        packId: id, productId: id, name: "Rice", brand: null, baseUnit: "kg", classification: "measured",
        packQuantity: "1", barcode: null, stock: "0", openingStockRecorded: false, listing: null,
      }],
    };
    expect(ShopListingsResponse.parse(response)).toEqual(response);
    expect(ShopListingsResponse.safeParse({ items: [{ ...response.items[0], stock: "not-a-quantity" }] }).success).toBe(false);
    expect(ShopListingsResponse.parse({ items: [{ ...response.items[0], stock: "-0.250" }] }).items[0]?.stock).toBe("-0.250");
  });
});
