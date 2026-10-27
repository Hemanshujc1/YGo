import { OpeningStockBody, type ErrorCode, type OpeningStockBody as OpeningStockEntry } from "@ygo/contracts";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV({ id: "shop-opening-stock" });

const key = (shopId: string, packId: string) => `opening:${shopId}:${packId}`;

export function pendingOpeningStock(shopId: string, packId: string): OpeningStockEntry | null {
  const stored = storage.getString(key(shopId, packId));
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    storage.remove(key(shopId, packId));
    return null;
  }
  const entry = OpeningStockBody.safeParse(parsed);
  if (!entry.success) {
    storage.remove(key(shopId, packId));
    return null;
  }
  return entry.data;
}

export function queueOpeningStock(shopId: string, packId: string, entry: OpeningStockEntry): void {
  storage.set(key(shopId, packId), JSON.stringify(OpeningStockBody.parse(entry)));
}

export function clearOpeningStock(shopId: string, packId: string): void {
  storage.remove(key(shopId, packId));
}

export function replaceListingsFromRefresh<T extends { packId: string }>(current: T[], refreshed: T[]): T[] {
  const refreshedByPack = new Map(refreshed.map((item) => [item.packId, item]));
  return current.map((item) => refreshedByPack.get(item.packId) ?? item);
}

export type OpeningStockSyncResult =
  | { kind: "empty" }
  | { kind: "synced" }
  | { kind: "pending"; code: ErrorCode | null };

export async function syncQueuedOpeningStock(
  shopId: string,
  packId: string,
  send: (entry: OpeningStockEntry) => Promise<{ ok: true } | { ok: false; code: ErrorCode }>,
): Promise<OpeningStockSyncResult> {
  const entry = pendingOpeningStock(shopId, packId);
  if (!entry) return { kind: "empty" };
  let result: { ok: true } | { ok: false; code: ErrorCode };
  try {
    result = await send(entry);
  } catch {
    return { kind: "pending", code: null };
  }
  if (!result.ok) return { kind: "pending", code: result.code };
  clearOpeningStock(shopId, packId);
  return { kind: "synced" };
}
