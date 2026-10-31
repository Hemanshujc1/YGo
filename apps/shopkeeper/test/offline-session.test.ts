import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedAccess } from "../src/lib/offline-access";

const mock = vi.hoisted(() => ({ me: vi.fn(), lookup: vi.fn(), signOut: vi.fn(), token: "saved-token" as string | null,
  record: null as SavedAccess | null, active: undefined as string | undefined, close: vi.fn() }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.0.0" } } }));
vi.mock("@ygo/api-client", () => ({ createApiClient: () => ({ me: mock.me, syncAccess: mock.lookup, signOut: mock.signOut, setTheme: vi.fn() }) }));
vi.mock("@ygo/mobile", async () => ({
  ...await import("../../../packages/mobile/src/session"),
  ...await import("../../../packages/mobile/src/signed-out"),
  phoneTheme: { saved: () => "system", keep: vi.fn() },
  sessionStore: { get: async () => mock.token }, showUpdateRequired: vi.fn(),
}));
vi.mock("../src/lib/opening-stock-database", () => ({ closeOpeningStock: mock.close, offlineStorage: {
  hasData: () => false, active: () => mock.active, select: (id: string) => { mock.active = id; }, forget: () => { mock.active = undefined; },
  blocked: () => undefined, read: async (id: string) => mock.record?.account.id === id ? mock.record : null,
  save: async (record: SavedAccess) => { mock.record = record; }, erase: vi.fn(),
} }));
const account = { id: "00000000-0000-4000-8000-000000000001", email: "asha@example.com", name: "Asha", phone: "+919812345678", theme: "system" as const };
const shopId = "00000000-0000-4000-8000-000000000002";

describe("Shopkeeper launch and session lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks();
    vi.stubEnv("EXPO_PUBLIC_API_BASE_URL", "http://localhost:3000"); vi.stubEnv("EXPO_PUBLIC_SUPPORT_EMAIL", "help@example.com");
    mock.token = "saved-token"; mock.active = account.id;
    mock.record = { account, shopId, verifiedAt: Date.now(), stockAllowed: true };
    mock.me.mockRejectedValue(new Error("offline")); mock.lookup.mockRejectedValue(new Error("offline"));
    mock.signOut.mockResolvedValue(undefined); mock.close.mockResolvedValue(undefined);
    await import("../src/api");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("cold launches offline with encrypted identity, but never restores it without a saved sign-in", async () => {
    const { session, access } = await import("../src/api");
    await session.check(); expect(session.get()).toEqual({ status: "signed-in", account }); expect(access.get().mode).toBe("offline");
    mock.token = null; await session.check(); expect(session.get().status).toBe("unreachable");
  });
  it("session expiry keeps records, prevents offline restoration, and same-account relogin can resume", async () => {
    const { session, access } = await import("../src/api");
    await session.check();
    mock.me.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" }); await session.check();
    expect(session.get().status).toBe("signed-out"); expect(mock.active).toBeUndefined(); expect(mock.record).not.toBeNull();
    mock.me.mockRejectedValue(new Error("offline")); await session.check(); expect(session.get().status).toBe("unreachable");
    session.signedIn(account); mock.lookup.mockResolvedValue({ ok: true, data: { shopId, state: "live" } }); await access.verify(account);
    expect(access.allowed(account.id, shopId)).toBe(true);
  });
  it("blocks new access and late writes as soon as sign-out starts", async () => {
    const { session, access } = await import("../src/api"); await session.check();
    let done!: () => void; mock.signOut.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
    const signingOut = session.signOut();
    expect(access.get().mode).toBe("signing-out"); expect(access.allowed(account.id, shopId)).toBe(false);
    await access.verify(account); expect(access.get().mode).toBe("signing-out"); done(); await signingOut;
  });
  it("invalidates same-account callbacks on sign-out and hides cached identity from the next account", async () => {
    const { session, access, accountEpoch } = await import("../src/api");
    await session.check(); const before = accountEpoch(); await session.signOut();
    expect(accountEpoch()).toBeGreaterThan(before); expect(mock.close).toHaveBeenCalledWith(account.id);
    session.signedIn({ ...account, id: "00000000-0000-4000-8000-000000000003" });
    expect(access.allowed(account.id, shopId)).toBe(false); expect(mock.record?.account.id).toBe(account.id);
  });
});
