import { SyncActionsResponse, type SyncAction, type SyncActionsBody, type SyncActionResult, OpeningStockBody, type OpeningStockBody as OpeningStockEntry } from "@ygo/contracts";
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
export function openingStockQueue(db: Database, newId: () => string, now = () => new Date()) {
  const schema = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  if (!schema) throw new Error("Could not read opening stock schema");
  const version = schema.user_version;
  if (version > 3) throw new Error("Opening stock database needs a newer app");
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

  function failed(shopId: string, packId: string): SyncActionResult | null {
    const row = db.getFirstSync<{ result: string }>(`SELECT a.result FROM opening_stock_actions a JOIN opening_stock o
      ON o.shop_id = a.shop_id AND o.pack_id = a.pack_id AND json_extract(o.payload, '$.clientId') = a.id
      WHERE a.shop_id = ? AND a.pack_id = ? AND a.status = 'rejected'`, shopId, packId);
    return row ? JSON.parse(row.result) as SyncActionResult : null;
  }

  return {
    failed,
    failureCount(): number {
      return db.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM opening_stock_actions WHERE status = 'rejected'")?.count ?? 0;
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
          if (action.shopId !== shopId || db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${row.pack_id}`)) break;
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
          db.runSync("UPDATE opening_stock_actions SET status = ?, result = ? WHERE id = ?", result.status === 'retry' ? 'pending' : result.status, JSON.stringify(result), result.actionId);
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
        const sent = db.getFirstSync<{ action: string }>("SELECT action FROM opening_stock_actions WHERE shop_id = ? AND pack_id = ? AND status = 'pending'", shopId, sourcePack);
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
    save(shopId: string, packId: string, entry: OpeningStockEntry) {
      const checked = OpeningStockBody.parse(entry);
      const held = db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${packId}`);
      if (held) throw new Error("Opening stock needs attention");
      const existing = db.getFirstSync<{ action: string }>("SELECT action FROM opening_stock_actions WHERE id = ?", checked.clientId);
      if (existing && JSON.stringify((JSON.parse(existing.action) as SyncAction).payload) !== JSON.stringify({ packId, quantity: checked.quantity })) throw new Error("Queued action is immutable");
      db.runSync(`INSERT INTO opening_stock VALUES (?, ?, ?, ?, 0) ON CONFLICT (shop_id, pack_id)
        DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, clock_suspect = 0`, shopId, packId, JSON.stringify(checked), now().toISOString());
    },
    count(): number {
      const row = db.getFirstSync<{ count: number }>("SELECT (SELECT count(*) FROM opening_stock o WHERE NOT EXISTS (SELECT 1 FROM opening_stock_actions a WHERE a.id = json_extract(o.payload, '$.clientId') AND a.status = 'rejected')) + (SELECT count(*) FROM opening_stock_held) AS count");
      if (!row) throw new Error("Could not count opening stock");
      return row.count;
    },
    attentionCount(): number {
      const row = db.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM opening_stock_held");
      if (!row) throw new Error("Could not count held opening stock");
      return row.count;
    },
  };
}

export type OpeningStockQueue = ReturnType<typeof openingStockQueue>;

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
): Promise<SyncActionsResponse | null> {
  const running = syncing.get(queue);
  if (running) return running;
  const work = (async () => {
    const batch = queue.batch(shopId);
    if (!batch.actions.length) return { results: [] };
    queue.attempted(batch);
    const response = await send(batch);
    if (!response.ok) return null;
    queue.acknowledge(batch, response.data);
    return response.data;
  })().catch(() => null).finally(() => syncing.delete(queue));
  syncing.set(queue, work);
  return work;
}
