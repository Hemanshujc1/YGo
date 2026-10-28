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
