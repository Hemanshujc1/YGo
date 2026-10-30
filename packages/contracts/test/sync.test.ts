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

it("requires paired shop identity/state for the explicit access check", async () => {
  const { SyncAccessResponse } = await import("../src/sync");
  for (const state of ["live", "suspended", "approved", "closed"]) expect(SyncAccessResponse.safeParse({ shopId: id, state }).success).toBe(true);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: null }).success).toBe(true);
  expect(SyncAccessResponse.safeParse({ shopId: null, state: "closed" }).success).toBe(false);
  expect(SyncAccessResponse.safeParse({ shopId: id, state: null }).success).toBe(false);
});
