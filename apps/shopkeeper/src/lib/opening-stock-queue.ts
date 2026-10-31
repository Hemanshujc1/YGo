import { stockCache } from "./stock-cache";
import { OFFLINE_LIMITS } from "./offline-limits";
import { OpeningStockPayload, StockFlagPayload, SyncActionsResponse, type SyncAction, type SyncActionsBody, type SyncActionResult, OpeningStockBody, type OpeningStockBody as OpeningStockEntry } from "@ygo/contracts";
import type { SQLiteDatabase } from "expo-sqlite";

type Database = Pick<SQLiteDatabase, "execSync" | "getAllSync" | "getFirstSync" | "runSync" | "withTransactionSync">;
type Legacy = { getAllKeys(): string[]; getString(key: string): string | undefined; remove(key: string): boolean };

function parse(raw: string): OpeningStockEntry | null {
  try {
    const result = OpeningStockBody.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}

/** One account's encrypted database; shop and pack remain part of each key. */
export function openingStockQueue(db: Database, newId: () => string, now = () => new Date(), limits: { maxActions: number; maxAgeHours: number } = OFFLINE_LIMITS) {
  const schema = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  if (!schema) throw new Error("Could not read opening stock schema");
  const version = schema.user_version;
  if (version > 6) throw new Error("Opening stock database needs a newer app");
  if (version === 0) db.withTransactionSync(() => {
    db.execSync(`CREATE TABLE opening_stock (shop_id TEXT NOT NULL, pack_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (shop_id, pack_id));
      CREATE TABLE opening_stock_held (source_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version = 1;`);
  });

  if (version < 2) db.withTransactionSync(() => {
    db.execSync(`ALTER TABLE opening_stock_held RENAME TO opening_stock_held_v1;
      CREATE TABLE opening_stock_held (source_key TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (source_key, payload));
      INSERT INTO opening_stock_held SELECT source_key, payload FROM opening_stock_held_v1;
      DROP TABLE opening_stock_held_v1;
      CREATE TABLE opening_stock_recovered (source_key TEXT NOT NULL, payload TEXT NOT NULL,
        replacement TEXT NOT NULL, PRIMARY KEY (source_key, payload));
      PRAGMA user_version = 2;`);
  });

  if (version < 3) db.withTransactionSync(() => {
    db.execSync(`ALTER TABLE opening_stock ADD COLUMN created_at TEXT;
      ALTER TABLE opening_stock ADD COLUMN clock_suspect INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE sync_device (id TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE opening_stock_actions (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, shop_id TEXT NOT NULL,
        pack_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT, result TEXT);
      PRAGMA user_version = 3;`);
    db.runSync("INSERT INTO sync_device VALUES (?, 0)", newId());
    db.runSync("UPDATE opening_stock SET created_at = ?", now().toISOString());
  });

  if (version < 4) db.withTransactionSync(() => db.execSync("PRAGMA user_version = 4;"));

  if (version < 5) db.withTransactionSync(() => db.execSync(`CREATE TABLE stock_cache_shops (shop_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE stock_cache_items (shop_id TEXT NOT NULL, pack_id TEXT NOT NULL, payload TEXT NOT NULL, deleted_at TEXT, acknowledged_flag INTEGER,
      PRIMARY KEY (shop_id, pack_id)); PRAGMA user_version = 5;`));

  // When the server answered, so S08 can list what synced today.
  if (version < 6) db.withTransactionSync(() => db.execSync(`ALTER TABLE opening_stock_actions ADD COLUMN acknowledged_at TEXT;
    CREATE INDEX IF NOT EXISTS opening_stock_actions_pack ON opening_stock_actions (shop_id, pack_id, sequence); PRAGMA user_version = 6;`));

  // A refusal stays open until a newer change of the same kind to the same pack is accepted.
  // "Already recorded" is settled: the server holds opening stock for that pack and refuses
  // any other, and Opening stock shows it as recorded.
  const openRefusal = `a.status = 'rejected' AND json_extract(a.result, '$.code') IS NOT 'OPENING_STOCK_ALREADY_RECORDED' AND NOT EXISTS (SELECT 1 FROM opening_stock_actions n WHERE n.shop_id = a.shop_id AND n.pack_id = a.pack_id
    AND json_extract(n.action, '$.type') = json_extract(a.action, '$.type') AND n.sequence > a.sequence AND n.status = 'applied')`;
  // Opening stock saved on the phone but not yet given a place in the ordered queue.
  const unqueued = "NOT EXISTS (SELECT 1 FROM opening_stock_actions q WHERE q.id = json_extract(o.payload, '$.clientId'))";

  function oldestWaiting(): string | null {
    return db.getFirstSync<{ at: string | null }>(`SELECT min(at) AS at FROM (SELECT json_extract(action, '$.createdAt') AS at FROM opening_stock_actions WHERE status = 'pending'
      UNION ALL SELECT created_at FROM opening_stock o WHERE ${unqueued})`)?.at ?? null;
  }

  /** The one BIL-3 check for every new piece of offline work. */
  function blocked(used: number, adding: boolean): "queueFull" | "queueExpired" | null {
    if (adding && used >= limits.maxActions) return "queueFull";
    const oldest = oldestWaiting();
    return oldest && now().getTime() - Date.parse(oldest) >= limits.maxAgeHours * 3600_000 ? "queueExpired" : null;
  }

  function label(shopId: string, packId: string): { name: string; packQuantity: string; baseUnit: string } | null {
    const row = db.getFirstSync<{ payload: string }>("SELECT payload FROM stock_cache_items WHERE shop_id = ? AND pack_id = ?", shopId, packId);
    return row ? JSON.parse(row.payload) as { name: string; packQuantity: string; baseUnit: string } : null;
  }

  function failed(shopId: string, packId: string): SyncActionResult | null {
    const row = db.getFirstSync<{ result: string }>(`SELECT a.result FROM opening_stock_actions a JOIN opening_stock o
      ON o.shop_id = a.shop_id AND o.pack_id = a.pack_id AND json_extract(o.payload, '$.clientId') = a.id
      WHERE a.shop_id = ? AND a.pack_id = ? AND a.status = 'rejected'`, shopId, packId);
    return row ? JSON.parse(row.result) as SyncActionResult : null;
  }

  return {
    cache: stockCache(db),
    flag(shopId: string, packId: string): { action: SyncAction; status: string; result: SyncActionResult | null } | null {
      const row = db.getFirstSync<{ action: string; status: string; result: string | null }>(`SELECT action, status, result FROM opening_stock_actions
        WHERE shop_id = ? AND pack_id = ? AND json_extract(action, '$.type') = 'stock_flag' ORDER BY sequence DESC LIMIT 1`, shopId, packId);
      return row ? { action: JSON.parse(row.action) as SyncAction, status: row.status, result: row.result ? JSON.parse(row.result) as SyncActionResult : null } : null;
    },
    saveFlag(shopId: string, packId: string, outOfStock: boolean) {
      const payload = StockFlagPayload.parse({ packId, outOfStock });
      // Enrol older opening stock before allocating this change's sequence.
      this.batch(shopId);
      const stop = blocked(this.count(), true);
      if (stop) return stop;
      db.withTransactionSync(() => {
        const device = db.getFirstSync<{ sequence: number }>("SELECT sequence FROM sync_device");
        if (!device) throw new Error("Missing sync device");
        const action: SyncAction = { id: newId(), sequence: device.sequence + 1, shopId, type: "stock_flag", payload,
          createdAt: now().toISOString(), clockSuspect: false };
        db.runSync("INSERT INTO opening_stock_actions (id, sequence, shop_id, pack_id, action) VALUES (?, ?, ?, ?, ?)", action.id, action.sequence, shopId, packId, JSON.stringify(action));
        db.runSync("UPDATE sync_device SET sequence = ?", action.sequence);
      });
      return null;
    },
    /** Queue a correction of a recorded opening count (#452). Each one is its own action, so corrections apply in order and the last wins. */
    saveCorrection(shopId: string, packId: string, quantity: string): { id: string } | "queueFull" | "queueExpired" {
      const payload = OpeningStockPayload.parse({ packId, quantity });
      // Enrol older opening stock before allocating this change's sequence.
      this.batch(shopId);
      const stop = blocked(this.count(), true);
      if (stop) return stop;
      const id = newId();
      db.withTransactionSync(() => {
        const device = db.getFirstSync<{ sequence: number }>("SELECT sequence FROM sync_device");
        if (!device) throw new Error("Missing sync device");
        const action: SyncAction = { id, sequence: device.sequence + 1, shopId, type: "opening_stock_correction", payload,
          createdAt: now().toISOString(), clockSuspect: false };
        db.runSync("INSERT INTO opening_stock_actions (id, sequence, shop_id, pack_id, action) VALUES (?, ?, ?, ?, ?)", action.id, action.sequence, shopId, packId, JSON.stringify(action));
        db.runSync("UPDATE sync_device SET sequence = ?", action.sequence);
      });
      return { id };
    },
    /** The corrected total still waiting to sync for a pack, or null. */
    correctionWaiting(shopId: string, packId: string): string | null {
      return db.getFirstSync<{ quantity: string }>(`SELECT json_extract(action, '$.payload.quantity') AS quantity FROM opening_stock_actions
        WHERE shop_id = ? AND pack_id = ? AND status = 'pending' AND json_extract(action, '$.type') = 'opening_stock_correction' ORDER BY sequence DESC LIMIT 1`, shopId, packId)?.quantity ?? null;
    },
    flagCount(): number {
      return db.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM opening_stock_actions WHERE status = 'pending' AND json_extract(action, '$.type') = 'stock_flag'")?.count ?? 0;
    },
    failed,
    failureCount(): number {
      return db.getFirstSync<{ count: number }>(`SELECT count(*) AS count FROM opening_stock_actions a WHERE ${openRefusal}`)?.count ?? 0;
    },
    batch(shopId: string): SyncActionsBody {
      let deviceId = "";
      const actions: SyncAction[] = [];
      db.withTransactionSync(() => {
        const device = db.getFirstSync<{ id: string; sequence: number }>("SELECT * FROM sync_device");
        if (!device) throw new Error("Missing sync device");
        deviceId = device.id;
        for (const row of db.getAllSync<{ pack_id: string; payload: string; created_at: string; clock_suspect: number }>("SELECT pack_id, payload, created_at, clock_suspect FROM opening_stock WHERE shop_id = ? ORDER BY rowid", shopId)) {
          const entry = parse(row.payload);
          if (!entry || db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${row.pack_id}`)
            || db.getFirstSync("SELECT 1 FROM opening_stock_actions WHERE id = ?", entry.clientId)) continue;
          // Legacy entries have no original timestamp: migration time is explicit and flagged.
          const action: SyncAction = { id: entry.clientId, sequence: ++device.sequence, shopId, type: "opening_stock",
            payload: { packId: row.pack_id, quantity: entry.quantity }, createdAt: row.created_at, clockSuspect: row.clock_suspect === 1 };
          db.runSync("INSERT INTO opening_stock_actions (id, sequence, shop_id, pack_id, action) VALUES (?, ?, ?, ?, ?)", action.id, action.sequence, shopId, row.pack_id, JSON.stringify(action));
        }
        db.runSync("UPDATE sync_device SET sequence = ?", device.sequence);
        for (const row of db.getAllSync<{ action: string; pack_id: string }>("SELECT action, pack_id FROM opening_stock_actions WHERE status = 'pending' ORDER BY sequence LIMIT 500")) {
          const action = JSON.parse(row.action) as SyncAction;
          if (action.shopId !== shopId || (action.type === "opening_stock" && db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${row.pack_id}`))) break;
          actions.push(action);
        }
      });
      return { deviceId, sentAt: now().toISOString(), actions };
    },
    attempted(batch: SyncActionsBody) {
      db.withTransactionSync(() => {
        for (const action of batch.actions) db.runSync("UPDATE opening_stock_actions SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND action = ?", now().toISOString(), action.id, JSON.stringify(action));
      });
    },
    acknowledge(batch: SyncActionsBody, response: SyncActionsResponse) {
      const checked = SyncActionsResponse.parse(response);
      if (checked.results.length !== batch.actions.length || checked.results.some((row, i) => row.actionId !== batch.actions[i]?.id || row.sequence !== batch.actions[i]?.sequence)) throw new Error("Unexpected sync results");
      db.withTransactionSync(() => {
        for (const result of checked.results) {
          db.runSync("UPDATE opening_stock_actions SET status = ?, result = ?, acknowledged_at = ? WHERE id = ?", result.status === "retry" ? "pending" : result.status,
            JSON.stringify(result), result.status === "retry" ? null : now().toISOString(), result.actionId);
          if (result.status === "applied") db.runSync("DELETE FROM opening_stock WHERE json_extract(payload, '$.clientId') = ?", result.actionId);
        }
      });
    },
    /** Call only with the shop just verified for this account by the server. */
    importLegacy(shopId: string, legacy: Legacy) {
      const prefix = `opening:${shopId}:`;
      for (const key of legacy.getAllKeys().filter((key) => key.startsWith(prefix))) {
        const raw = legacy.getString(key);
        if (raw === undefined) continue;
        const entry = parse(raw);
        const packId = key.slice(prefix.length);
        db.withTransactionSync(() => {
          // An interrupted removal must not promote an already-held version into the
          // active queue, even if the original active version has since synced.
          if (db.getFirstSync(`SELECT 1 FROM opening_stock_held WHERE source_key = ? AND payload = ?
            UNION ALL SELECT 1 FROM opening_stock_recovered WHERE source_key = ? AND payload = ?`, key, raw, key, raw)) return;
          const acknowledged = entry && db.getFirstSync<{ shop_id: string; pack_id: string; quantity: string }>(`SELECT shop_id, pack_id,
            json_extract(action, '$.payload.quantity') AS quantity FROM opening_stock_actions WHERE id = ? AND status IN ('applied', 'rejected')`, entry.clientId);
          if (acknowledged) {
            if (acknowledged.shop_id !== shopId || acknowledged.pack_id !== packId || acknowledged.quantity !== entry.quantity) {
              db.runSync("INSERT OR IGNORE INTO opening_stock_held VALUES (?, ?)", key, raw);
            }
            return;
          }
          const existing = db.getFirstSync<{ payload: string }>("SELECT payload FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, packId);
          const saved = existing && parse(existing.payload);
          if (entry && (!existing || (saved?.clientId === entry.clientId && saved.quantity === entry.quantity))) {
            db.runSync("INSERT OR IGNORE INTO opening_stock (shop_id, pack_id, payload, created_at) VALUES (?, ?, ?, ?)", shopId, packId, raw, now().toISOString());
          } else {
            // Preserve malformed/conflicting legacy bytes for attention, never send them.
            db.runSync("INSERT OR IGNORE INTO opening_stock_held VALUES (?, ?)", key, raw);
          }
        });
        // A failed removal can safely retry: both inserts are idempotent.
        if (legacy.getString(key) === raw) legacy.remove(key);
      }
    },
    heldPacks(shopId: string): string[] {
      const prefix = `opening:${shopId}:`;
      return db.getAllSync<{ source_key: string }>("SELECT DISTINCT source_key FROM opening_stock_held WHERE source_key LIKE ?", `${prefix}%`)
        .map((row) => row.source_key.slice(prefix.length));
    },
    versions(shopId: string, packId: string) {
      return db.getAllSync<{ payload: string }>(`SELECT payload FROM opening_stock WHERE shop_id = ? AND pack_id = ?
        UNION SELECT payload FROM opening_stock_held WHERE source_key = ?`, shopId, packId, `opening:${shopId}:${packId}`)
        .map(({ payload }) => ({ payload, entry: parse(payload) }));
    },
    recover(shopId: string, sourcePack: string, targetPack: string, entry: OpeningStockEntry) {
      const checked = OpeningStockBody.parse(entry);
      const sourceKey = `opening:${shopId}:${sourcePack}`;
      db.withTransactionSync(() => {
        if (!db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", sourceKey)) throw new Error("No held opening stock");
        if (sourcePack !== targetPack && (db.getFirstSync("SELECT 1 FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, targetPack)
          || db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${targetPack}`))) throw new Error("Target stock needs attention");
        const sent = db.getFirstSync<{ action: string }>("SELECT action FROM opening_stock_actions WHERE shop_id = ? AND pack_id = ? AND status = 'pending' AND json_extract(action, '$.type') = 'opening_stock'", shopId, sourcePack);
        if (sent) {
          const action = JSON.parse(sent.action) as SyncAction;
          if (action.id !== checked.clientId || JSON.stringify(action.payload) !== JSON.stringify({ packId: targetPack, quantity: checked.quantity })) throw new Error("Recover the pending original first");
        }
        // A correction is a new action; keep the acknowledged original and its ID in history.
        if (db.getFirstSync("SELECT 1 FROM opening_stock_actions WHERE id = ? AND status IN ('applied', 'rejected')", checked.clientId)) checked.clientId = newId();
        const replacement = JSON.stringify({ packId: targetPack, ...checked });
        db.runSync(`INSERT OR IGNORE INTO opening_stock_recovered SELECT source_key, payload, ? FROM opening_stock_held WHERE source_key = ?`, replacement, sourceKey);
        db.runSync(`INSERT OR IGNORE INTO opening_stock_recovered SELECT ?, payload, ? FROM opening_stock WHERE shop_id = ? AND pack_id = ?`, sourceKey, replacement, shopId, sourcePack);
        db.runSync("DELETE FROM opening_stock_held WHERE source_key = ?", sourceKey);
        db.runSync("DELETE FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, sourcePack);
        db.runSync("INSERT INTO opening_stock VALUES (?, ?, ?, ?, 0)", shopId, targetPack, JSON.stringify(checked), now().toISOString());
      });
    },
    pending(shopId: string, packId: string): OpeningStockEntry | null {
      const row = db.getFirstSync<{ payload: string }>("SELECT payload FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, packId);
      return row ? parse(row.payload) : null;
    },
    save(shopId: string, packId: string, entry: OpeningStockEntry): "queueFull" | "queueExpired" | null {
      const checked = OpeningStockBody.parse(entry);
      const held = db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${packId}`);
      if (held) throw new Error("Opening stock needs attention");
      const existing = db.getFirstSync<{ action: string }>("SELECT action FROM opening_stock_actions WHERE id = ?", checked.clientId);
      if (existing && JSON.stringify((JSON.parse(existing.action) as SyncAction).payload) !== JSON.stringify({ packId, quantity: checked.quantity })) throw new Error("Queued action is immutable");
      // Replacing an entry that is already counted adds nothing to the allowance.
      const counted = db.getFirstSync(`SELECT 1 FROM opening_stock o WHERE shop_id = ? AND pack_id = ? AND NOT EXISTS
        (SELECT 1 FROM opening_stock_actions a WHERE a.id = json_extract(o.payload, '$.clientId') AND a.status = 'rejected')`, shopId, packId);
      const stop = blocked(this.count(), !counted);
      if (stop) return stop;
      db.runSync(`INSERT INTO opening_stock VALUES (?, ?, ?, ?, 0) ON CONFLICT (shop_id, pack_id)
        DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, clock_suspect = 0`, shopId, packId, JSON.stringify(checked), now().toISOString());
      return null;
    },
    /** The S08 meter: work counted against the allowance, and hours left before the oldest waiting change reaches the limit. */
    allowance(): { used: number; max: number; hoursLeft: number } {
      const oldest = oldestWaiting();
      const left = limits.maxAgeHours * 3600_000 - (oldest ? now().getTime() - Date.parse(oldest) : 0);
      return { used: this.count(), max: limits.maxActions, hoursLeft: Math.max(0, Math.ceil(left / 3600_000)) };
    },
    /** S08's three sections; `since` is the start of today on this phone. */
    overview(since: Date): Record<"attention" | "waiting" | "synced", QueueRow[]> {
      type Raw = { id: string; shop_id: string; pack_id: string; action: string; result: string | null; at: string | null };
      const row = (raw: Raw): QueueRow => {
        const action = JSON.parse(raw.action) as SyncAction;
        const payload = action.payload as { quantity?: string; outOfStock?: boolean };
        const result = raw.result ? JSON.parse(raw.result) as SyncActionResult : null;
        return { id: raw.id, shopId: raw.shop_id, packId: raw.pack_id, type: action.type === "stock_flag" ? "stock_flag" : "opening_stock",
          quantity: payload.quantity, outOfStock: payload.outOfStock, code: result?.code ?? null, at: raw.at, label: label(raw.shop_id, raw.pack_id) };
      };
      const columns = "a.id, a.shop_id, a.pack_id, a.action, a.result";
      const refused = db.getAllSync<Raw>(`SELECT ${columns}, a.acknowledged_at AS at FROM opening_stock_actions a WHERE ${openRefusal} ORDER BY a.sequence`).map(row);
      const held = db.getAllSync<{ id: number; source_key: string; payload: string }>("SELECT rowid AS id, source_key, payload FROM opening_stock_held ORDER BY rowid").map(({ id, source_key, payload }): QueueRow => {
        const [, shopId = "", packId = ""] = source_key.split(":");
        return { id: `held:${id}`, shopId, packId, type: "held", quantity: parse(payload)?.quantity, code: null, at: null, label: label(shopId, packId) };
      });
      const queued = db.getAllSync<Raw>(`SELECT ${columns}, json_extract(a.action, '$.createdAt') AS at FROM opening_stock_actions a WHERE a.status = 'pending' ORDER BY a.sequence`).map(row);
      // Never hide work saved on the phone, even before it is queued.
      const saved = db.getAllSync<{ shop_id: string; pack_id: string; payload: string; created_at: string }>(`SELECT shop_id, pack_id, payload, created_at FROM opening_stock o WHERE ${unqueued} ORDER BY rowid`)
        .map((o): QueueRow => ({ id: parse(o.payload)?.clientId ?? `${o.shop_id}:${o.pack_id}`, shopId: o.shop_id, packId: o.pack_id, type: "opening_stock",
          quantity: parse(o.payload)?.quantity, code: null, at: o.created_at, label: label(o.shop_id, o.pack_id) }));
      const synced = db.getAllSync<Raw>(`SELECT ${columns}, a.acknowledged_at AS at FROM opening_stock_actions a WHERE a.status = 'applied' AND a.acknowledged_at >= ?
        ORDER BY a.acknowledged_at DESC, a.sequence DESC`, since.toISOString()).map(row);
      return { attention: [...held, ...refused], waiting: [...queued, ...saved], synced };
    },
    count(): number {
      const row = db.getFirstSync<{ count: number }>("SELECT (SELECT count(*) FROM opening_stock o WHERE NOT EXISTS (SELECT 1 FROM opening_stock_actions a WHERE a.id = json_extract(o.payload, '$.clientId') AND a.status = 'rejected')) + (SELECT count(*) FROM opening_stock_held) AS count");
      if (!row) throw new Error("Could not count opening stock");
      const corrections = db.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM opening_stock_actions WHERE status = 'pending' AND json_extract(action, '$.type') = 'opening_stock_correction'");
      return row.count + this.flagCount() + (corrections?.count ?? 0);
    },
    attentionCount(): number {
      const row = db.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM opening_stock_held");
      if (!row) throw new Error("Could not count held opening stock");
      return row.count;
    },
  };
}

export type OpeningStockQueue = ReturnType<typeof openingStockQueue>;
export type QueueRow = { id: string; shopId: string; packId: string; type: "opening_stock" | "stock_flag" | "held"; quantity?: string; outOfStock?: boolean;
  code: string | null; at: string | null; label: { name: string; packQuantity: string; baseUnit: string } | null };

export function replaceListingsFromRefresh<T extends { packId: string }>(current: T[], refreshed: T[]): T[] {
  const refreshedByPack = new Map(refreshed.map((item) => [item.packId, item]));
  return current.map((item) => refreshedByPack.get(item.packId) ?? item);
}

export async function refreshListingsAfterConflict<T extends { packId: string }>(
  current: T[],
  refresh: () => Promise<T[] | null>,
): Promise<{ kind: "refreshed"; items: T[] } | { kind: "failed" }> {
  try {
    const refreshed = await refresh();
    return refreshed === null
      ? { kind: "failed" }
      : { kind: "refreshed", items: replaceListingsFromRefresh(current, refreshed) };
  } catch {
    return { kind: "failed" };
  }
}

export async function refreshListingsForQueuedConflicts<T extends { packId: string }>(
  current: T[],
  conflicts: Array<{ packId: string }>,
  refresh: () => Promise<T[] | null>,
): Promise<
  | { kind: "none" }
  | { kind: "refreshed"; items: T[]; packIds: string[] }
  | { kind: "failed"; packIds: string[] }
> {
  const packIds = conflicts.map(({ packId }) => packId);
  if (packIds.length === 0) return { kind: "none" };

  const result = await refreshListingsAfterConflict(current, refresh);
  return result.kind === "failed"
    ? { kind: "failed", packIds }
    : { kind: "refreshed", items: result.items, packIds };
}

const syncing = new WeakMap<OpeningStockQueue, Promise<SyncActionsResponse | null>>();
export function syncOpeningStockBatch(queue: OpeningStockQueue, shopId: string,
  send: (body: SyncActionsBody) => Promise<{ ok: true; data: SyncActionsResponse } | { ok: false }>,
  current = () => true,
): Promise<SyncActionsResponse | null> {
  const running = syncing.get(queue);
  if (running) return running;
  const work = (async () => {
    const batch = queue.batch(shopId);
    if (!batch.actions.length) return { results: [] };
    queue.attempted(batch);
    const response = await send(batch);
    if (!response.ok || !current()) return null;
    queue.acknowledge(batch, response.data);
    return response.data;
  })().catch(() => null).finally(() => syncing.delete(queue));
  syncing.set(queue, work);
  return work;
}
