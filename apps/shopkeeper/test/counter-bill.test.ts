import type { CounterBillResponse, SyncActionCode, SyncActionsBody } from "@ygo/contracts";
import { COUNTER_BILL_EXAMPLES, counterBillTotal } from "@ygo/pricing";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billStatus } from "../src/lib/bill-status";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const shopId = "00000000-0000-4000-8000-000000000001", packId = "00000000-0000-4000-8000-000000000002";
const bill = { lines: [{ packId, count: 3, unitPrice: "21" }], total: "63.00", payment: "cash" as const };

describe("the counter-bill examples on the phone (#468, BIL-9)", () => {
  it.each(COUNTER_BILL_EXAMPLES)("$name", (example) => {
    expect(counterBillTotal(example.lines)).toBe(example.total);
  });
});

describe("counter bills in the ordered queue (#468)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>, clock: Date;
  beforeEach(() => {
    clock = new Date("2030-01-02T10:00:00.000Z");
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID, () => clock, { maxActions: 3, maxAgeHours: 72 });
  });
  afterEach(() => db.close());

  function answer(batch: SyncActionsBody, rows: Array<{ status: "applied" | "rejected"; number?: number | null; code?: SyncActionCode }>) {
    queue.acknowledge(batch, { results: batch.actions.map((action, i) => {
      const row = rows[i] ?? { status: "applied" };
      const result: CounterBillResponse = { billId: randomUUID(), reference: "0000-0000", number: row.number ?? null,
        heldReason: row.number ? null : "not_listed", totalMismatch: false, recordedAt: clock.toISOString() };
      return row.status === "applied" ? { actionId: action.id, sequence: action.sequence, status: "applied", code: null, result, clockSuspect: false }
        : { actionId: action.id, sequence: action.sequence, status: "rejected", code: row.code ?? "VALIDATION_FAILED", result: null, clockSuspect: false };
    }) });
  }

  it("queues a bill as one action after earlier stock changes, with a reference from its id, and counts it in the offline room", () => {
    queue.saveFlag(shopId, packId, true);
    const saved = queue.saveBill(shopId, bill);
    if (typeof saved === "string") throw new Error(saved);
    expect(saved.reference).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(queue.batch(shopId).actions.map((action) => [action.type, action.payload])).toEqual([["stock_flag", { packId, outOfStock: true }], ["counter_bill", bill]]);
    expect(queue.count()).toBe(2); expect(queue.billCount()).toBe(1);
    expect(queue.bills(shopId, new Date("2030-01-02T00:00:00.000Z"))).toMatchObject([{ id: saved.id, reference: saved.reference, status: "pending", number: null, ...bill }]);
  });

  it("refuses a bill past the offline limit and a malformed one", () => {
    for (let i = 0; i < 3; i++) queue.saveBill(shopId, bill);
    expect(queue.saveBill(shopId, bill)).toBe("queueFull");
    expect(() => queue.saveBill(shopId, { ...bill, lines: [] })).toThrow();
    expect(queue.count()).toBe(3);
  });

  it("keeps a synced bill with its number, and a held one, after the server answers; later days list only bills still waiting or refused", () => {
    const first = queue.saveBill(shopId, bill), second = queue.saveBill(shopId, bill), third = queue.saveBill(shopId, bill);
    answer(queue.batch(shopId), [{ status: "applied", number: 1042 }, { status: "applied", number: null }, { status: "rejected", code: "SHOP_NOT_BILLING" }]);
    const today = new Date("2030-01-02T00:00:00.000Z");
    expect(queue.bills(shopId, today).map((row) => [row.id, row.status, row.number, row.code])).toEqual([
      [(third as { id: string }).id, "refused", null, "SHOP_NOT_BILLING"], [(second as { id: string }).id, "held", null, null], [(first as { id: string }).id, "synced", 1042, null],
    ]);
    expect(queue.count()).toBe(0); expect(queue.billCount()).toBe(0);
    // A synced or held bill stays on S08, newest first, for the day it synced.
    expect(queue.overview(today).synced.map((row) => row.bill?.status)).toEqual(["held", "synced"]);
    clock = new Date("2030-01-03T10:00:00.000Z");
    expect(queue.bills(shopId, new Date("2030-01-03T00:00:00.000Z")).map((row) => row.status)).toEqual(["refused"]);
  });

  it("keeps a refused bill in Needs attention after a later bill syncs, since no later bill replaces it", () => {
    queue.saveBill(shopId, bill);
    answer(queue.batch(shopId), [{ status: "rejected", code: "SHOP_NOT_BILLING" }]);
    queue.saveBill(shopId, bill);
    answer(queue.batch(shopId), [{ status: "applied", number: 1 }]);
    expect(queue.failureCount()).toBe(1);
    expect(queue.overview(new Date(0)).attention.map((row) => [row.type, row.bill?.status, row.code])).toEqual([["counter_bill", "refused", "SHOP_NOT_BILLING"]]);
  });

  it("shows waiting bills on S08 without naming a pack", () => {
    queue.saveBill(shopId, bill);
    expect(queue.overview(new Date(0)).waiting).toMatchObject([{ type: "counter_bill", label: null, bill: { status: "pending", total: "63.00", payment: "cash" } }]);
  });
});

describe("a bill's status line (#468)", () => {
  it("says pending, synced with its number, held for YGo in warning, or refused with the reason in danger", () => {
    expect(billStatus({ status: "pending", number: null, code: null })).toEqual({ text: "Saved on phone · number pending", tone: "muted" });
    expect(billStatus({ status: "synced", number: 1042, code: null })).toEqual({ text: "Synced · Bill 1042", tone: "muted" });
    expect(billStatus({ status: "held", number: null, code: null })).toEqual({ text: "Synced · Number pending · YGo will give this bill a number", tone: "warning" });
    expect(billStatus({ status: "refused", number: null, code: "SHOP_NOT_BILLING" })).toEqual({
      text: "Not accepted by YGo: Counter billing is open only while your shop is Live or Suspended.", tone: "danger" });
  });
});
