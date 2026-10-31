import type { SyncActionCode, SyncActionsBody } from "@ygo/contracts";
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

  it("queues corrections as ordered actions after the opening, each its own change, and clears them once acknowledged (#452)", () => {
    queue.save(shopId, packId, entry);
    const first = queue.saveCorrection(shopId, packId, "2");
    const second = queue.saveCorrection(shopId, packId, "1.5");
    expect(first).toEqual({ id: expect.any(String) });
    expect(queue.correctionWaiting(shopId, packId)).toBe("1.5");
    expect(queue.correctionWaiting(shopId, "00000000-0000-4000-8000-000000000004")).toBeNull();
    const batch = queue.batch(shopId);
    expect(batch.actions.map((action) => [action.type, action.sequence])).toEqual([["opening_stock", 1], ["opening_stock_correction", 2], ["opening_stock_correction", 3]]);
    expect(batch.actions.map((action) => action.id)).toEqual([entry.clientId, (first as { id: string }).id, (second as { id: string }).id]);
    acknowledge(queue, batch);
    expect(queue.correctionWaiting(shopId, packId)).toBeNull();
    expect(queue.count()).toBe(0);
  });

  it("counts a correction against the offline limit and refuses a malformed total", () => {
    const small = openingStockQueue(adapter(db), randomUUID, () => new Date(), { maxActions: 1, maxAgeHours: 72 });
    expect(small.saveCorrection(shopId, packId, "3")).toEqual({ id: expect.any(String) });
    expect(small.saveCorrection(shopId, packId, "4")).toBe("queueFull");
    expect(() => small.saveCorrection(shopId, packId, "-1")).toThrow();
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
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
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
      db.exec("PRAGMA user_version = 7");
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

  it.each(["applied", "rejected"] as const)("preserves and recovers a changed legacy version reusing a %s ID", (status) => {
    const queue = openingStockQueue(adapter(db), randomUUID);
    queue.save(shopId, packId, entry);
    const batch = queue.batch(shopId);
    const result = applied(entry.clientId, 1);
    queue.acknowledge(batch, { results: [status === "applied" ? result : { ...result, status: "rejected", code: "VALIDATION_FAILED", result: null }] });
    const changed = { ...entry, quantity: "8" };
    const values = new Map([[`opening:${shopId}:${packId}`, JSON.stringify(changed)]]);
    queue.importLegacy(shopId, legacy(values));
    expect(queue.versions(shopId, packId)).toEqual(expect.arrayContaining([{ payload: JSON.stringify(changed), entry: changed }]));
    expect(queue.count()).toBe(1); expect(queue.attentionCount()).toBe(1);
    expect(db.prepare("SELECT action FROM opening_stock_actions").get()?.action).toContain('"quantity":"2.5"');
    expect(values.size).toBe(0);
    queue.recover(shopId, packId, packId, changed);
    const recovered = queue.pending(shopId, packId);
    expect(recovered?.quantity).toBe("8"); expect(recovered?.clientId).not.toBe(entry.clientId);
    expect(queue.batch(shopId).actions[0]).toMatchObject({ id: recovered?.clientId, sequence: 2 });
    expect(queue.count()).toBe(1);
    expect(db.prepare("SELECT payload FROM opening_stock_recovered WHERE payload = ?").get(JSON.stringify(changed))?.payload).toBe(JSON.stringify(changed));
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


describe("Stock flags share the durable FIFO", () => {
  it("reopens rapid opposite toggles with distinct IDs, after older opening stock", () => {
    const directory = mkdtempSync(join(tmpdir(), "ygo-flag-"));
    const path = join(directory, "stock.db");
    let db = new DatabaseSync(path);
    try {
      let queue = openingStockQueue(adapter(db), randomUUID);
      queue.save(shopId, packId, entry);
      queue.saveFlag(shopId, packId, true); queue.saveFlag(shopId, packId, false);
      const before = queue.batch(shopId);
      expect(before.actions.map((action) => [action.sequence, action.type])).toEqual([[1, "opening_stock"], [2, "stock_flag"], [3, "stock_flag"]]);
      expect(new Set(before.actions.map((action) => action.id)).size).toBe(3);
      expect(queue.count()).toBe(3); expect(queue.flagCount()).toBe(2);
      db.close(); db = new DatabaseSync(path); queue = openingStockQueue(adapter(db), randomUUID);
      expect(queue.batch(shopId).actions).toEqual(before.actions);
      queue.attempted(before);
      queue.acknowledge(before, { results: before.actions.map((action) => ({ actionId: action.id, sequence: action.sequence, status: "applied", code: null, clockSuspect: false,
        result: action.type === "opening_stock" ? { listingId: packId, quantity: "2.5", recordedAt: new Date().toISOString() }
          : { listingId: packId, outOfStock: action.sequence === 2, recordedAt: new Date().toISOString() } })) });
      expect(queue.count()).toBe(0); expect(queue.flag(shopId, packId)?.status).toBe("applied");
      expect(queue.flag("other-shop", packId)).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM opening_stock_actions").get()?.n).toBe(3);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains rejected originals and makes a new ID for a correction; later independent flags can apply", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
      queue.saveFlag(shopId, packId, true);
      const batch = queue.batch(shopId), first = batch.actions[0];
      if (!first) throw new Error("Missing saved flag");
      queue.acknowledge(batch, { results: [{ actionId: first.id, sequence: 1, status: "rejected", code: "ACTION_TOO_OLD", result: null, clockSuspect: false }] });
      expect(queue.count()).toBe(0); expect(queue.failureCount()).toBe(1); expect(queue.batch(shopId).actions).toEqual([]);
      expect(queue.flag(shopId, packId)?.result?.code).toBe("ACTION_TOO_OLD");
      queue.saveFlag(shopId, packId, true);
      expect(queue.flag(shopId, packId)?.action.id).not.toBe(first.id);
      expect(queue.batch(shopId).actions[0]?.sequence).toBe(2);
      expect(db.prepare("SELECT status FROM opening_stock_actions WHERE id = ?").get(first.id)?.status).toBe("rejected");
    } finally { db.close(); }
  });
});

it("blocks new flags at configurable count/time limits while retaining the original actions", () => {
  const db = new DatabaseSync(":memory:");
  let now = new Date("2030-01-01T00:00:00Z");
  try {
    const queue = openingStockQueue(adapter(db), randomUUID, () => now, { maxActions: 2, maxAgeHours: 1 });
    expect(queue.saveFlag(shopId, packId, true)).toBeNull();
    now = new Date("2030-01-01T01:00:00Z");
    expect(queue.saveFlag(shopId, packId, false)).toBe("queueExpired");
    now = new Date("2030-01-01T00:30:00Z");
    expect(queue.saveFlag(shopId, packId, false)).toBeNull();
    expect(queue.saveFlag(shopId, packId, true)).toBe("queueFull");
    expect(queue.batch(shopId).actions).toHaveLength(2);
  } finally { db.close(); }
});

it("lets held legacy stock recover after an independent flag is queued for the same pack", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const queue = openingStockQueue(adapter(db), randomUUID);
    queue.importLegacy(shopId, legacy(new Map([[`opening:${shopId}:${packId}`, "broken original"]])));
    queue.saveFlag(shopId, packId, true);
    expect(queue.batch(shopId).actions.map((action) => action.type)).toEqual(["stock_flag"]);
    expect(() => queue.recover(shopId, packId, packId, entry)).not.toThrow();
    expect(queue.batch(shopId).actions.map((action) => action.type)).toEqual(["stock_flag", "opening_stock"]);
    expect(db.prepare("SELECT payload FROM opening_stock_recovered").get()?.payload).toBe("broken original");
  } finally { db.close(); }
});

describe("S08 overview and the shared allowance (#395)", () => {
  function answer(queue: ReturnType<typeof openingStockQueue>, status: "applied" | "rejected" | "retry", code: SyncActionCode | null = null) {
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: batch.actions.map((action) => ({ actionId: action.id, sequence: action.sequence, status, code,
      result: status !== "applied" ? null : action.type === "stock_flag" ? { listingId: packId, outOfStock: true, recordedAt: new Date().toISOString() }
        : { listingId: packId, quantity: "2.5", recordedAt: new Date().toISOString() }, clockSuspect: false })) });
  }

  it("lists Needs attention, Waiting to sync and Synced today; a newer accepted change supersedes a refusal", () => {
    const db = new DatabaseSync(":memory:");
    let now = new Date("2030-01-01T09:00:00Z");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID, () => now);
      queue.cache.apply({ shopId, state: "live", cursor: `${shopId}:1`, changes: [{ packId, deletedAt: null,
        item: { packId, listingId: packId, name: "Rice", packQuantity: "1", baseUnit: "kg", quantity: "7", held: "0", outOfStock: false } }] });
      queue.saveFlag(shopId, packId, true);
      answer(queue, "rejected", "ACTION_TOO_OLD");
      const refused = queue.overview(new Date("2030-01-01T00:00:00Z"));
      expect(refused.attention).toMatchObject([{ type: "stock_flag", outOfStock: true, code: "ACTION_TOO_OLD", label: { name: "Rice" } }]);
      expect(queue.failureCount()).toBe(1);
      // Saved but unqueued opening stock is never hidden.
      queue.save(shopId, "00000000-0000-4000-8000-000000000009", entry);
      queue.saveFlag(shopId, packId, false);
      const waiting = queue.overview(new Date("2030-01-01T00:00:00Z")).waiting;
      expect(waiting.map((row) => [row.type, row.quantity ?? row.outOfStock])).toEqual([["opening_stock", "2.5"], ["stock_flag", false]]);
      // A retry answer keeps the work waiting, with no acceptance time.
      answer(queue, "retry", "SEQUENCE_MISSING");
      expect(queue.overview(new Date(0)).waiting).toHaveLength(2);
      now = new Date("2030-01-01T10:00:00Z");
      answer(queue, "applied");
      const after = queue.overview(new Date("2030-01-01T00:00:00Z"));
      expect(after.attention).toEqual([]);
      expect(queue.failureCount()).toBe(0);
      expect(after.waiting).toEqual([]);
      expect(after.synced.map((row) => row.at)).toEqual(["2030-01-01T10:00:00.000Z", "2030-01-01T10:00:00.000Z"]);
      // Only today's acceptances are listed.
      expect(queue.overview(new Date("2030-01-02T00:00:00Z")).synced).toEqual([]);
    } finally { db.close(); }
  });

  it("settles an 'already recorded' refusal: the server holds that pack's opening stock and refuses any other", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
      queue.save(shopId, packId, entry);
      answer(queue, "rejected", "OPENING_STOCK_ALREADY_RECORDED");
      expect(queue.overview(new Date(0)).attention).toEqual([]); expect(queue.failureCount()).toBe(0);
    } finally { db.close(); }
  });

  it("keeps a refusal open while the newer change only waits, and lists held legacy stock for attention", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID);
      queue.saveFlag(shopId, packId, true); answer(queue, "rejected", "ACTION_TOO_OLD");
      queue.saveFlag(shopId, packId, true);
      const view = queue.overview(new Date(0));
      expect(view.attention).toHaveLength(1); expect(view.waiting).toHaveLength(1);
      db.exec("INSERT INTO opening_stock_held VALUES ('opening:" + shopId + ":" + packId + "', 'broken')");
      expect(queue.overview(new Date(0)).attention.map((row) => row.type)).toEqual(["held", "stock_flag"]);
    } finally { db.close(); }
  });

  it("applies one count and time allowance to opening stock and Stock changes, and reports it for the meter", () => {
    const db = new DatabaseSync(":memory:");
    let now = new Date("2030-01-01T00:00:00Z");
    try {
      const queue = openingStockQueue(adapter(db), randomUUID, () => now, { maxActions: 2, maxAgeHours: 3 });
      expect(queue.allowance()).toEqual({ used: 0, max: 2, hoursLeft: 3 });
      expect(queue.save(shopId, packId, entry)).toBeNull();
      now = new Date("2030-01-01T01:30:00Z");
      expect(queue.allowance()).toEqual({ used: 1, max: 2, hoursLeft: 2 });
      // Replacing an unsent count adds nothing; a second pack fills the queue.
      expect(queue.save(shopId, packId, { ...entry, quantity: "4" })).toBeNull();
      expect(queue.saveFlag(shopId, "00000000-0000-4000-8000-000000000009", true)).toBeNull();
      expect(queue.save(shopId, "00000000-0000-4000-8000-000000000010", { ...entry, clientId: randomUUID() })).toBe("queueFull");
      expect(queue.saveFlag(shopId, packId, true)).toBe("queueFull");
      now = new Date("2030-01-01T04:30:00Z");
      expect(queue.allowance().hoursLeft).toBe(0);
      expect(queue.save(shopId, packId, { quantity: "5", clientId: randomUUID() })).toBe("queueExpired");
      expect(queue.overview(new Date(0)).waiting).toHaveLength(2);
    } finally { db.close(); }
  });

  it("upgrades a version 5 phone to record acceptance times without touching queued work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const first = openingStockQueue(adapter(db), randomUUID);
      first.saveFlag(shopId, packId, true);
      db.exec("ALTER TABLE opening_stock_actions DROP COLUMN acknowledged_at; PRAGMA user_version = 5");
      const queue = openingStockQueue(adapter(db), randomUUID);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
      expect(queue.count()).toBe(1);
      answer(queue, "applied");
      expect(db.prepare("SELECT acknowledged_at FROM opening_stock_actions").get()?.acknowledged_at).toEqual(expect.any(String));
    } finally { db.close(); }
  });
});
