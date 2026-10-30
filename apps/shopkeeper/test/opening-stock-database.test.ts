import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapter } from "./stock-database-fixture";

const native = vi.hoisted(() => ({
  secrets: new Map<string, string>(), legacy: new Map<string, string>(), exists: false, files: new Set<string>(), flags: new Map<string, string | boolean>(), delete: vi.fn(), drop: vi.fn(),
  cipher: "4.0", get: vi.fn(), set: vi.fn(), random: vi.fn(), open: vi.fn(), close: vi.fn(), exec: vi.fn(),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000099", getRandomBytesAsync: native.random }));
vi.mock("expo-file-system", () => ({ File: class { constructor(_directory: string, private name: string) {} get exists() { return native.exists || native.files.has(this.name); } } }));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1, getItemAsync: native.get, setItemAsync: native.set, deleteItemAsync: native.delete }));
vi.mock("expo-sqlite", () => ({ defaultDatabaseDirectory: "/databases", openDatabaseAsync: native.open, deleteDatabaseAsync: native.drop }));
vi.mock("react-native-mmkv", () => ({ createMMKV: ({ id }: { id: string }) => id === "shop-offline-access" ? { getString: (key: string) => native.flags.get(key), getBoolean: (key: string) => native.flags.get(key), set: (key: string, value: string | boolean) => native.flags.set(key, value), remove: (key: string) => native.flags.delete(key) } : ({
  getAllKeys: () => [...native.legacy.keys()], getString: (key: string) => native.legacy.get(key), remove: (key: string) => native.legacy.delete(key),
}) }));

const account = "00000000-0000-4000-8000-000000000001";
const shop = "00000000-0000-4000-8000-000000000002";
const pack = "00000000-0000-4000-8000-000000000003";
const entry = { quantity: "2", clientId: "00000000-0000-4000-8000-000000000004" };

describe("opening-stock native boundary", () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); native.secrets.clear(); native.legacy.clear(); native.flags.clear(); native.files.clear();
    native.delete.mockImplementation(async (key: string) => { native.secrets.delete(key); }); native.drop.mockImplementation(async (name: string) => { if (!native.files.delete(name)) throw new Error("DatabaseNotFoundException"); }); native.exists = false; native.cipher = "4.0";
    native.get.mockImplementation(async (key: string) => native.secrets.get(key) ?? null);
    native.set.mockImplementation(async (key: string, value: string) => { native.secrets.set(key, value); });
    native.random.mockResolvedValue(new Uint8Array(32).fill(7));
    native.exec.mockResolvedValue(undefined);
    native.open.mockImplementation(async (name: string) => {
      native.files.add(name);
      const db = new DatabaseSync(":memory:"); databases.push(db);
      return { ...adapter(db), getFirstAsync: async () => native.cipher ? { cipher_version: native.cipher } : null, execAsync: native.exec, closeAsync: native.close };
    });
  });
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("saves a device-only key before creating the encrypted database and shares concurrent opens", async () => {
    const { openOpeningStock } = await import("../src/lib/opening-stock-database");
    const [first, second] = await Promise.all([openOpeningStock(account), openOpeningStock(account)]);
    expect(first).toBe(second);
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.set).toHaveBeenCalledWith(`opening-stock-${account}`, "07".repeat(32), { keychainAccessible: 1 });
    expect(native.set.mock.invocationCallOrder[0]).toBeLessThan(Number(native.open.mock.invocationCallOrder[0]));
    expect(native.exec).toHaveBeenCalledWith(`PRAGMA key = "x'${"07".repeat(32)}'";`);
  });

  it("refuses a missing key for an existing file without generating a replacement", async () => {
    native.exists = true;
    const { openOpeningStock } = await import("../src/lib/opening-stock-database");
    await expect(openOpeningStock(account)).rejects.toThrow("key is missing");
    expect(native.random).not.toHaveBeenCalled(); expect(native.set).not.toHaveBeenCalled(); expect(native.open).not.toHaveBeenCalled();
  });

  it("does not turn a SecureStore read failure into a fresh database", async () => {
    native.get.mockRejectedValueOnce(new Error("locked"));
    const { openOpeningStock } = await import("../src/lib/opening-stock-database");
    await expect(openOpeningStock(account)).rejects.toThrow("locked");
    expect(native.set).not.toHaveBeenCalled(); expect(native.open).not.toHaveBeenCalled();
    await expect(openOpeningStock(account)).resolves.toBeDefined();
  });

  it("refuses to create storage if persisting the key fails", async () => {
    native.set.mockRejectedValueOnce(new Error("secure store full"));
    const { openOpeningStock } = await import("../src/lib/opening-stock-database");
    await expect(openOpeningStock(account)).rejects.toThrow("secure store full");
    expect(native.open).not.toHaveBeenCalled();
  });

  it("refuses an unencrypted native build and closes the connection", async () => {
    native.cipher = "";
    const { openOpeningStock } = await import("../src/lib/opening-stock-database");
    await expect(openOpeningStock(account)).rejects.toThrow("SQLCipher");
    expect(native.close).toHaveBeenCalledTimes(1); expect(native.exec).not.toHaveBeenCalled();
  });

  it("counts all unsynced records for sign-out, including malformed imports; isolates accounts", async () => {
    native.legacy.set(`opening:${shop}:${pack}`, JSON.stringify(entry));
    native.legacy.set(`opening:${shop}:bad`, "broken");
    const { openingStockBeforeSignOut } = await import("../src/lib/opening-stock-database");
    expect(await openingStockBeforeSignOut(account, shop)).toEqual({ pending: 2, failed: 0 });
    expect(await openingStockBeforeSignOut("other-account", null)).toEqual({ pending: 0, failed: 0 });
    expect(await openingStockBeforeSignOut(account, shop)).toEqual({ pending: 2, failed: 0 });
  });

  it("cannot skip unverified legacy entries when the shop lookup failed", async () => {
    native.legacy.set(`opening:${shop}:${pack}`, JSON.stringify(entry));
    const { openingStockBeforeSignOut } = await import("../src/lib/opening-stock-database");
    await expect(openingStockBeforeSignOut(account)).rejects.toThrow("Verify the shop");
    expect(native.legacy.size).toBe(1);
  });

it("counts durable manual flags before sign-out without reading another account's database", async () => {
  const { openOpeningStock, openingStockBeforeSignOut } = await import("../src/lib/opening-stock-database");
  const queue = await openOpeningStock(account);
  queue.saveFlag(shop, pack, true);
  expect(await openingStockBeforeSignOut(account, shop)).toEqual({ pending: 1, failed: 0, stockPending: 1 });
  expect(await openingStockBeforeSignOut("other-account", null)).toEqual({ pending: 0, failed: 0 });
});


it("invalidates handles and erases the account database/key even while actions and a response remain pending", async () => {
  const { openOpeningStock, offlineStorage } = await import("../src/lib/opening-stock-database");
  const { syncOpeningStockBatch } = await import("../src/lib/opening-stock-queue");
  const queue = await openOpeningStock(account); queue.saveFlag(shop, pack, true);
  let answer!: (value: { ok: true; data: { results: [] } }) => void;
  const flight = syncOpeningStockBatch(queue, shop, () => new Promise((resolve) => { answer = resolve; }));
  native.legacy.set(`opening:${shop}:${pack}`, JSON.stringify(entry));
  await offlineStorage.erase(account, shop);
  answer({ ok: true, data: { results: [] } }); expect(await flight).toBeNull();
  expect(() => queue.count()).toThrow("unavailable");
  expect(native.close).toHaveBeenCalled(); expect(native.drop).toHaveBeenCalledWith(`opening-stock-${account}.db`);
  expect(native.delete).toHaveBeenCalledWith(`opening-stock-${account}`, { keychainAccessible: 1 });
  expect(native.legacy.size).toBe(0);
});

it.each(["file", "key"])("keeps the durable block through %s deletion failure and retries after a module restart", async (failure) => {
  const { openOpeningStock, offlineStorage } = await import("../src/lib/opening-stock-database");
  await openOpeningStock(account);
  (failure === "file" ? native.drop : native.delete).mockRejectedValueOnce(new Error("busy"));
  await expect(offlineStorage.erase(account, shop)).rejects.toThrow("busy");
  vi.resetModules();
  const restarted = await import("../src/lib/opening-stock-database");
  expect(restarted.offlineStorage.blocked(account)).toBe(shop);
  await expect(restarted.openOpeningStock(account)).rejects.toThrow("cleanup");
  await restarted.offlineStorage.erase(account, shop);
  expect(restarted.offlineStorage.blocked(account)).toBeUndefined();
});

it("does not recreate a key or database when signing out after completed erasure", async () => {
  const { offlineStorage, openingStockBeforeSignOut, openOpeningStock } = await import("../src/lib/opening-stock-database");
  await openOpeningStock(account); await offlineStorage.erase(account, shop);
  native.open.mockClear(); native.set.mockClear();
  expect(await openingStockBeforeSignOut(account, null)).toEqual({ pending: 0, failed: 0 });
  expect(native.open).not.toHaveBeenCalled(); expect(native.set).not.toHaveBeenCalled();
});
it("completes access erasure even when Stock has never created a database", async () => {
  const { offlineStorage } = await import("../src/lib/opening-stock-database");
  await offlineStorage.erase(account, shop);
  expect(native.drop).not.toHaveBeenCalled(); expect(offlineStorage.blocked(account)).toBeUndefined();
});

it("shares concurrent close requests and invalidates the handle before native close finishes", async () => {
  const { openOpeningStock, closeOpeningStock } = await import("../src/lib/opening-stock-database");
  const queue = await openOpeningStock(account);
  let finish!: () => void; native.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = closeOpeningStock(account), second = closeOpeningStock(account); await Promise.resolve(); await Promise.resolve();
  expect(() => queue.count()).toThrow("unavailable"); expect(native.close).toHaveBeenCalledTimes(1);
  finish(); await Promise.all([first, second]);
});

});
