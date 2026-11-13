import { describe, expect, it } from "vitest";
import { FeedShop, ShopPageProduct } from "../src/index";

const product = { id: "00000000-0000-4000-8000-000000000001", name: "Toor Dal", brand: null, baseUnit: "kg", packs: [] };
const shop = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Green Grocers",
  estimatedMinutes: 20,
  deliveryFee: "30",
  delivers: true,
  pickup: true,
  open: true,
  opensAt: null,
  holiday: false,
};

describe("shop page contracts", () => {
  it("requires each product's photo address, a URL or null (#378)", () => {
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: "https://images.ygo.example/p/256.webp" }).success).toBe(true);
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: null }).success).toBe(true);
    expect(ShopPageProduct.safeParse(product).success).toBe(false);
    expect(ShopPageProduct.safeParse({ ...product, imageUrl: "products/p/256.webp" }).success).toBe(false);
  });

  it("validates FeedShop rating as a number or null (#82)", () => {
    expect(FeedShop.safeParse({ ...shop, rating: 4.5 }).success).toBe(true);
    expect(FeedShop.safeParse({ ...shop, rating: null }).success).toBe(true);
    expect(FeedShop.safeParse(shop).success).toBe(false);
    expect(FeedShop.safeParse({ ...shop, rating: "4.5" }).success).toBe(false);
  });
});
