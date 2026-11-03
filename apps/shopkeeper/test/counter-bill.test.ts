import type { CounterBillResponse, ShopCounterBill, SyncActionCode, SyncActionsBody } from "@ygo/contracts";
import { COUNTER_BILL_EXAMPLES, counterBillTotal } from "@ygo/pricing";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billStatus } from "../src/lib/bill-status";
import { refreshBillVoids } from "../src/lib/bill-voids";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const shopId = "00000000-0000-4000-8000-000000000001", packId = "00000000-0000-4000-8000-000000000002";
const bill = { lines: [{ packId, count: 3, unitPrice: "21" }], total: "63.00", payment: "cash" as const };

describe("the counter-bill examples on the phone (#468, BIL-9)", () => {
  it.each(COUNTER_BILL_EXAMPLES)("$name", (example) => {
    expect(counterBillTotal(example.lines, example.discount)).toBe(example.total);
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

  it("finds a bill of any day by its reference, with or without the dash and in any case, or by its whole number once synced (#53)", () => {
    const older = queue.saveBill(shopId, bill);
    if (typeof older === "string") throw new Error(older);
    answer(queue.batch(shopId), [{ status: "applied", number: 7 }]);
    clock = new Date("2030-01-05T10:00:00.000Z");
    const today = queue.saveBill(shopId, bill);
    if (typeof today === "string") throw new Error(today);
    const ids = (query: string) => queue.findBills(shopId, query).map((row) => row.id);

    expect(ids(older.reference)).toEqual([older.id]);
    expect(ids(older.reference.replace("-", "").toLowerCase())).toEqual([older.id]);
    expect(ids(` ${today.reference.slice(0, 6)} `)).toEqual([today.id]);
    expect(queue.findBills(shopId, "7")).toEqual(expect.arrayContaining([expect.objectContaining({ id: older.id, number: 7, status: "synced" })]));
    // Not a reference or a number, or another shop's bill.
    expect(ids("Rice")).toEqual([]);
    expect(queue.findBills("00000000-0000-4000-8000-000000000009", older.reference)).toEqual([]);
  });

  it("finds both a bill whose reference starts with the digits and the bill with that number, newest first (#53)", () => {
    const ids = ["00000000-0000-4000-8000-0000000000d0", "10420000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"];
    db.close(); db = new DatabaseSync(":memory:");
    queue = openingStockQueue(adapter(db), () => ids.shift() ?? randomUUID(), () => clock, { maxActions: 3, maxAgeHours: 72 });
    queue.saveBill(shopId, bill); queue.saveBill(shopId, bill);
    answer(queue.batch(shopId), [{ status: "applied", number: 1 }, { status: "applied", number: 1042 }]);
    expect(queue.findBills(shopId, "1042").map((row) => [row.reference, row.number])).toEqual([["2000-0000", 1042], ["1042-0000", 1]]);
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
    expect(billStatus({ status: "pending", number: null, code: null, voided: null })).toEqual({ text: "Saved on phone · number pending", tone: "muted" });
    expect(billStatus({ status: "synced", number: 1042, code: null, voided: null })).toEqual({ text: "Synced · Bill 1042", tone: "muted" });
    expect(billStatus({ status: "held", number: null, code: null, voided: null })).toEqual({ text: "Synced · Number pending · YGo will give this bill a number", tone: "warning" });
    expect(billStatus({ status: "refused", number: null, code: "SHOP_NOT_BILLING", voided: null })).toEqual({
      text: "Not accepted by YGo: Counter billing is open only while your shop is Live or Suspended.", tone: "danger" });
  });
});

describe("voids on the phone's own bills (#493)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  const clock = new Date("2030-01-02T10:00:00.000Z"), today = new Date("2030-01-02T00:00:00.000Z");
  beforeEach(() => { db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID, () => clock); });
  afterEach(() => db.close());

  /** Saves a bill and has the server number it, with `billId` as the server's id for it. */
  function synced(billId: string, number: number | null = 12) {
    const saved = queue.saveBill(shopId, bill);
    if (typeof saved === "string") throw new Error(saved);
    const batch = queue.batch(shopId);
    const result: CounterBillResponse = { billId, reference: saved.reference, number, heldReason: number ? null : "not_listed", totalMismatch: false, recordedAt: clock.toISOString() };
    queue.acknowledge(batch, { results: batch.actions.map((action) => ({ actionId: action.id, sequence: action.sequence, status: "applied" as const, code: null, result, clockSuspect: false })) });
    return saved;
  }
  const serverBill = (id: string, reference: string, voided: ShopCounterBill["voided"]): ShopCounterBill => ({ id, reference, number: 12, total: "63", payment: "cash",
    madeAt: clock.toISOString(), receivedAt: clock.toISOString(), voidUntil: null, voidable: false, voided });
  const firstBills = (index: number) => { const row = queue.bills(shopId, today)[index]; if (!row) throw new Error("no bill"); return row; };
  const voidedAt = { reason: "billed_twice" as const, note: null, createdAt: clock.toISOString() };

  it("shows a void the server reported on the bill's card, in Today's bills, search and S08, and only that bill's", () => {
    const billId = randomUUID(), saved = synced(billId), other = synced(randomUUID(), 13);
    expect(queue.bills(shopId, today).every((row) => row.voided === null)).toBe(true);
    expect(queue.saveVoids([serverBill(billId, saved.reference, voidedAt)])).toBe(true);
    const voided = { reason: "billed_twice", note: null };
    expect(queue.bills(shopId, today).map((row) => [row.id, row.voided])).toEqual([[other.id, null], [saved.id, voided]]);
    expect(queue.findBills(shopId, "12").map((row) => row.voided)).toEqual([voided]);
    expect(queue.findBills(shopId, saved.reference).map((row) => row.voided)).toEqual([voided]);
    expect(queue.overview(today).synced.filter((row) => row.bill?.voided).map((row) => row.id)).toEqual([saved.id]);
    expect(billStatus(firstBills(1))).toEqual({ text: "Voided · Billed twice", tone: "danger" });
  });

  it("keeps an Other note for the card, and never learns the same void twice", () => {
    const billId = randomUUID(), saved = synced(billId), list = [serverBill(billId, saved.reference, { reason: "other", note: "Customer left", createdAt: clock.toISOString() })];
    expect(queue.saveVoids(list)).toBe(true);
    expect(queue.saveVoids(list)).toBe(false);
    expect(billStatus(firstBills(0)).text).toBe("Voided · Other · Customer left");
  });

  it("ignores a void that doesn't match a bill on this phone by both its id and its reference", () => {
    const billId = randomUUID(), saved = synced(billId);
    // Another bill with the same reference (a clash, #467), the right id with another reference, and a bill from another phone.
    queue.saveVoids([serverBill(randomUUID(), saved.reference, voidedAt), serverBill(billId, "FFFF-FFFF", voidedAt), serverBill(randomUUID(), "1234-5678", voidedAt)]);
    expect(firstBills(0).voided).toBeNull();
  });

  it("never forgets a void: an empty or shorter list leaves what is known", () => {
    const billId = randomUUID(), saved = synced(billId);
    queue.saveVoids([serverBill(billId, saved.reference, voidedAt)]);
    expect(queue.saveVoids([])).toBe(false);
    expect(queue.saveVoids([serverBill(billId, saved.reference, null)])).toBe(false);
    expect(firstBills(0).voided).toEqual({ reason: "billed_twice", note: null });
  });

  it("shows no void on a bill that isn't synced and numbered", () => {
    const saved = queue.saveBill(shopId, bill);
    if (typeof saved === "string") throw new Error(saved);
    expect(billStatus({ status: "pending", number: null, code: null, voided: { reason: "billed_twice", note: null } }).text).toBe("Saved on phone · number pending");
    expect(firstBills(0).voided).toBeNull();
  });
});

describe("refreshing the phone's voids (#493)", () => {
  const list = (id: string): ShopCounterBill => ({ id, reference: "AAAA-BBBB", number: 1, total: "5", payment: "cash", madeAt: "2030-01-02T10:00:00.000Z", receivedAt: "2030-01-02T10:00:00.000Z",
    voidUntil: null, voidable: false, voided: { reason: "wrong_item", note: null, createdAt: "2030-01-02T10:00:00.000Z" } });
  const keeper = () => { const saved: ShopCounterBill[][] = []; return { saved, queue: { saveVoids: (bills: ShopCounterBill[]) => { saved.push(bills); return true; } } }; };

  it("saves a good answer, and does nothing when the phone is offline, the server refuses or the read throws", async () => {
    const good = keeper();
    expect(await refreshBillVoids({ shopCounterBills: async () => ({ ok: true, data: { bills: [list("x")] } }) } as never, good.queue)).toBe(true);
    expect(good.saved).toHaveLength(1);
    const none = keeper();
    expect(await refreshBillVoids({ shopCounterBills: async () => ({ ok: false, code: "SHOP_NOT_FOUND" }) } as never, none.queue)).toBe(false);
    expect(await refreshBillVoids({ shopCounterBills: async () => { throw new Error("offline"); } } as never, none.queue)).toBe(false);
    expect(none.saved).toEqual([]);
  });

  it("saves nothing when the account changed while the server answered", async () => {
    const away = keeper();
    expect(await refreshBillVoids({ shopCounterBills: async () => ({ ok: true, data: { bills: [list("x")] } }) } as never, away.queue, () => false)).toBe(false);
    expect(away.saved).toEqual([]);
  });

  it("says nothing was learned when saving on the phone fails", async () => {
    const queue = { saveVoids: () => { throw new Error("database closed"); } };
    expect(await refreshBillVoids({ shopCounterBills: async () => ({ ok: true, data: { bills: [list("x")] } }) } as never, queue)).toBe(false);
  });
});
