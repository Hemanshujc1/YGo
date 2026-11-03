import { describe, expect, it } from "vitest";
import { SyncActionsBody, SyncActionsResponse } from "../src/sync";
const id = "00000000-0000-4000-8000-000000000391";
const action = { id, sequence: 1, shopId: id, type: "opening_stock", payload: { quantity: "broken" }, createdAt: "2030-01-01T00:00:00.000Z", clockSuspect: false };
describe("batch sync contracts", () => {
  it("validates the envelope while leaving malformed payloads for per-action rejection", () => {
    const body = { deviceId: id, sentAt: action.createdAt, actions: [action] };
    expect(SyncActionsBody.safeParse(body).success).toBe(true);
    for (const actions of [[], [{ ...action, sequence: 0 }], Array(501).fill(action)]) expect(SyncActionsBody.safeParse({ ...body, actions }).success).toBe(false);
  });
  it("refuses an acknowledgement that claims success without a server result", () => {
    expect(SyncActionsResponse.safeParse({ results: [{ actionId: id, sequence: 1, status: "applied", code: null, result: null, clockSuspect: false }] }).success).toBe(false);
  });
});

it("accepts boolean flag results and keeps payloads strict", async () => {
  const { StockFlagPayload, ShopStockResponse } = await import("../src/sync");
  expect(StockFlagPayload.safeParse({ packId: id, outOfStock: true }).success).toBe(true);
  for (const outOfStock of ["true", 1, null]) expect(StockFlagPayload.safeParse({ packId: id, outOfStock }).success).toBe(false);
  expect(StockFlagPayload.safeParse({ packId: id, outOfStock: false, quantity: "0" }).success).toBe(false);
  expect(SyncActionsResponse.safeParse({ results: [{ actionId: id, sequence: 1, status: "applied", code: null,
    result: { listingId: id, outOfStock: false, recordedAt: action.createdAt }, clockSuspect: false }] }).success).toBe(true);
  expect(ShopStockResponse.safeParse({ shopId: id, state: "approved", items: [] }).success).toBe(false);
});

it("validates shop-scoped cursors and paired Stock rows/tombstones", async () => {
  const { SyncChangesQuery, SyncChangesResponse } = await import("../src/sync");
  const page = { shopId: id, state: "live", cursor: `${id}:1`, changes: [{ packId: id, item: null, deletedAt: action.createdAt }] };
  expect(SyncChangesResponse.safeParse(page).success).toBe(true);
  expect(SyncChangesResponse.safeParse({ ...page, cursor: `${id}:01` }).success).toBe(false);
  expect(SyncChangesResponse.safeParse({ ...page, changes: [{ ...page.changes[0], deletedAt: null }] }).success).toBe(false);
  expect(SyncChangesQuery.safeParse({ since: "2030-01-01" }).success).toBe(false);
  expect(SyncChangesQuery.safeParse({ since: `${id}:0` }).success).toBe(true);
});

it("requires paired shop identity/state for the explicit access check, and a name only with a shop (#53), and a role exactly when there is a shop (#494)", async () => {
  const { SyncAccessResponse } = await import("../src/sync");
  for (const state of ["live", "suspended", "approved", "closed"]) expect(SyncAccessResponse.safeParse({ shopId: id, state, shopName: "Sai", role: "owner" }).success).toBe(true);
  expect(SyncAccessResponse.safeParse({ shopId: id, state: "approved", shopName: null, role: "staff" }).success).toBe(true);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: null, shopName: null, role: null }).success).toBe(true);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: null, shopName: "Sai", role: null }).success).toBe(false);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: "closed", shopName: null, role: null }).success).toBe(false);
  expect(SyncAccessResponse.safeParse({ shopId: id, state: "live", shopName: null, role: null }).success).toBe(false);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: null, shopName: null, role: "owner" }).success).toBe(false);
  expect(SyncAccessResponse.safeParse({ shopId: id, state: null, shopName: null, role: "owner" }).success).toBe(false);
});

it("keeps counter bills to whole packs of distinct listings with exact amounts, and pairs a number with no held reason", async () => {
  const { CounterBillPayload, CounterBillResponse, counterBillReference } = await import("../src/sync");
  const other = "00000000-0000-4000-8000-000000000468";
  const bill = { lines: [{ packId: id, count: 2, unitPrice: "99.50" }, { packId: other, count: 1, unitPrice: "0" }], total: "199", payment: "cash" };
  expect(CounterBillPayload.safeParse(bill).success).toBe(true);
  for (const change of [{ lines: [] }, { lines: [bill.lines[0], bill.lines[0]] }, { lines: [{ ...bill.lines[0], count: 1.5 }] },
    { lines: [{ ...bill.lines[0], unitPrice: "1.005" }] }, { total: "1.005" }, { total: 199 }, { payment: "card" }, { discount: "1.005" }, { discount: 1 }]) {
    expect(CounterBillPayload.safeParse({ ...bill, ...change }).success).toBe(false);
  }
  // The largest bill: 100 distinct packs, each 9,999 at the largest shop price (#471).
  const largest = { lines: Array.from({ length: 100 }, (_, index) => ({ packId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, count: 9999, unitPrice: "9999999999.99" })),
    total: "9998999999990001", payment: "upi" };
  expect(CounterBillPayload.safeParse(largest).success).toBe(true);
  expect(CounterBillPayload.safeParse({ ...largest, total: "99989999999900010" }).success).toBe(false);
  expect(counterBillReference("0f3a91bc-0000-4000-8000-000000000001")).toBe("0F3A-91BC");
  const answer = { billId: id, reference: "0F3A-91BC", number: 1, heldReason: null, totalMismatch: false, recordedAt: action.createdAt };
  expect(CounterBillResponse.safeParse(answer).success).toBe(true);
  expect(CounterBillResponse.safeParse({ ...answer, number: null, heldReason: "too_old" }).success).toBe(true);
  expect(CounterBillResponse.safeParse({ ...answer, heldReason: "too_old" }).success).toBe(false);
  expect(CounterBillResponse.safeParse({ ...answer, number: null }).success).toBe(false);
});

it("takes typed lines, a discount and a customer on a counter bill, and refuses what could not be billed (#53)", async () => {
  const { CounterBillPayload } = await import("../src/sync");
  const base = { lines: [{ packId: id, count: 1, unitPrice: "21" }], total: "21", payment: "cash" };
  const typed = { name: "Loose sugar", count: 3, unitPrice: "12.50" };
  expect(CounterBillPayload.safeParse({ ...base, lines: [], manualLines: [typed] }).success).toBe(true);
  expect(CounterBillPayload.safeParse({ ...base, manualLines: [typed], discount: "9.50", customer: { name: "Meena Rao", phone: "98123 45678", offers: true } }).data?.customer?.phone).toBe("+919812345678");
  expect(CounterBillPayload.safeParse({ ...base, customer: { phone: "+919812345678", offers: false } }).success).toBe(true);
  for (const change of [{ lines: [], manualLines: [] }, { manualLines: [{ ...typed, name: "  " }] }, { manualLines: [{ ...typed, name: "x".repeat(81) }] },
    { manualLines: [{ ...typed, name: "a\0b" }] }, { manualLines: [{ ...typed, name: "a\ud800" }] }, { manualLines: [{ ...typed, packId: id }] },
    { manualLines: [{ ...typed, unitPrice: "1.005" }] }, { customer: { offers: false } }, { customer: { name: "Meena", offers: true } },
    { customer: { name: "Meena", phone: "12345", offers: false } }, { customer: { name: "M", offers: false, note: "x" } }]) {
    expect(CounterBillPayload.safeParse({ ...base, ...change }).success).toBe(false);
  }
  // One hundred lines in all, catalog and typed together.
  const many = (length: number) => Array.from({ length }, (_, index) => ({ ...typed, name: `Item ${index}` }));
  expect(CounterBillPayload.safeParse({ ...base, manualLines: many(99) }).success).toBe(true);
  expect(CounterBillPayload.safeParse({ ...base, manualLines: many(100) }).success).toBe(false);
});
