import { getRandomBytesAsync, randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, getItemAsync, setItemAsync } from "expo-secure-store";
import { defaultDatabaseDirectory, openDatabaseAsync } from "expo-sqlite";
import { createMMKV } from "react-native-mmkv";
import { openingStockQueue, type OpeningStockQueue } from "./opening-stock-queue";

// This is only the old queue's import source; new writes never go into MMKV.
export const legacyOpeningStock = createMMKV({ id: "shop-opening-stock" });
const opened = new Map<string, Promise<OpeningStockQueue>>();
const options = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function open(accountId: string): Promise<OpeningStockQueue> {
  const name = `opening-stock-${accountId}.db`;
  const keyName = `opening-stock-${accountId}`;
  let key = await getItemAsync(keyName, options);
  if (!key) {
    if (new File(defaultDatabaseDirectory, name).exists) throw new Error("Opening stock key is missing");
    key = Array.from(await getRandomBytesAsync(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // Persist before creating the database; an interrupted first open can reuse this key.
    await setItemAsync(keyName, key, options);
  }
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Opening stock key is invalid");
  const db = await openDatabaseAsync(name);
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new Error("Rebuild Shopkeeper with SQLCipher enabled");
    // Only the validated, locally generated hexadecimal key is interpolated.
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    return openingStockQueue(db, randomUUID);
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

export function openOpeningStock(accountId: string): Promise<OpeningStockQueue> {
  let current = opened.get(accountId);
  if (!current) {
    current = open(accountId).catch((error: unknown) => { opened.delete(accountId); throw error; });
    opened.set(accountId, current);
  }
  return current;
}

/** Undefined means the shop lookup failed; null means the server confirmed no shop. */
export async function openingStockBeforeSignOut(accountId: string, verifiedShopId?: string | null): Promise<{ pending: number; failed: number; stockPending?: number }> {
  if (verifiedShopId === undefined && legacyOpeningStock.getAllKeys().some((key) => key.startsWith("opening:"))) {
    throw new Error("Verify the shop before checking legacy opening stock");
  }
  const queue = await openOpeningStock(accountId);
  if (verifiedShopId) queue.importLegacy(verifiedShopId, legacyOpeningStock);
  return { pending: queue.count(), failed: queue.failureCount(), ...(queue.flagCount() > 0 ? { stockPending: queue.flagCount() } : {}) };
}
