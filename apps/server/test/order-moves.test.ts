import { describe, expect, it } from "vitest";
import { canMove } from "../src/orders";

describe("delivery order moves", () => {
  it("lets shop members move an accepted order through delivery", () => {
    expect(canMove("accepted", "preparing", "owner")).toBe(true);
    expect(canMove("preparing", "ready", "staff")).toBe(true);
    expect(canMove("ready", "out_for_delivery", "owner")).toBe(true);
    expect(canMove("out_for_delivery", "arrived", "staff")).toBe(true);
    expect(canMove("arrived", "delivered", "staff")).toBe(true);
  });

  it("lets an assigned shop member close a failed delivery", () => {
    expect(canMove("out_for_delivery", "delivery_failed", "staff")).toBe(false);
    expect(canMove("arrived", "delivery_failed", "owner")).toBe(true);
  });

  it("does not let customers or shops skip the delivery workflow", () => {
    expect(canMove("ready", "delivered", "customer")).toBe(false);
    expect(canMove("accepted", "delivered", "owner")).toBe(false);
  });
});
