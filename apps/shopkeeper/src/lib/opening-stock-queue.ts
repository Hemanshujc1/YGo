import { OpeningStockBody, type OpeningStockBody as OpeningStockEntry } from "@ygo/contracts";
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
