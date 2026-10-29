import { describe, expect, it } from "vitest";
import { offLabel, packLabel, shopSections } from "../src/lib/shop-page";

describe("shop page labels (#370)", () => {
  it("shows a pack below 1 kg or 1 L in g or ml, and counts pieces", () => {
    expect([packLabel("0.5", "kg"), packLabel("0.25", "l"), packLabel("1", "kg"), packLabel("1.5", "l"), packLabel("1", "each"), packLabel("12", "each")])
      .toEqual(["500 g", "250 ml", "1 kg", "1.5 L", "1 pc", "12 pcs"]);
  });

  it("names a whole percent off, and nothing below 1%", () => {
    expect([offLabel({ discountPercent: 10 }), offLabel({ discountPercent: 0 }), offLabel({ discountPercent: null })]).toEqual(["10% off", null, null]);
  });

  it("keeps the server's category, product and pack order as SectionList sections", () => {
    const pack = (listingId: string, quantity: string) => ({ listingId, quantity, price: "10.00", mrp: null, discountPercent: null, outOfStock: false });
    const product = (id: string, packs: ReturnType<typeof pack>[]) => ({ id, name: id, brand: null, baseUnit: "kg" as const, packs });
    const groups = [
      { category: "Groceries", products: [product("atta", [pack("a1", "5")]), product("dal", [pack("d1", "0.5"), pack("d2", "1")])] },
      { category: "Stationery", products: [product("pen", [pack("p1", "1")])] },
    ];
    expect(shopSections(groups)).toEqual([
      { key: "Groceries", title: "Groceries", data: groups[0]?.products },
      { key: "Stationery", title: "Stationery", data: groups[1]?.products },
    ]);
    expect(shopSections(groups)[0]?.data[1]?.packs.map((listed) => listed.listingId)).toEqual(["d1", "d2"]);
    expect(shopSections([])).toEqual([]);
  });
});
