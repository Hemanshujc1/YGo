import { beforeEach, describe, expect, it, vi } from "vitest";

const { values } = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => values.get(key),
    set: (key: string, value: string) => values.set(key, value),
    remove: (key: string) => values.delete(key),
  }),
}));

import { clearOpeningStock, pendingOpeningStock, queueOpeningStock, syncQueuedOpeningStock } from "../src/lib/opening-stock-queue";

const shopId = "00000000-0000-4000-8000-000000000001";
const packId = "00000000-0000-4000-8000-000000000002";
const entry = { quantity: "2.5", clientId: "00000000-0000-4000-8000-000000000003" };

describe("offline opening stock", () => {
  beforeEach(() => values.clear());

  it("keeps pending stock scoped to a shop and pack until the server confirms it", () => {
    queueOpeningStock(shopId, packId, entry);
    expect(pendingOpeningStock(shopId, packId)).toEqual(entry);
    expect(pendingOpeningStock("00000000-0000-4000-8000-000000000004", packId)).toBeNull();
    clearOpeningStock(shopId, packId);
    expect(pendingOpeningStock(shopId, packId)).toBeNull();
  });

  it("discards malformed local records instead of syncing them", () => {
    values.set(`opening:${shopId}:${packId}`, "not json");
    expect(pendingOpeningStock(shopId, packId)).toBeNull();
    expect(values.has(`opening:${shopId}:${packId}`)).toBe(false);
  });

  it("retries a failed request with the same id until success, then clears the queue", async () => {
    queueOpeningStock(shopId, packId, entry);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true });

    expect(await syncQueuedOpeningStock(shopId, packId, send)).toEqual({ kind: "pending", code: null });
    expect(pendingOpeningStock(shopId, packId)).toEqual(entry);
    expect(await syncQueuedOpeningStock(shopId, packId, send)).toEqual({ kind: "synced" });
    expect(send).toHaveBeenNthCalledWith(1, entry);
    expect(send).toHaveBeenNthCalledWith(2, entry);
    expect(pendingOpeningStock(shopId, packId)).toBeNull();
  });

  it("retains a conflicting queued quantity instead of silently discarding it", async () => {
    queueOpeningStock(shopId, packId, entry);
    const result = await syncQueuedOpeningStock(shopId, packId, async () => ({ ok: false, code: "OPENING_STOCK_ALREADY_RECORDED" }));

    expect(result).toEqual({ kind: "pending", code: "OPENING_STOCK_ALREADY_RECORDED" });
    expect(pendingOpeningStock(shopId, packId)).toEqual(entry);
  });
});
