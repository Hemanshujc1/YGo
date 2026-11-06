import type { SyncAccessResponse } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { takeUpJoin } from "../src/lib/join-shop";

const access = (role: "owner" | "staff" | null): SyncAccessResponse => ({ shopId: role ? "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e" : null, state: role ? "live" : null, shopName: role ? "Sai" : null, shopGstin: null, role });
const read = (staffShop: unknown) => () => Promise.resolve({ ok: true as const, data: { application: null, liveCheck: null, staffShop } as never });

describe("taking up a join (#536)", () => {
  it("is true only when the access check says Staff and the application read names the shop", async () => {
    expect(await takeUpJoin(() => Promise.resolve(access("staff")), read({ shopId: "x", shopName: "Sai", state: "live" }))).toBe(true);
  });

  it("is false when the role is not Staff, so the phone never opens a wrong home", async () => {
    const application = vi.fn(read(null));
    expect(await takeUpJoin(() => Promise.resolve(access("owner")), application)).toBe(false);
    expect(await takeUpJoin(() => Promise.resolve(access(null)), application)).toBe(false);
    expect(await takeUpJoin(() => Promise.resolve(null), application)).toBe(false);
    expect(application).not.toHaveBeenCalled();
  });

  it("is false when either read fails or the shop is not named yet", async () => {
    expect(await takeUpJoin(() => Promise.reject(new Error("down")), read(null))).toBe(false);
    expect(await takeUpJoin(() => Promise.resolve(access("staff")), read(null))).toBe(false);
    expect(await takeUpJoin(() => Promise.resolve(access("staff")), () => Promise.reject(new Error("down")))).toBe(false);
    expect(await takeUpJoin(() => Promise.resolve(access("staff")), () => Promise.resolve({ ok: false as const }))).toBe(false);
  });
});
