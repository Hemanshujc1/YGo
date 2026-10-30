import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapter, legacy } from "./stock-database-fixture";

import { openingStockQueue, refreshListingsAfterConflict, refreshListingsForQueuedConflicts, replaceListingsFromRefresh, syncQueuedOpeningStock } from "../src/lib/opening-stock-queue";

const shopId = "00000000-0000-4000-8000-000000000001";
const packId = "00000000-0000-4000-8000-000000000002";
const entry = { quantity: "2.5", clientId: "00000000-0000-4000-8000-000000000003" };

describe("offline opening stock", () => {
  let db: DatabaseSync;
  let queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => { db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db)); });
  afterEach(() => db.close());

  it("keeps pending stock scoped to a shop and pack until the server confirms it", () => {
    queue.save(shopId, packId, entry);
    expect(queue.pending(shopId, packId)).toEqual(entry);
    expect(queue.pending("00000000-0000-4000-8000-000000000004", packId)).toBeNull();
    queue.clear(shopId, packId, entry);
    expect(queue.pending(shopId, packId)).toBeNull();
  });

  it("preserves malformed imports for attention and refuses to overwrite them", () => {
    const values = new Map([[`opening:${shopId}:${packId}`, "not json"]]);
    queue.importLegacy(shopId, legacy(values));
    expect(queue.pending(shopId, packId)).toBeNull();
    expect(queue.attentionCount()).toBe(1);
    expect(queue.count()).toBe(1);
    expect(() => queue.save(shopId, packId, entry)).toThrow("needs attention");
    expect(db.prepare("SELECT payload FROM opening_stock_held").get()?.payload).toBe("not json");
    expect(values.size).toBe(0);
  });

  it("retries a failed request with the same id until success, then clears the queue", async () => {
    queue.save(shopId, packId, entry);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true });

    expect(await syncQueuedOpeningStock(queue, shopId, packId, send)).toEqual({ kind: "pending", code: null });
    expect(queue.pending(shopId, packId)).toEqual(entry);
    expect(await syncQueuedOpeningStock(queue, shopId, packId, send)).toEqual({ kind: "synced" });
    expect(send).toHaveBeenNthCalledWith(1, entry);
    expect(send).toHaveBeenNthCalledWith(2, entry);
    expect(queue.pending(shopId, packId)).toBeNull();
  });

  it("retains a conflicting queued quantity instead of silently discarding it", async () => {
    queue.save(shopId, packId, entry);
    const result = await syncQueuedOpeningStock(queue, shopId, packId, async () => ({ ok: false, code: "OPENING_STOCK_ALREADY_RECORDED" }));
    const current = [{ packId, stock: "0", openingStockRecorded: false }];
    const refreshed = [{ packId, stock: "5.000", openingStockRecorded: true }];

    expect(result).toEqual({ kind: "pending", code: "OPENING_STOCK_ALREADY_RECORDED" });
    expect(replaceListingsFromRefresh(current, refreshed)).toEqual(refreshed);
    expect(queue.pending(shopId, packId)).toEqual(entry);
  });

  it("keeps the queued quantity when refreshing listings after a stock conflict fails", async () => {
    queue.save(shopId, packId, entry);
    const result = await syncQueuedOpeningStock(queue, shopId, packId, async () => ({ ok: false, code: "OPENING_STOCK_ALREADY_RECORDED" }));
    const current = [{ packId, stock: "0", openingStockRecorded: false }];
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));

    expect(result).toEqual({ kind: "pending", code: "OPENING_STOCK_ALREADY_RECORDED" });
    expect(await refreshListingsAfterConflict(current, refresh)).toEqual({ kind: "failed" });
    expect(refresh).toHaveBeenCalledOnce();
    expect(queue.pending(shopId, packId)).toEqual(entry);

    const serverListings = [{ packId, stock: "5.000", openingStockRecorded: true }];
    expect(await refreshListingsAfterConflict(current, async () => serverListings)).toEqual({
      kind: "refreshed",
      items: serverListings,
    });
    expect(queue.pending(shopId, packId)).toEqual(entry);
  });

  it("refreshes listings after a startup conflict and reports failed refresh for retry", async () => {
    queue.save(shopId, packId, entry);
    const sync = await syncQueuedOpeningStock(queue, shopId, packId, async () => ({ ok: false, code: "OPENING_STOCK_ALREADY_RECORDED" }));
    const current = [{ packId, stock: "0", openingStockRecorded: false }];
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));

    expect(sync).toEqual({ kind: "pending", code: "OPENING_STOCK_ALREADY_RECORDED" });
    expect(await refreshListingsForQueuedConflicts(current, [{ packId }], refresh)).toEqual({
      kind: "failed",
      packIds: [packId],
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(queue.pending(shopId, packId)).toEqual(entry);
  });
});

describe("opening-stock durability", () => {
  it("reopens pending work with the same id, and preserves it on an already-migrated open", () => {
    const directory = mkdtempSync(join(tmpdir(), "ygo-stock-"));
    const filename = join(directory, "stock.db");
    try {
      let db = new DatabaseSync(filename);
      openingStockQueue(adapter(db)).save(shopId, packId, entry);
      db.close();
      db = new DatabaseSync(filename);
      const queue = openingStockQueue(adapter(db));
      expect(queue.pending(shopId, packId)).toEqual(entry);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      db.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("imports only the verified shop, and retries interruption after commit without duplicating", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, JSON.stringify(entry)], ["opening:another:pack", JSON.stringify(entry)]]);
      const source = legacy(values);
      expect(() => queue.importLegacy(shopId, { ...source, remove: () => { throw new Error("killed after commit"); } })).toThrow();
      expect(values.has(key)).toBe(true);
      expect(queue.pending(shopId, packId)).toEqual(entry);
      queue.importLegacy(shopId, source);
      expect(queue.count()).toBe(1);
      expect(values.has(key)).toBe(false);
      expect(values.has("opening:another:pack")).toBe(true);
    } finally { db.close(); }
  });

  it("keeps the plaintext source when the encrypted import cannot commit", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, JSON.stringify(entry)]]);
      db.exec("PRAGMA query_only = ON");
      expect(() => queue.importLegacy(shopId, legacy(values))).toThrow();
      expect(values.get(key)).toBe(JSON.stringify(entry));
      expect(queue.count()).toBe(0);
    } finally { db.close(); }
  });

  it("retains a conflicting legacy record and never lets an old reply erase a newer edit", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const newer = { ...entry, quantity: "8" };
      queue.save(shopId, packId, newer);
      queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:${packId}`, JSON.stringify(entry)]])));
      queue.clear(shopId, packId, entry);
      expect(queue.pending(shopId, packId)).toEqual(newer);
      expect(queue.count()).toBe(2);
      expect(queue.attentionCount()).toBe(1);
    } finally { db.close(); }
  });

  it("refuses a future schema without overwriting its contents", () => {
    const db = new DatabaseSync(":memory:");
    try {
      openingStockQueue(adapter(db)).save(shopId, packId, entry);
      db.exec("PRAGMA user_version = 2");
      expect(() => openingStockQueue(adapter(db))).toThrow("newer app");
      expect(db.prepare("SELECT payload FROM opening_stock").get()?.payload).toBe(JSON.stringify(entry));
    } finally { db.close(); }
  });
});
