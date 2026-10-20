import { beforeEach, describe, expect, it, vi } from "vitest";

// The native modules don't load under Node: a Keychain and an MMKV in memory.
const phone = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  mmkv: new Map<string, boolean>(),
  failDelete: false,
  /** While set, each delete waits for it: a Keychain call still under way. */
  held: null as Promise<void> | null,
  deleting: false,
}));
const secure = vi.hoisted(() => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async (key: string) => phone.keychain.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void phone.keychain.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => {
    phone.deleting = true;
    await phone.held;
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

const { createApiClient } = await import("@ygo/api-client");
const { makeSessionStore, sessionStore: store } = await import("../src/session-store");
const { onSignedOut } = await import("../src/signed-out");

const thisPhone = { keychainAccessible: secure.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

beforeEach(() => {
  phone.keychain.clear();
  phone.mmkv.clear();
  phone.failDelete = false;
  phone.held = null;
  phone.deleting = false;
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

describe("makeSessionStore when the marker's storage fails", () => {
  function setup(fail: { read?: boolean; set?: boolean; clear?: boolean }) {
    let token: string | null = "T1";
    let marked = false;
    const cleared = vi.fn();
    const secrets = {
      get: async () => token,
      set: async (next: string) => void (token = next),
      delete: vi.fn(async () => {
        if (phone.failDelete) throw new Error("Keychain busy");
        token = null;
      }),
    };
    const broken = () => {
      throw new Error("MMKV unavailable");
    };
    const marker = {
      isSet: fail.read ? broken : () => marked,
      set: fail.set ? broken : () => void (marked = true),
      clear: fail.clear ? broken : () => void (marked = false),
    };
    return { store: makeSessionStore(secrets, marker, cleared), token: () => token, cleared, secrets };
  }

  it("counts a marker it can't read as set: hands out no token, and deletes it", async () => {
    const { store, token } = setup({ read: true });
    expect(await store.get()).toBeNull();
    expect(token()).toBeNull();
  });

  it("still deletes the token when the marker can't be set", async () => {
    const { store, token, cleared } = setup({ set: true });
    await store.clear();
    expect(token()).toBeNull();
    expect(cleared).not.toHaveBeenCalled();
  });

  it("goes to sign-in when neither the marker nor the delete works", async () => {
    const { store, cleared } = setup({ set: true });
    phone.failDelete = true;
    await expect(store.clear()).rejects.toThrow("Keychain busy");
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("finishes a sign-out whose token is gone even when the marker can't be dropped", async () => {
    const { store, token } = setup({ clear: true });
    await store.clear();
    expect(token()).toBeNull();
    expect(await store.get()).toBeNull();
  });
});

describe("sessionStore behind the client", () => {
  let issued = 0;
  const body = { email: "asha@example.com", code: "123456" };
  const account = { id: "6f1c1d1e-0000-4000-8000-000000000001", email: body.email, name: "Asha", phone: "+919876543210" };

  function client() {
    const fetch = async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/auth/verify")) {
        issued += 1;
        const pair = { accessToken: `a${issued}`, refreshToken: `r${issued}`, account };
        return new Response(JSON.stringify(pair), { status: 200 });
      }
      return new Response(null, { status: 204 });
    };
    return createApiClient({ baseUrl: "https://api.test", fetch: fetch as typeof globalThis.fetch, session: store });
  }

  /** Starts a sign-out and waits until its delete is with the Keychain. */
  async function signOutHeld(api: ReturnType<typeof client>) {
    let release!: () => void;
    phone.held = new Promise((resolve) => (release = resolve));
    const out = api.signOut();
    await vi.waitFor(() => expect(phone.deleting).toBe(true));
    return { out, release };
  }

  it("keeps a sign-in made while a sign-out's delete is still under way", async () => {
    const api = client();
    await api.verifyCode(body);
    const { out, release } = await signOutHeld(api);
    const signingIn = api.verifyCode(body);
    release();
    await out;
    await signingIn;
    expect(await store.get()).toBe(`r${issued}`);
  });

  it("keeps a sign-in made while a sign-out's delete is failing", async () => {
    const api = client();
    await api.verifyCode(body);
    const { out, release } = await signOutHeld(api);
    const signingIn = api.verifyCode(body);
    phone.failDelete = true;
    release();
    await expect(out).rejects.toThrow("Keychain busy");
    await signingIn;
    expect(await store.get()).toBe(`r${issued}`);
  });

  it("never brings back the signed-out token once the delete fails", async () => {
    const api = client();
    await api.verifyCode(body);
    phone.failDelete = true;
    await expect(api.signOut()).rejects.toThrow("Keychain busy");
    expect(await store.get()).toBeNull();
    expect(await client().me()).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });
});
