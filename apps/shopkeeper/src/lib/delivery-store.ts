import { DELIVERY_ACTION_TYPES, type ShopOrderResponse, type ShopOrderSummary, type SyncAction, type SyncActionResult } from "@ygo/contracts";
import type { SQLiteDatabase } from "expo-sqlite";

type Database = Pick<SQLiteDatabase, "execSync" | "getAllSync" | "getFirstSync" | "runSync" | "withTransactionSync">;

/** The queue rows of delivery actions; their order is the pack column, as a delivery has no pack. */
const types = DELIVERY_ACTION_TYPES.map((type) => `'${type}'`).join(", ");
/** A phone clock that reads earlier than one it already showed by this much is doubted (ADR-0003). */
export const CLOCK_BACK_MS = 60_000;

/** Schema v8 (#617): the cached deliveries, the proof photos, and the latest time this phone showed. All of it sits in the account's encrypted database. */
export function createDeliveryTables(db: Database) {
  db.execSync(`CREATE TABLE IF NOT EXISTS delivery_orders (order_id TEXT PRIMARY KEY, summary TEXT NOT NULL, detail TEXT, clock_offset INTEGER);
    CREATE TABLE IF NOT EXISTS delivery_photos (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, bytes BLOB NOT NULL, upload_id TEXT, uploaded_at TEXT);
    CREATE TABLE IF NOT EXISTS delivery_clock (high_water INTEGER NOT NULL);
    INSERT INTO delivery_clock SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM delivery_clock);`);
}

/** The failed-delivery wait, as the server's default; the phone times it on its own clock and the server rechecks (#617). */
export const FAILURE_WAIT_MS = 120_000;

export type DeliveryState = { waiting: SyncAction["type"][]; refused: { type: string; code: string | null } | null; callAt: string | null };

/**
 * Orders needing attention, each counted once: the server's count (its own record, for orders it refused) plus the orders only this phone
 * holds as refused. An order both know of counts once.
 */
export function attentionCount(serverCount: number, flaggedIds: string[], localRefusedIds: string[]): number {
  const known = new Set(flaggedIds);
  return Math.max(serverCount, known.size) + localRefusedIds.filter((id) => !known.has(id)).length;
}

export function deliveryStore(db: Database, now: () => Date) {
  /** Orders with a delivery action on the phone that the server has not settled: waiting to send, or refused. */
  const unresolved = () => new Set(db.getAllSync<{ order_id: string }>(`SELECT DISTINCT pack_id AS order_id FROM opening_stock_actions
    WHERE status IN ('pending', 'rejected') AND json_extract(action, '$.type') IN (${types})`).map((row) => row.order_id));

  return {
    /**
     * Rewrite the cached list from a fresh online read. An order that left the list is settled on the server, so its cache row goes;
     * but never a row, a photo or an action still waiting. A refusal closes only when its order left the list.
     */
    saveList(orders: ShopOrderSummary[]) {
      const ids = new Set(orders.map((order) => order.id));
      db.withTransactionSync(() => {
        for (const order of orders) db.runSync(`INSERT INTO delivery_orders (order_id, summary) VALUES (?, ?) ON CONFLICT (order_id) DO UPDATE SET summary = excluded.summary`, order.id, JSON.stringify(order));
        const waiting = new Set(db.getAllSync<{ pack_id: string }>(`SELECT DISTINCT pack_id FROM opening_stock_actions WHERE status = 'pending' AND json_extract(action, '$.type') IN (${types})`).map((row) => row.pack_id));
        for (const { order_id } of db.getAllSync<{ order_id: string }>("SELECT order_id FROM delivery_orders")) {
          if (ids.has(order_id) || waiting.has(order_id)) continue;
          db.runSync(`UPDATE opening_stock_actions SET status = 'settled' WHERE status = 'rejected' AND pack_id = ? AND json_extract(action, '$.type') IN (${types})`, order_id);
          db.runSync("DELETE FROM delivery_photos WHERE order_id = ?", order_id);
          db.runSync("DELETE FROM delivery_orders WHERE order_id = ?", order_id);
        }
      });
    },
    list(): ShopOrderSummary[] {
      return db.getAllSync<{ summary: string }>("SELECT summary FROM delivery_orders ORDER BY rowid").map((row) => JSON.parse(row.summary) as ShopOrderSummary);
    },
    /** The order screen's last online read, with how far the server's clock was ahead then. */
    saveOrder(order: ShopOrderResponse, offset: number) {
      db.runSync("UPDATE delivery_orders SET detail = ?, clock_offset = ? WHERE order_id = ?", JSON.stringify(order), offset, order.id);
    },
    order(id: string): { order: ShopOrderResponse; offset: number } | null {
      const row = db.getFirstSync<{ detail: string | null; clock_offset: number | null }>("SELECT detail, clock_offset FROM delivery_orders WHERE order_id = ?", id);
      return row?.detail ? { order: JSON.parse(row.detail) as ShopOrderResponse, offset: row.clock_offset ?? 0 } : null;
    },
    unresolved,
    /** What the phone holds for one order: actions waiting to send, and the latest refusal still open. */
    stateOf(orderId: string): DeliveryState {
      const rows = db.getAllSync<{ type: string; status: string; result: string | null; at: string }>(`SELECT json_extract(action, '$.type') AS type, status, result, json_extract(action, '$.createdAt') AS at FROM opening_stock_actions
        WHERE pack_id = ? AND status IN ('pending', 'rejected') AND json_extract(action, '$.type') IN (${types}) ORDER BY sequence`, orderId);
      const refused = rows.filter((row) => row.status === "rejected").at(-1);
      return { waiting: rows.filter((row) => row.status === "pending").map((row) => row.type as SyncAction["type"]),
        callAt: rows.filter((row) => row.status === "pending" && row.type === "delivery_call_attempt").at(-1)?.at ?? null,
        refused: refused ? { type: refused.type, code: refused.result ? (JSON.parse(refused.result) as SyncActionResult).code : null } : null };
    },
    /** Orders the phone itself holds as refused. */
    refusedIds(): string[] {
      return db.getAllSync<{ pack_id: string }>(`SELECT DISTINCT pack_id FROM opening_stock_actions WHERE status = 'rejected' AND json_extract(action, '$.type') IN (${types})`).map((row) => row.pack_id);
    },
    /** Hold the proof photo; its id stands in the action until the server gives the real upload id. */
    savePhoto(id: string, orderId: string, bytes: Uint8Array) {
      db.runSync("INSERT INTO delivery_photos (id, order_id, bytes) VALUES (?, ?, ?)", id, orderId, bytes);
    },
    photo(id: string): { orderId: string; bytes: Uint8Array; uploadId: string | null; uploadedAt: string | null } | null {
      const row = db.getFirstSync<{ order_id: string; bytes: Uint8Array; upload_id: string | null; uploaded_at: string | null }>("SELECT order_id, bytes, upload_id, uploaded_at FROM delivery_photos WHERE id = ?", id);
      return row ? { orderId: row.order_id, bytes: row.bytes, uploadId: row.upload_id, uploadedAt: row.uploaded_at } : null;
    },
    /** Find a photo by the id the action holds: the stand-in id, or the server's upload id once substituted. */
    photoFor(id: string): string | null {
      return db.getFirstSync<{ id: string }>("SELECT id FROM delivery_photos WHERE id = ? OR upload_id = ?", id, id)?.id ?? null;
    },
    dropPhoto(id: string) {
      db.runSync("DELETE FROM delivery_photos WHERE id = ? OR upload_id = ?", id, id);
    },
    /** Whether the action has already gone to the server once, so its bytes must not change. */
    sent(actionId: string): boolean {
      return (db.getFirstSync<{ attempts: number }>("SELECT attempts FROM opening_stock_actions WHERE id = ?", actionId)?.attempts ?? 0) > 0;
    },
    rewrite(action: SyncAction) {
      db.runSync("UPDATE opening_stock_actions SET action = ? WHERE id = ?", JSON.stringify(action), action.id);
    },
    uploaded(id: string, uploadId: string) {
      db.runSync("UPDATE delivery_photos SET upload_id = ?, uploaded_at = ? WHERE id = ?", uploadId, now().toISOString(), id);
    },
    /** The phone's clock reads earlier than it did: its times are doubted. Moves the high-water mark forward either way. */
    clockDoubted(): boolean {
      const at = now().getTime();
      const high = db.getFirstSync<{ high_water: number }>("SELECT high_water FROM delivery_clock")?.high_water ?? 0;
      db.runSync("UPDATE delivery_clock SET high_water = ?", Math.max(high, at));
      return at < high - CLOCK_BACK_MS;
    },
  };
}

export type DeliveryStore = ReturnType<typeof deliveryStore>;
