import { describe, expect, it, vi } from "vitest";

// The native modules don't load under Node.
const secure = vi.hoisted(() => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async () => "T1"),
  setItemAsync: vi.fn(async () => {}),
  deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock("expo-secure-store", () => secure);
vi.mock("react-native-mmkv", () => {
  const values = new Map<string, boolean>();
  return {
    createMMKV: () => ({
      getBoolean: (key: string) => values.get(key),
      set: (key: string, value: boolean) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    }),
  };
});

const { makeSessionStore, sessionStore } = await import("../src/session-store");

function phone({ deleteFails = false } = {}) {
  let token: string | null = null;
  let marked = false;
  const store = makeSessionStore(
    {
      get: async () => token,
      set: async (value) => void (token = value),
      delete: async () => {
        if (deleteFails) throw new Error("Keychain busy");
        token = null;
      },
    },
    {
      isSet: () => marked,
      set: () => void (marked = true),
      clear: () => void (marked = false),
    },
  );
  return { store, token: () => token, marked: () => marked, fix: () => void (deleteFails = false) };
}

describe("sessionStore", () => {
  it("saves over the one token, so an older one is never kept", async () => {
    const { store } = phone();
    await store.set("T1");
    await store.set("T2");
    expect(await store.get()).toBe("T2");
  });

  it("clears the token and drops the marker", async () => {
    const p = phone();
    await p.store.set("T1");
    await p.store.clear();
    expect(await p.store.get()).toBeNull();
    expect(p.marked()).toBe(false);
  });

  it("never hands out a token whose clear failed, and clears it on a later read", async () => {
    const p = phone({ deleteFails: true });
    await p.store.set("T1");
    await expect(p.store.clear()).rejects.toThrow("Keychain busy");
    expect(p.token()).toBe("T1");

    // The next launch: still stuck, still unusable.
    expect(await p.store.get()).toBeNull();
    expect(p.marked()).toBe(true);

    p.fix();
    expect(await p.store.get()).toBeNull();
    expect(p.token()).toBeNull();
    expect(p.marked()).toBe(false);
  });

  it("lets a new sign-in after a failed clear be kept", async () => {
    const p = phone({ deleteFails: true });
    await p.store.set("T1");
    await expect(p.store.clear()).rejects.toThrow();
    await p.store.set("S1");
    expect(p.marked()).toBe(false);
    expect(await p.store.get()).toBe("S1");
  });
});

describe("the phone's store", () => {
  it("keeps the token in the secure store, on this phone only", async () => {
    const thisPhone = { keychainAccessible: secure.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
    await sessionStore.set("T1");
    expect(await sessionStore.get()).toBe("T1");
    await sessionStore.clear();
    expect(secure.setItemAsync).toHaveBeenCalledWith("refreshToken", "T1", thisPhone);
    expect(secure.getItemAsync).toHaveBeenCalledWith("refreshToken", thisPhone);
    expect(secure.deleteItemAsync).toHaveBeenCalledWith("refreshToken", thisPhone);
  });
});
