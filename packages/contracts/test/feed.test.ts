import { describe, expect, it } from "vitest";
import { ShopPageProduct } from "../src/index";

const product = { id: "00000000-0000-4000-8000-000000000001", name: "Toor Dal", brand: null, baseUnit: "kg", packs: [] };

describe("shop page contracts", () => {
  it("requires each product's photo address, a URL or null (#378)", () => {
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: "https://images.ygo.example/p/256.webp" }).success).toBe(true);
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: null }).success).toBe(true);
    expect(ShopPageProduct.safeParse(product).success).toBe(false);
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: "products/p/256.webp" }).success).toBe(false);
  });
});
