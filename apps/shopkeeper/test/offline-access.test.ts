import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineAccess, readSavedAccess, type AccessStorage, type SavedAccess } from "../src/lib/offline-access";

const account = { id: "00000000-0000-4000-8000-000000000001", name: "Asha", phone: "+919812345678", email: "asha@example.com", theme: "system" as const };
const shopId = "00000000-0000-4000-8000-000000000002";
describe("verified offline shop access", () => {
  let record: SavedAccess | null, active: string | undefined, blocked: string | undefined, time: number;
  let storage: AccessStorage;
  const fetch = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks(); time = Date.parse("2030-01-01T00:00:00Z"); record = null; active = undefined; blocked = undefined;
    storage = {
      hasData: () => false, active: () => active, select: (id) => { active = id; }, forget: () => { active = undefined; }, blocked: () => blocked,
      read: async (id) => record?.account.id === id ? record : null,
      save: async (next) => { record = next; },
      erase: vi.fn(async () => { blocked = shopId; record = null; active = undefined; blocked = undefined; }),
    };
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "live" } });
  });
  it("cold-reopens only the selected encrypted identity and enforces the exact lease boundary independently of queue age", async () => {
    await offlineAccess(storage, fetch, () => time).verify(account);
    fetch.mockRejectedValue(new Error("offline"));
    const restarted = offlineAccess(storage, fetch, () => time);
    expect(await restarted.restore()).toEqual(account);
    expect(restarted.allowed(account.id, shopId)).toBe(true);
    expect(restarted.allowed("other-account", shopId)).toBe(false);
    time += 72 * 3600_000 - 1;
    expect(restarted.allowed(account.id, shopId)).toBe(true);
    time++;
    restarted.expire();
    expect(restarted.allowed(account.id, shopId)).toBe(false);
    expect(restarted.get().mode).toBe("expired");
    expect(record).not.toBeNull(); expect(storage.erase).not.toHaveBeenCalled();
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "suspended" } });
    await restarted.verify(account);
    expect(restarted.allowed(account.id, shopId)).toBe(true);
  });
  it("blocks a clock behind verification and never destroys records on network or token failures", async () => {
    const access = offlineAccess(storage, fetch, () => time);
    await access.verify(account); time--;
    fetch.mockRejectedValueOnce(new Error("offline")); await access.verify(account);
    expect(access.get().mode).toBe("expired");
    fetch.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" }); await access.verify(account);
    expect(storage.erase).not.toHaveBeenCalled();
    access.reset();
    expect(await offlineAccess(storage, fetch).restore()).toBeNull();
    expect(record?.account.id).toBe(account.id);
  });
  it.each([{ shopId: null, state: null }, { shopId, state: "closed" }, { shopId: "another-shop", state: "live" }])("erases only after authenticated ended/moved shop access: %j", async (data) => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    fetch.mockResolvedValue({ ok: true, data }); await access.verify(account);
    expect(storage.erase).toHaveBeenCalledWith(account.id, shopId);
    expect(access.get().mode).toBe("ended"); expect(access.allowed(account.id, shopId)).toBe(false);
  });
  it("retries a durable erasure block after restart, without exposing cached Stock", async () => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    storage.erase = vi.fn(async () => { blocked = shopId; throw new Error("key deletion failed"); });
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "closed" } }); await access.verify(account);
    expect(access.get().mode).toBe("erasing");
    const restarted = offlineAccess(storage, fetch, () => time); await restarted.restore();
    expect(restarted.allowed(account.id, shopId)).toBe(false);
    await restarted.verify(account); expect(restarted.get().mode).toBe("erasing");
    storage.erase = vi.fn(async () => { blocked = undefined; record = null; });
    await restarted.cleanup(); expect(restarted.get().mode).toBe("ended");
  });
  it("shows ended access for a closed shop even before Stock has created a cache", async () => {
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "closed" } });
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    expect(storage.erase).toHaveBeenCalledWith(account.id, shopId); expect(access.get().mode).toBe("ended");
  });
  it("erases an older database without lease metadata when the server confirms no access", async () => {
    storage.hasData = () => true; fetch.mockResolvedValue({ ok: true, data: { shopId: null, state: null } });
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    expect(storage.erase).toHaveBeenCalledWith(account.id, "unlinked"); expect(access.get().mode).toBe("ended");
  });
  it("ignores an old cleanup button once access is verified for a new session", async () => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    await access.cleanup(); expect(storage.erase).not.toHaveBeenCalled();
  });
  it("finishes cleanup after expiry and same-account relogin even when the original completion was stale", async () => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    let finish!: () => void;
    storage.erase = vi.fn(async () => { blocked = shopId; await new Promise<void>((resolve) => { finish = resolve; }); blocked = undefined; record = null; });
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "closed" } });
    const original = access.verify(account); await Promise.resolve(); await Promise.resolve();
    access.reset(); await access.verify(account); expect(access.get().mode).toBe("erasing");
    finish(); await original; expect(access.get().mode).toBe("erasing");
    storage.erase = vi.fn(async () => {});
    await access.cleanup(); expect(access.get().mode).toBe("ended");
  });
  it("shares in-flight cleanup for the same account", async () => {
    blocked = shopId;
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    let finish!: () => void;
    storage.erase = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = access.cleanup(), second = access.cleanup();
    expect(storage.erase).toHaveBeenCalledTimes(1); finish(); await Promise.all([first, second]);
    expect(access.get().mode).toBe("ended");
  });
  it("can finish cleanup when identity metadata is already gone", async () => {
    blocked = shopId;
    const access = offlineAccess(storage, fetch, () => time);
    await access.verify(account); expect(access.get().mode).toBe("erasing");
    await access.cleanup(); expect(storage.erase).toHaveBeenCalledWith(account.id, shopId);
    expect(access.get().mode).toBe("ended");
  });
  it("retains Approved shop work for erasure but grants no offline Stock access", async () => {
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "approved" } });
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    expect(access.allowed(account.id, shopId)).toBe(false);
    fetch.mockRejectedValue(new Error("offline")); await access.verify(account);
    expect(access.get().mode).toBe("expired");
    fetch.mockResolvedValue({ ok: true, data: { shopId: null, state: null } }); await access.verify(account);
    expect(storage.erase).toHaveBeenCalledWith(account.id, shopId);
  });
  it("preserves a still-valid Stock lease when the same shop returns Approved", async () => {
    const access = offlineAccess(storage, fetch, () => time);
    await access.verify(account);
    const original = record;
    if (!original) throw new Error("Expected a saved Stock lease");
    fetch.mockResolvedValue({ ok: true, data: { shopId, state: "approved" } });
    await access.verify(account);
    expect(record).toEqual(original);
    expect(access.get()).toMatchObject({ mode: "offline", shopId, expiresAt: original.verifiedAt + 72 * 3600_000 });
    expect(access.allowed(account.id, shopId)).toBe(true);
  });
  it("drops late verification and restore results after sign-out/account replacement", async () => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    let finish!: (answer: unknown) => void;
    fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = access.verify(account); await Promise.resolve();
    access.reset(); finish({ ok: true, data: { shopId, state: "live" } }); await pending;
    expect(access.get()).toEqual({ mode: "online" }); expect(active).toBeUndefined();
    active = account.id;
    let read!: (value: SavedAccess | null) => void;
    storage.read = () => new Promise((resolve) => { read = resolve; });
    const restoring = access.restore(); access.reset(); read(record); expect(await restoring).toBeNull();
  });
  it("never gives a new/unverified account another account's cache", async () => {
    const access = offlineAccess(storage, fetch, () => time); await access.verify(account);
    fetch.mockRejectedValue(new Error("offline"));
    await access.verify({ ...account, id: "other-account" });
    expect(access.allowed(account.id, shopId)).toBe(false);
    expect(access.allowed("other-account", shopId)).toBe(false);
    expect(readSavedAccess("broken")).toBeNull();
    expect(readSavedAccess(JSON.stringify({ account, shopId, verifiedAt: "bad" }))).toBeNull();
  });
});
