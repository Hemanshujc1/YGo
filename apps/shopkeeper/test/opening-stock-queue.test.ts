import type { SyncActionsBody } from "@ygo/contracts";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapter, legacy } from "./stock-database-fixture";

import { openingStockQueue, refreshListingsAfterConflict, refreshListingsForQueuedConflicts, replaceListingsFromRefresh, syncOpeningStockBatch } from "../src/lib/opening-stock-queue";

const shopId = "00000000-0000-4000-8000-000000000001";
const packId = "00000000-0000-4000-8000-000000000002";
const entry = { quantity: "2.5", clientId: "00000000-0000-4000-8000-000000000003" };

function acknowledge(queue: ReturnType<typeof openingStockQueue>, batch: SyncActionsBody = queue.batch(shopId)) {
  queue.acknowledge(batch, { results: batch.actions.map((action) => ({ actionId: action.id, sequence: action.sequence,
    status: "applied", code: null, result: { listingId: packId, quantity: entry.quantity, recordedAt: new Date().toISOString() }, clockSuspect: false })) });
}

describe("offline opening stock", () => {
  let db: DatabaseSync;
  let queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => { db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID); });
  afterEach(() => db.close());

  it("keeps pending stock scoped to a shop and pack until the server confirms it", () => {
    queue.save(shopId, packId, entry);
    expect(queue.pending(shopId, packId)).toEqual(entry);
    expect(queue.pending("00000000-0000-4000-8000-000000000004", packId)).toBeNull();
    acknowledge(queue);
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

  it("keeps local stock when refreshing after a conflict fails, and applies a successful refresh", async () => {
    queue.save(shopId, packId, entry);
    const current = [{ packId, stock: "0", openingStockRecorded: false }];
    const refreshed = [{ packId, stock: "5.000", openingStockRecorded: true }];
    const fail = async () => { throw new Error("offline"); };
    expect(await refreshListingsAfterConflict(current, fail)).toEqual({ kind: "failed" });
    expect(await refreshListingsForQueuedConflicts(current, [{ packId }], fail)).toEqual({ kind: "failed", packIds: [packId] });
    expect(await refreshListingsForQueuedConflicts(current, [{ packId }], async () => refreshed)).toEqual({ kind: "refreshed", items: refreshed, packIds: [packId] });
    expect(replaceListingsFromRefresh(current, refreshed)).toEqual(refreshed);
    expect(queue.pending(shopId, packId)).toEqual(entry);
  });

});

describe("opening-stock durability", () => {
  it("reopens pending work with the same id, and preserves it on an already-migrated open", () => {
    const directory = mkdtempSync(join(tmpdir(), "ygo-stock-"));
    const filename = join(directory, "stock.db");
    try {
      let db = new DatabaseSync(filename);
      openingStockQueue(adapter(db), randomUUID).save(shopId, packId, entry);
      db.close();
      db = new DatabaseSync(filename);
      const queue = openingStockQueue(adapter(db), randomUUID);
      expect(queue.pending(shopId, packId)).toEqual(entry);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      db.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("imports only the verified shop, and retries interruption after commit without duplicating", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
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
      const queue = openingStockQueue(adapter(db), randomUUID);
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, JSON.stringify(entry)]]);
      db.exec("PRAGMA query_only = ON");
      expect(() => queue.importLegacy(shopId, legacy(values))).toThrow();
      expect(values.get(key)).toBe(JSON.stringify(entry));
      expect(queue.count()).toBe(0);
    } finally { db.close(); }
  });

  it("retains conflicting legacy bytes and never lets an old acknowledgement erase newer work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
      queue.save(shopId, packId, entry);
      const oldBatch = queue.batch(shopId);
      const newer = { ...entry, clientId: randomUUID(), quantity: "8" };
      queue.save(shopId, packId, newer);
      queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:${packId}`, JSON.stringify(entry)]])));
      acknowledge(queue, oldBatch);
      expect(queue.pending(shopId, packId)).toEqual(newer);
      expect(queue.count()).toBe(2); expect(queue.attentionCount()).toBe(1);
    } finally { db.close(); }
  });

  it("retries a held conflict after removal fails without promoting or losing it", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
      const newer = { ...entry, quantity: "8" };
      const key = `opening:${shopId}:${packId}`;
      const values = new Map([[key, JSON.stringify(entry)]]);
      queue.save(shopId, packId, newer);
      const beforeImport = queue.batch(shopId);
      expect(() => queue.importLegacy(shopId, { ...legacy(values), remove: () => { throw new Error("interrupted"); } })).toThrow();
      acknowledge(queue, beforeImport);
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
      const queue = openingStockQueue(adapter(db), randomUUID);
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
      const queue = openingStockQueue(adapter(db), randomUUID);
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
      expect(openingStockQueue(adapter(db), randomUUID).attentionCount()).toBe(1);
      expect(db.prepare("SELECT payload FROM opening_stock_held").get()?.payload).toBe("original bytes");
    } finally { db.close(); }
  });

  it("recovers a chosen version atomically, preserving originals and blocking sign-out until sync", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
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
      const batch = queue.batch(shopId);
      queue.acknowledge(batch, { results: [{ actionId: entry.clientId, sequence: batch.actions[0]?.sequence ?? 1, status: "applied", code: null,
        result: { listingId: packId, quantity: entry.quantity, recordedAt: new Date().toISOString() }, clockSuspect: false }] });
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
      const queue = openingStockQueue(adapter(db), randomUUID);
      queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:bad-pack`, "broken bytes"]])));
      queue.save(shopId, packId, entry);
      expect(() => queue.recover(shopId, "bad-pack", packId, entry)).toThrow("Target stock");
      expect(queue.attentionCount()).toBe(1);
      acknowledge(queue);
      const corrected = { ...entry, clientId: randomUUID() };
      queue.recover(shopId, "bad-pack", packId, corrected);
      expect(queue.pending(shopId, packId)).toEqual(corrected);
      expect(queue.count()).toBe(1);
      expect(db.prepare("SELECT payload FROM opening_stock_recovered").get()?.payload).toBe("broken bytes");
    } finally { db.close(); }
  });

  it("rolls recovery back on write failure and rejects invalid corrections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
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
      openingStockQueue(adapter(db), randomUUID).save(shopId, packId, entry);
      db.exec("PRAGMA user_version = 4");
      expect(() => openingStockQueue(adapter(db), randomUUID)).toThrow("newer app");
      expect(db.prepare("SELECT payload FROM opening_stock").get()?.payload).toBe(JSON.stringify(entry));
    } finally { db.close(); }
  });
});

describe("durable ordered action records", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DatabaseSync(":memory:"); });
  afterEach(() => db.close());
  const applied = (id: string, sequence: number) => ({ actionId: id, sequence, status: "applied" as const, code: null,
    result: { listingId: packId, quantity: "2.5", recordedAt: "2030-01-01T00:00:00.000Z" }, clockSuspect: false });

  it("migrates original IDs with an explicit unknown timestamp and persists new action times", () => {
    db.exec(`CREATE TABLE opening_stock (shop_id TEXT, pack_id TEXT, payload TEXT, PRIMARY KEY(shop_id, pack_id));
      CREATE TABLE opening_stock_held (source_key TEXT, payload TEXT, PRIMARY KEY(source_key, payload));
      CREATE TABLE opening_stock_recovered (source_key TEXT, payload TEXT, replacement TEXT, PRIMARY KEY(source_key, payload)); PRAGMA user_version = 2;`);
    db.prepare("INSERT INTO opening_stock VALUES (?, ?, ?)").run(shopId, packId, JSON.stringify(entry));
    const time = new Date("2030-01-01T00:00:00.000Z");
    const queue = openingStockQueue(adapter(db), randomUUID, () => time);
    const first = queue.batch(shopId);
    expect(first.actions[0]).toMatchObject({ id: entry.clientId, sequence: 1, createdAt: time.toISOString(), clockSuspect: true });
    time.setUTCDate(2);
    expect(queue.batch(shopId).actions).toEqual(first.actions);
    const next = { ...entry, clientId: randomUUID() };
    queue.save(shopId, randomUUID(), next);
    expect(queue.batch(shopId).actions[1]).toMatchObject({ id: next.clientId, sequence: 2, createdAt: time.toISOString(), clockSuspect: false });
  });

  it("retains rejected originals, stops retrying them, and queues a correction with a fresh sequence", async () => {
    const queue = openingStockQueue(adapter(db), randomUUID);
    queue.save(shopId, packId, entry);
    await syncOpeningStockBatch(queue, shopId, async (body) => ({ ok: true, data: { results: [{ ...applied(entry.clientId, body.actions[0]?.sequence ?? 1), status: "rejected", code: "VALIDATION_FAILED", result: null }] } }));
    expect(queue.count()).toBe(0); expect(queue.failureCount()).toBe(1);
    expect(queue.pending(shopId, packId)).toEqual(entry);
    expect(queue.batch(shopId).actions).toEqual([]);
    const corrected = { quantity: "3", clientId: randomUUID() };
    queue.save(shopId, packId, corrected);
    expect(queue.batch(shopId).actions[0]).toMatchObject({ id: corrected.clientId, sequence: 2 });
    expect(queue.count()).toBe(1);
    expect(db.prepare("SELECT action FROM opening_stock_actions WHERE id = ?").get(entry.clientId)?.action).toContain('"quantity":"2.5"');
  });

  it("retains pending actions on a bad acknowledgement or an interrupted acknowledgement transaction", () => {
    const queue = openingStockQueue(adapter(db), randomUUID);
    queue.save(shopId, packId, entry);
    const batch = queue.batch(shopId);
    expect(() => queue.acknowledge(batch, { results: [applied(randomUUID(), 1)] })).toThrow("Unexpected");
    db.exec("CREATE TRIGGER fail_ack BEFORE DELETE ON opening_stock BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => queue.acknowledge(batch, { results: [applied(entry.clientId, 1)] })).toThrow("disk full");
    expect(queue.count()).toBe(1);
    expect(db.prepare("SELECT status FROM opening_stock_actions").get()?.status).toBe("pending");
  });

  it("does not resurrect acknowledged work when an interrupted legacy removal retries", () => {
    const queue = openingStockQueue(adapter(db), randomUUID);
    const values = new Map([[`opening:${shopId}:${packId}`, JSON.stringify(entry)]]);
    expect(() => queue.importLegacy(shopId, { ...legacy(values), remove: () => { throw new Error("interrupted"); } })).toThrow();
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: [applied(entry.clientId, 1)] });
    queue.importLegacy(shopId, legacy(values));
    expect(queue.count()).toBe(0); expect(values.size).toBe(0);
  });

  it("shares one in-flight batch and refuses to mutate its saved payload", async () => {
    const queue = openingStockQueue(adapter(db), randomUUID);
    queue.save(shopId, packId, entry);
    const send = vi.fn(async () => ({ ok: false as const }));
    const first = syncOpeningStockBatch(queue, shopId, send);
    const second = syncOpeningStockBatch(queue, shopId, send);
    expect(first).toBe(second);
    expect(() => queue.save(shopId, packId, { ...entry, quantity: "8" })).toThrow("immutable");
    await first;
    expect(send).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT attempts, last_attempt_at FROM opening_stock_actions").get()).toMatchObject({ attempts: 1, last_attempt_at: expect.any(String) });
  });
});
