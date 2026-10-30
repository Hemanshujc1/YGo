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
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
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

  it("retries a held conflict after removal fails without promoting or losing it", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const newer = { ...entry, quantity: "8" };
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, JSON.stringify(entry)]]);
      queue.save(shopId, packId, newer);
      expect(() => queue.importLegacy(shopId, { ...legacy(values), remove: () => { throw new Error("interrupted"); } })).toThrow();
      queue.clear(shopId, packId, newer);
      queue.importLegacy(shopId, legacy(values));
      expect(queue.pending(shopId, packId)).toBeNull();
      expect(queue.count()).toBe(1);
      expect(values.size).toBe(0);
      expect(db.prepare("SELECT payload FROM opening_stock_held").get()?.payload).toBe(JSON.stringify(entry));
    } finally { db.close(); }
  });

  it("preserves multiple legacy versions for one key across import retries", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, "broken version 1"]]);
      expect(() => queue.importLegacy(shopId, { ...legacy(values), remove: () => { throw new Error("interrupted"); } })).toThrow();
      values.set(key, "broken version 2");
      queue.importLegacy(shopId, legacy(values));
      expect(queue.attentionCount()).toBe(2);
      expect(db.prepare("SELECT payload FROM opening_stock_held ORDER BY payload").all()).toEqual([
        { payload: "broken version 1" }, { payload: "broken version 2" },
      ]);
      expect(values.size).toBe(0);
    } finally { db.close(); }
  });

  it("does not remove a legacy value replaced while its earlier bytes are imported", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, "first bytes"]]);
      let read = false;
      const source = { ...legacy(values), getString: () => {
        if (!read) { read = true; values.set(key, "replacement bytes"); return "first bytes"; }
        return values.get(key);
      } };
      const queue = openingStockQueue(adapter(db));
      queue.importLegacy(shopId, source);
      expect(values.get(key)).toBe("replacement bytes");
      queue.importLegacy(shopId, legacy(values));
      expect(queue.attentionCount()).toBe(2);
      expect(values.size).toBe(0);
    } finally { db.close(); }
  });

  it("migrates existing held records without losing their bytes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE opening_stock (shop_id TEXT, pack_id TEXT, payload TEXT, PRIMARY KEY(shop_id, pack_id));
        CREATE TABLE opening_stock_held (source_key TEXT PRIMARY KEY, payload TEXT);
        INSERT INTO opening_stock_held VALUES ('old-key', 'original bytes'); PRAGMA user_version = 1;`);
      expect(openingStockQueue(adapter(db)).attentionCount()).toBe(1);
      expect(db.prepare("SELECT payload FROM opening_stock_held").get()?.payload).toBe("original bytes");
    } finally { db.close(); }
  });

  it("recovers a chosen version atomically, preserving originals and blocking sign-out until sync", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      const newer = { ...entry, quantity: "8" };
      const key = `opening:${shopId}:${packId}`;
      queue.save(shopId, packId, newer);
      queue.importLegacy(shopId, legacy(new Map([[key, JSON.stringify(entry)]])));
      expect(queue.heldPacks(shopId)).toEqual([packId]);
      expect(queue.versions(shopId, packId).map((version) => version.entry)).toEqual(expect.arrayContaining([entry, newer]));
      queue.recover(shopId, packId, packId, entry);
      expect(queue.pending(shopId, packId)).toEqual(entry);
      expect(queue.attentionCount()).toBe(0); expect(queue.count()).toBe(1);
      expect(db.prepare("SELECT payload FROM opening_stock_recovered").all().map((row) => row.payload)).toEqual(expect.arrayContaining([JSON.stringify(entry), JSON.stringify(newer)]));
      await syncQueuedOpeningStock(queue, shopId, packId, async () => ({ ok: true }));
      expect(queue.count()).toBe(0);
      // A leftover plaintext source must not resurrect a recovered version.
      queue.importLegacy(shopId, legacy(new Map([[key, JSON.stringify(newer)]])));
      expect(queue.count()).toBe(0);
      expect(db.prepare("SELECT count(*) AS count FROM opening_stock_recovered").get()?.count).toBe(2);
    } finally { db.close(); }
  });

  it("recovers malformed bytes into a corrected product without overwriting other pending work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:bad-pack`, "broken bytes"]])));
      queue.save(shopId, packId, entry);
      expect(() => queue.recover(shopId, "bad-pack", packId, entry)).toThrow("Target stock");
      expect(queue.attentionCount()).toBe(1);
      queue.clear(shopId, packId, entry);
      queue.recover(shopId, "bad-pack", packId, entry);
      expect(queue.pending(shopId, packId)).toEqual(entry);
      expect(queue.count()).toBe(1);
      expect(db.prepare("SELECT payload FROM opening_stock_recovered").get()?.payload).toBe("broken bytes");
    } finally { db.close(); }
  });

  it("rolls recovery back on write failure and rejects invalid corrections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db));
      queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:${packId}`, "broken bytes"]])));
      expect(() => queue.recover(shopId, packId, packId, { ...entry, quantity: "bad" })).toThrow();
      db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON opening_stock BEGIN SELECT RAISE(ABORT, 'disk full'); END");
      expect(() => queue.recover(shopId, packId, packId, entry)).toThrow("disk full");
      expect(queue.attentionCount()).toBe(1); expect(queue.pending(shopId, packId)).toBeNull();
      expect(db.prepare("SELECT count(*) AS count FROM opening_stock_recovered").get()?.count).toBe(0);
    } finally { db.close(); }
  });

  it("refuses a future schema without overwriting its contents", () => {
    const db = new DatabaseSync(":memory:");
    try {
      openingStockQueue(adapter(db)).save(shopId, packId, entry);
      db.exec("PRAGMA user_version = 3");
      expect(() => openingStockQueue(adapter(db))).toThrow("newer app");
      expect(db.prepare("SELECT payload FROM opening_stock").get()?.payload).toBe(JSON.stringify(entry));
    } finally { db.close(); }
  });
});
