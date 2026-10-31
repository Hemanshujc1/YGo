import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";
import type { SyncChangesResponse } from "@ygo/contracts";
const shopId = randomUUID(), packId = randomUUID();
const item = { listingId: randomUUID(), packId, name: "Rice", packQuantity: "1", baseUnit: "kg" as const, quantity: "7", held: "0", outOfStock: false };
const page = (revision: number, changes: SyncChangesResponse["changes"] = [{ packId, item, deletedAt: null }]): SyncChangesResponse => ({ shopId, state: "live", cursor: `${shopId}:${revision}`, changes });
let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
beforeEach(() => { db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID); });
afterEach(() => db.close());
it("keeps cache separate from the queue across reopen and empty incremental pulls", () => {
  queue.cache.apply(page(1)); queue.saveFlag(shopId, packId, true);
  queue = openingStockQueue(adapter(db), randomUUID);
  expect(queue.cache.cursor(shopId)).toBe(`${shopId}:1`);
  queue.cache.apply(page(1, []), `${shopId}:1`);
  expect(queue.cache.read(shopId)?.items).toEqual([item]);
  expect(queue.flag(shopId, packId)?.action.payload).toEqual({ packId, outOfStock: true });
  expect(queue.cache.read(randomUUID())).toBeNull();
});
it("rolls back every row and cursor if page storage fails; safely retries the same page", () => {
  queue.cache.apply(page(1));
  db.exec("CREATE TRIGGER disk_full BEFORE UPDATE ON stock_cache_shops BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const next = page(2, [{ packId, item: { ...item, quantity: "9" }, deletedAt: null }]);
  expect(() => queue.cache.apply(next, `${shopId}:1`)).toThrow("disk full");
  expect(queue.cache.cursor(shopId)).toBe(`${shopId}:1`);
  expect(queue.cache.read(shopId)?.items[0]?.quantity).toBe("7");
  db.exec("DROP TRIGGER disk_full");
  queue.cache.apply(next, `${shopId}:1`);
  expect(queue.cache.read(shopId)?.items[0]?.quantity).toBe("9");
  expect(() => queue.cache.apply(page(1))).toThrow("Stale");
  expect(() => queue.cache.apply(page(3), `${shopId}:1`)).toThrow("Stale");
});
it("keeps a tombstoned pending row until acknowledgement, retaining failure records after hiding it", () => {
  queue.cache.apply(page(1)); queue.saveFlag(shopId, packId, true);
  queue.cache.apply(page(2, [{ packId, item: null, deletedAt: new Date().toISOString() }]), `${shopId}:1`);
  expect(queue.cache.read(shopId)?.items).toEqual([{ ...item, unavailable: true }]);
  const batch = queue.batch(shopId);
  queue.acknowledge(batch, { results: batch.actions.map((action) => ({ actionId: action.id, sequence: action.sequence, status: "rejected", code: "NOT_FOUND", result: null, clockSuspect: false })) });
  expect(queue.cache.read(shopId)?.items).toEqual([]);
  expect(queue.cache.removedFailures(shopId)).toEqual(batch.actions.map((action) => action.id));
  expect(queue.failureCount()).toBe(1);
  queue.cache.apply(page(3));
  expect(queue.cache.read(shopId)?.items).toEqual([item]);
});

it("upgrades v4 without changing queued originals", () => {
  queue.saveFlag(shopId, packId, true);
  const original = queue.batch(shopId);
  db.exec("DROP TABLE stock_cache_items; DROP TABLE stock_cache_shops; PRAGMA user_version = 4");
  queue = openingStockQueue(adapter(db), randomUUID);
  expect(queue.batch(shopId)).toMatchObject({ deviceId: original.deviceId, actions: original.actions });
  expect(queue.cache.cursor(shopId)).toBeUndefined();
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
});
it("reads a Stock item saved before #436 without held, then the next pull adds it", () => {
  queue.cache.apply(page(1));
  db.prepare("UPDATE stock_cache_items SET payload = json_remove(payload, '$.held')").run();
  expect(queue.cache.read(shopId)?.items[0]?.held).toBeUndefined();
  queue.cache.apply(page(2, [{ packId, item: { ...item, quantity: "5", held: "2" }, deletedAt: null }]), `${shopId}:1`);
  expect(queue.cache.read(shopId)?.items).toEqual([{ ...item, quantity: "5", held: "2" }]);
});
