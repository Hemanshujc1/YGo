import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapter } from "./stock-database-fixture";

const native = vi.hoisted(() => ({
  secrets: new Map<string, string>(), legacy: new Map<string, string>(), exists: false,
  cipher: "4.0", get: vi.fn(), set: vi.fn(), random: vi.fn(), open: vi.fn(), close: vi.fn(), exec: vi.fn(),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000099", getRandomBytesAsync: native.random }));
vi.mock("expo-file-system", () => ({ File: class { get exists() { return native.exists; } } }));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1, getItemAsync: native.get, setItemAsync: native.set }));
vi.mock("expo-sqlite", () => ({ defaultDatabaseDirectory: "/databases", openDatabaseAsync: native.open }));
vi.mock("react-native-mmkv", () => ({ createMMKV: () => ({
  getAllKeys: () => [...native.legacy.keys()], getString: (key: string) => native.legacy.get(key), remove: (key: string) => native.legacy.delete(key),
}) }));

const account = "00000000-0000-4000-8000-000000000001";
const shop = "00000000-0000-4000-8000-000000000002";
const pack = "00000000-0000-4000-8000-000000000003";
const entry = { quantity: "2", clientId: "00000000-0000-4000-8000-000000000004" };

describe("opening-stock native boundary", () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); native.secrets.clear(); native.legacy.clear(); native.exists = false; native.cipher = "4.0";
    native.get.mockImplementation(async (key: string) => native.secrets.get(key) ?? null);
    native.set.mockImplementation(async (key: string, value: string) => { native.secrets.set(key, value); });
    native.random.mockResolvedValue(new Uint8Array(32).fill(7));
    native.exec.mockResolvedValue(undefined);
    native.open.mockImplementation(async () => {
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
});
