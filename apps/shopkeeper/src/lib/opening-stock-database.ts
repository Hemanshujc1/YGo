import { getRandomBytesAsync, randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import { defaultDatabaseDirectory, deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { createMMKV } from "react-native-mmkv";
import { readSavedAccess, type AccessStorage } from "./offline-access";
import { openingStockQueue, type OpeningStockQueue } from "./opening-stock-queue";

// This is only the old queue's import source; new writes never go into MMKV.
export const legacyOpeningStock = createMMKV({ id: "shop-opening-stock" });
type Opened = { active: boolean; promise: Promise<OpeningStockQueue>; close?: () => Promise<void>; closing?: Promise<void> };
const opened = new Map<string, Opened>();
const accessFlags = createMMKV({ id: "shop-offline-access" });
const options = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function open(accountId: string, handle: { active: boolean; close?: () => Promise<void> }): Promise<OpeningStockQueue> {
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
    handle.close = () => db.closeAsync();
    const guarded = new Proxy(db, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => {
        if (!handle.active || accessFlags.getString(`blocked:${accountId}`)) throw new Error("Offline database is unavailable");
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      } : value;
    } });
    return openingStockQueue(guarded, randomUUID);
  } catch (error) {
    await db.closeAsync();
    handle.close = undefined;
    throw error;
  }
}

export function openOpeningStock(accountId: string): Promise<OpeningStockQueue> {
  if (accessFlags.getString(`blocked:${accountId}`)) return Promise.reject(new Error("Offline cleanup is pending"));
  let current = opened.get(accountId);
  if (!current) {
    const handle: Opened = { active: true, promise: null as unknown as Promise<OpeningStockQueue> };
    handle.promise = open(accountId, handle).catch((error: unknown) => { if (opened.get(accountId) === handle) opened.delete(accountId); throw error; });
    opened.set(accountId, handle);
    current = handle;
  }
  return current.promise;
}

/** Invalidate synchronously before awaiting native close or a late sync response. */
export async function closeOpeningStock(accountId: string) {
  const handle = opened.get(accountId);
  if (!handle) return;
  if (handle.closing) return handle.closing;
  handle.active = false;
  handle.closing = (async () => {
    await handle.promise.catch(() => undefined);
    await handle.close?.();
    if (opened.get(accountId) === handle) opened.delete(accountId);
  })().catch((error: unknown) => { handle.closing = undefined; throw error; });
  return handle.closing;
}

export const offlineStorage: AccessStorage = {
  hasData: (id) => new File(defaultDatabaseDirectory, `opening-stock-${id}.db`).exists,
  active: () => accessFlags.getString("account"),
  select: (id) => { accessFlags.set("account", id); },
  forget: () => { accessFlags.remove("account"); },
  blocked: (id) => accessFlags.getString(`blocked:${id}`),
  read: async (id) => readSavedAccess(await getItemAsync(`stock-access-${id}`, options)),
  save: (record) => setItemAsync(`stock-access-${record.account.id}`, JSON.stringify(record), options),
  async erase(id, shopId) {
    accessFlags.set(`blocked:${id}`, shopId);
    await closeOpeningStock(id);
    const name = `opening-stock-${id}.db`;
    if (new File(defaultDatabaseDirectory, name).exists) await deleteDatabaseAsync(name);
    await deleteItemAsync(`opening-stock-${id}`, options);
    for (const key of legacyOpeningStock.getAllKeys()) if (key.startsWith(`opening:${shopId}:`)) legacyOpeningStock.remove(key);
    await deleteItemAsync(`stock-access-${id}`, options);
    accessFlags.remove(`blocked:${id}`);
    if (accessFlags.getString("account") === id) accessFlags.remove("account");
  },
};

/** Undefined means the shop lookup failed; null means the server confirmed no shop. */
export async function openingStockBeforeSignOut(accountId: string, verifiedShopId?: string | null): Promise<{ pending: number; failed: number; stockPending?: number }> {
  if (verifiedShopId === undefined && legacyOpeningStock.getAllKeys().some((key) => key.startsWith("opening:"))) {
    throw new Error("Verify the shop before checking legacy opening stock");
  }
  if (!opened.has(accountId) && !new File(defaultDatabaseDirectory, `opening-stock-${accountId}.db`).exists
    && !legacyOpeningStock.getAllKeys().some((key) => verifiedShopId && key.startsWith(`opening:${verifiedShopId}:`))) return { pending: 0, failed: 0 };
  const queue = await openOpeningStock(accountId);
  if (verifiedShopId) queue.importLegacy(verifiedShopId, legacyOpeningStock);
  return { pending: queue.count(), failed: queue.failureCount(), ...(queue.flagCount() > 0 ? { stockPending: queue.flagCount() } : {}) };
}
