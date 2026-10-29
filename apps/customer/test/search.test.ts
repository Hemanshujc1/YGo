import { describe, expect, it } from "vitest";
import { productLine, searchAnswer, searchText } from "../src/lib/search";

const shop = { id: "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21", name: "Sai General Stores", estimatedMinutes: 15, deliveryFee: "30", open: true, opensAt: null, holiday: false, products: [], moreProducts: 0 };

describe("C16 search (#398)", () => {
  it("searches from 2 characters, trimmed", () => {
    expect([searchText(""), searchText(" a "), searchText(" on "), searchText("kanda")]).toEqual([null, null, "on", "kanda"]);
  });

  it("shows results, no results with the typed text, or the failure", () => {
    expect(searchAnswer("dal", { ok: true, data: { shops: [shop] } })).toEqual({ kind: "results", shops: [shop] });
    expect(searchAnswer("xyz", { ok: true, data: { shops: [] } })).toEqual({ kind: "none", text: "xyz" });
    expect(searchAnswer("dal", { ok: false, status: 500, code: "INTERNAL" })).toEqual({ kind: "failed", message: "Something went wrong on the server." });
    expect(searchAnswer("dal", "offline")).toEqual({ kind: "failed", message: "Check your connection, then try again." });
  });

  it("names each product with its brand and stock, never a price", () => {
    const id = shop.id;
    expect(productLine({ id, name: "Onion", brand: "Fresho", inStock: true })).toBe("Onion · Fresho · In stock");
    expect(productLine({ id, name: "Toor Dal", brand: null, inStock: false })).toBe("Toor Dal · Out of stock");
  });
});
