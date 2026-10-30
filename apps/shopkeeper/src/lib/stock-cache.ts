import { SyncChangesResponse, type ShopStockResponse } from "@ygo/contracts";
import type { SQLiteDatabase } from "expo-sqlite";

type Database = Pick<SQLiteDatabase, "getFirstSync" | "getAllSync" | "runSync" | "withTransactionSync">;
type Item = ShopStockResponse["items"][number] & { unavailable?: boolean };

/** Read projection only: queued originals live in the separate outbox. */
export function stockCache(db: Database) {
  return {
    cursor(shopId: string): string | undefined {
      return db.getFirstSync<{ cursor: string }>("SELECT cursor FROM stock_cache_shops WHERE shop_id = ?", shopId)?.cursor;
    },
    apply(raw: SyncChangesResponse, since?: string) {
      const page = SyncChangesResponse.parse(raw);
      db.withTransactionSync(() => {
        const cursor = this.cursor(page.shopId);
        if ((since && cursor !== since) || (cursor && BigInt(cursor.split(":")[1] ?? "0") > BigInt(page.cursor.split(":")[1] ?? "0"))) throw new Error("Stale Stock page");
        for (const change of page.changes) {
          if (change.item) db.runSync(`INSERT INTO stock_cache_items (shop_id, pack_id, payload, deleted_at) VALUES (?, ?, ?, NULL)
            ON CONFLICT (shop_id, pack_id) DO UPDATE SET payload = excluded.payload, deleted_at = NULL`, page.shopId, change.packId, JSON.stringify(change.item));
          else db.runSync("UPDATE stock_cache_items SET deleted_at = ? WHERE shop_id = ? AND pack_id = ?", change.deletedAt, page.shopId, change.packId);
        }
        db.runSync(`INSERT INTO stock_cache_shops VALUES (?, ?, ?) ON CONFLICT (shop_id)
          DO UPDATE SET cursor = excluded.cursor, state = excluded.state`, page.shopId, page.cursor, page.state);
      });
    },
    read(shopId: string): (Omit<ShopStockResponse, "items"> & { items: Item[] }) | null {
      const shop = db.getFirstSync<{ state: ShopStockResponse["state"] }>("SELECT state FROM stock_cache_shops WHERE shop_id = ?", shopId);
      if (!shop) return null;
      const rows = db.getAllSync<{ payload: string; deleted_at: string | null }>(`SELECT payload, deleted_at FROM stock_cache_items c WHERE shop_id = ? AND
        (deleted_at IS NULL OR EXISTS (SELECT 1 FROM opening_stock_actions a WHERE a.shop_id = c.shop_id AND a.pack_id = c.pack_id AND a.status = 'pending'))`, shopId);
      return { shopId, state: shop.state, items: rows.map((row) => ({ ...JSON.parse(row.payload) as Item, ...(row.deleted_at ? { unavailable: true } : {}) }))
        .sort((a, b) => a.name.localeCompare(b.name) || Number(a.packQuantity) - Number(b.packQuantity)) };
    },
    removedFailures(shopId: string): string[] {
      return db.getAllSync<{ id: string }>(`SELECT a.id FROM opening_stock_actions a JOIN stock_cache_items c ON c.shop_id = a.shop_id AND c.pack_id = a.pack_id
        WHERE c.shop_id = ? AND c.deleted_at IS NOT NULL AND a.status = 'rejected'`, shopId).map((row) => row.id);
    },
  };
}
