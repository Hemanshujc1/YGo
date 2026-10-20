import { beforeEach, describe, expect, it, vi } from "vitest";

// The native modules don't load under Node: a Keychain and an MMKV in memory.
const phone = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  mmkv: new Map<string, boolean>(),
  failDelete: false,
}));
const secure = vi.hoisted(() => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async (key: string) => phone.keychain.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void phone.keychain.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (phone.failDelete) throw new Error("Keychain busy");
    phone.keychain.delete(key);
  }),
}));
vi.mock("expo-secure-store", () => secure);
vi.mock("react-native-mmkv", () => ({
  createMMKV: () => ({
    getBoolean: (key: string) => phone.mmkv.get(key),
    set: (key: string, value: boolean) => phone.mmkv.set(key, value),
    remove: (key: string) => phone.mmkv.delete(key),
  }),
}));

const { sessionStore: store } = await import("../src/session-store");
const { onSignedOut } = await import("../src/signed-out");

const thisPhone = { keychainAccessible: secure.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

beforeEach(() => {
  phone.keychain.clear();
  phone.mmkv.clear();
  phone.failDelete = false;
});

describe("sessionStore", () => {
  it("keeps the token in the secure store, on this phone only", async () => {
    await store.set("T1");
    expect(await store.get()).toBe("T1");
    expect(secure.setItemAsync).toHaveBeenCalledWith("refreshToken", "T1", thisPhone);
    expect(secure.getItemAsync).toHaveBeenCalledWith("refreshToken", thisPhone);
    expect([...phone.mmkv.values()]).not.toContain("T1");
  });

  it("saves over the one token, so an older one is never kept", async () => {
    await store.set("T1");
    await store.set("T2");
    expect(await store.get()).toBe("T2");
    expect([...phone.keychain.values()]).toEqual(["T2"]);
  });

  it("clears the token", async () => {
    await store.set("T1");
    await store.clear();
    expect(await store.get()).toBeNull();
    expect(secure.deleteItemAsync).toHaveBeenCalledWith("refreshToken", thisPhone);
  });

  it("never hands out a token whose clear failed, goes to sign-in, and clears it on a later read", async () => {
    const ended = vi.fn();
    const stop = onSignedOut(ended);
    await store.set("T1");
    phone.failDelete = true;
    await expect(store.clear()).rejects.toThrow("Keychain busy");
    stop();
    expect(ended).toHaveBeenCalledOnce();
    expect(phone.keychain.get("refreshToken")).toBe("T1");

    // The next launch: still stuck, still unusable.
    expect(await store.get()).toBeNull();
    expect(phone.keychain.get("refreshToken")).toBe("T1");

    phone.failDelete = false;
    expect(await store.get()).toBeNull();
    expect(phone.keychain.size).toBe(0);
  });

  it("keeps a new sign-in made after a failed clear", async () => {
    await store.set("T1");
    phone.failDelete = true;
    await expect(store.clear()).rejects.toThrow();
    await store.set("S1");
    expect(await store.get()).toBe("S1");
  });

  it("ignores a token left in the Keychain by an earlier install", async () => {
    phone.keychain.set("refreshToken", "OLD");
    expect(await store.get()).toBeNull();
    expect(phone.keychain.size).toBe(0);
  });

  it("counts a token it can't read as none, and removes it", async () => {
    await store.set("T1");
    secure.getItemAsync.mockRejectedValueOnce(new Error("DecryptException"));
    expect(await store.get()).toBeNull();
    expect(phone.keychain.size).toBe(0);
  });
});
