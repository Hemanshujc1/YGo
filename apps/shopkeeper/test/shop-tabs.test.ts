import { describe, expect, it } from "vitest";
import { tabAt, tabsFor } from "../src/lib/shop-tabs";

describe("which tabs the Shopkeeper phone shows (#550)", () => {
  it("shows none until the shop answers orders, or while the phone knows no role", () => {
    expect(tabsFor({ answersOrders: false, role: "owner", canDeliver: true })).toBeNull();
    expect(tabsFor({ answersOrders: true, role: null, canDeliver: false })).toBeNull();
  });

  it("gives the Owner all five, Deliveries included", () => {
    expect(tabsFor({ answersOrders: true, role: "owner", canDeliver: false })).toEqual(["orders", "bill", "stock", "deliveries", "more"]);
  });

  it("gives Staff Deliveries only with can deliver", () => {
    expect(tabsFor({ answersOrders: true, role: "staff", canDeliver: true })).toContain("deliveries");
    expect(tabsFor({ answersOrders: true, role: "staff", canDeliver: false })).toEqual(["orders", "bill", "stock", "more"]);
  });

  it("knows a tab only by its exact route, so a drill-down screen has no bar", () => {
    expect(tabAt("/orders")).toBe("orders");
    expect(tabAt("/more")).toBe("more");
    for (const path of ["/", "/orders/7", "/void-bill", "/staff", "/sync", "/hours"]) expect(tabAt(path)).toBeNull();
  });
});
