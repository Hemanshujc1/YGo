import { describe, expect, it } from "vitest";
import { AdminCounterBill, AdminCounterBillVoid } from "../src";

const voided = { reason: "other", note: "Typed the wrong price", stockMoved: false, actorName: "Asha", createdAt: "2030-01-03T05:00:00.000Z" };
const id = "00000000-0000-4000-8000-000000000001";
const bill = {
  id, reference: "0F3A-91B1", number: 7, heldReason: null, totalMismatch: true, flaggedDenylist: false, payment: "cash", total: "40.00", checkedTotal: "42.00", clockSuspect: false,
  madeAt: "2030-01-01T00:00:00.000Z", receivedAt: "2030-01-01T00:00:00.000Z", madeBy: { name: "Asha", role: "owner" }, lines: [], manualLines: [], discount: "0.00",
  invalidPayload: null, original: null, voided: null, resolved: false, resolutions: [],
};

describe("Admin counter bill voids (#495)", () => {
  it("reads a bill with no void, a void, and a void by someone who has left", () => {
    expect(AdminCounterBill.safeParse(bill).success).toBe(true);
    expect(AdminCounterBill.safeParse({ ...bill, voided, resolved: true }).success).toBe(true);
    expect(AdminCounterBillVoid.safeParse({ ...voided, actorName: null, note: null, reason: "wrong_item" }).success).toBe(true);
  });

  it("requires the void key and refuses a reason or key it does not know", () => {
    expect(AdminCounterBill.safeParse(Object.fromEntries(Object.entries(bill).filter(([key]) => key !== "voided"))).success).toBe(false);
    expect(AdminCounterBillVoid.safeParse({ ...voided, reason: "because" }).success).toBe(false);
    expect(AdminCounterBillVoid.safeParse({ ...voided, actorId: id }).success).toBe(false);
  });
});
