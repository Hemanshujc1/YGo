import { OpeningStockBody, type ErrorCode, type OpeningStockBody as OpeningStockEntry } from "@ygo/contracts";
import type { SQLiteDatabase } from "expo-sqlite";

type Database = Pick<SQLiteDatabase, "execSync" | "getFirstSync" | "runSync" | "withTransactionSync">;
type Legacy = { getAllKeys(): string[]; getString(key: string): string | undefined; remove(key: string): boolean };

function parse(raw: string): OpeningStockEntry | null {
  try {
    const result = OpeningStockBody.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}

/** One account's encrypted database; shop and pack remain part of each key. */
export function openingStockQueue(db: Database) {
  const schema = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  if (!schema) throw new Error("Could not read opening stock schema");
  const version = schema.user_version;
  if (version > 1) throw new Error("Opening stock database needs a newer app");
  if (version === 0) db.withTransactionSync(() => {
    db.execSync(`CREATE TABLE opening_stock (shop_id TEXT NOT NULL, pack_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (shop_id, pack_id));
      CREATE TABLE opening_stock_held (source_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version = 1;`);
  });

  return {
    /** Call only with the shop just verified for this account by the server. */
    importLegacy(shopId: string, legacy: Legacy) {
      const prefix = `opening:${shopId}:`;
      for (const key of legacy.getAllKeys().filter((key) => key.startsWith(prefix))) {
        const raw = legacy.getString(key);
        if (raw === undefined) continue;
        const entry = parse(raw);
        const packId = key.slice(prefix.length);
        db.withTransactionSync(() => {
          const existing = db.getFirstSync<{ payload: string }>("SELECT payload FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, packId);
          const saved = existing && parse(existing.payload);
          if (entry && (!existing || (saved?.clientId === entry.clientId && saved.quantity === entry.quantity))) {
            db.runSync("INSERT OR IGNORE INTO opening_stock VALUES (?, ?, ?)", shopId, packId, raw);
          } else {
            // Preserve malformed/conflicting legacy bytes for attention, never send them.
            db.runSync("INSERT OR IGNORE INTO opening_stock_held VALUES (?, ?)", key, raw);
            const held = db.getFirstSync<{ payload: string }>("SELECT payload FROM opening_stock_held WHERE source_key = ?", key);
            if (held?.payload !== raw) throw new Error("Legacy opening stock changed during import");
          }
        });
        // A failed removal can safely retry: both inserts are idempotent.
        legacy.remove(key);
      }
    },
    pending(shopId: string, packId: string): OpeningStockEntry | null {
      const row = db.getFirstSync<{ payload: string }>("SELECT payload FROM opening_stock WHERE shop_id = ? AND pack_id = ?", shopId, packId);
      return row ? parse(row.payload) : null;
    },
    save(shopId: string, packId: string, entry: OpeningStockEntry) {
      const checked = OpeningStockBody.parse(entry);
      const held = db.getFirstSync("SELECT 1 FROM opening_stock_held WHERE source_key = ?", `opening:${shopId}:${packId}`);
      if (held) throw new Error("Opening stock needs attention");
      db.runSync(`INSERT INTO opening_stock VALUES (?, ?, ?) ON CONFLICT (shop_id, pack_id)
        DO UPDATE SET payload = excluded.payload`, shopId, packId, JSON.stringify(checked));
    },
    clear(shopId: string, packId: string, sent: OpeningStockEntry) {
      // A delayed response must never delete a newer edit.
      db.runSync(`DELETE FROM opening_stock WHERE shop_id = ? AND pack_id = ?
        AND json_extract(payload, '$.clientId') = ? AND json_extract(payload, '$.quantity') = ?`, shopId, packId, sent.clientId, sent.quantity);
    },
    count(): number {
      const row = db.getFirstSync<{ count: number }>("SELECT (SELECT count(*) FROM opening_stock) + (SELECT count(*) FROM opening_stock_held) AS count");
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

export type OpeningStockSyncResult =
  | { kind: "empty" }
  | { kind: "synced" }
  | { kind: "pending"; code: ErrorCode | null };

export async function syncQueuedOpeningStock(
  queue: OpeningStockQueue,
  shopId: string,
  packId: string,
  send: (entry: OpeningStockEntry) => Promise<{ ok: true } | { ok: false; code: ErrorCode }>,
): Promise<OpeningStockSyncResult> {
  const entry = queue.pending(shopId, packId);
  if (!entry) return { kind: "empty" };
  let result: { ok: true } | { ok: false; code: ErrorCode };
  try {
    result = await send(entry);
  } catch {
    return { kind: "pending", code: null };
  }
  if (!result.ok) return { kind: "pending", code: result.code };
  queue.clear(shopId, packId, entry);
  return { kind: "synced" };
}
