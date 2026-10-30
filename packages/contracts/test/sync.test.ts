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
