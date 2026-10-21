import type { ApiResult } from "@ygo/api-client";
import type { Account } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session";
import { showSignedOut } from "../src/signed-out";

const blank: Account = { id: "6f1c1d1e-0000-4000-8000-000000000001", email: "asha@example.com", name: null, phone: null };
const full: Account = { ...blank, name: "Asha", phone: "+919876543210" };
const refused: ApiResult<Account> = { ok: false, status: 401, code: "UNAUTHENTICATED" };

function fakeApi(me: () => Promise<ApiResult<Account>>, signOut = async () => {}) {
  return { me: vi.fn(me), signOut: vi.fn(signOut) };
}

describe("createSession", () => {
  it("starts checking", () => {
    expect(createSession(fakeApi(async () => refused)).get()).toEqual({ status: "checking" });
  });

  it.each([
    ["signed-in", { ok: true, data: full }],
    ["profile-needed", { ok: true, data: blank }],
    ["profile-needed", { ok: true, data: { ...blank, name: "Asha" } }],
    ["signed-out", refused],
    ["unreachable", { ok: false, status: 503, code: "UNAVAILABLE" }],
  ] as const)("a launch check answers %s", async (status, answer) => {
    const session = createSession(fakeApi(async () => answer));
    await session.check();
    expect(session.get().status).toBe(status);
  });

  it("keeps the saved token when there is no answer, and Try again checks again", async () => {
    const api = fakeApi(() => Promise.reject(new TypeError("Network request failed")));
    const session = createSession(api);
    await session.check();
    expect(session.get().status).toBe("unreachable");
    expect(api.signOut).not.toHaveBeenCalled();

    api.me.mockResolvedValueOnce({ ok: true, data: full });
    await session.check();
    expect(session.get()).toEqual({ status: "signed-in", account: full });
  });

  it("drops a launch check that answers after a sign-in", async () => {
    let answer!: (value: ApiResult<Account>) => void;
    const session = createSession(fakeApi(() => new Promise((resolve) => (answer = resolve))));
    const checking = session.check();
    session.signedIn(blank);
    answer(refused);
    await checking;
    expect(session.get()).toEqual({ status: "profile-needed", account: blank });
  });

  it("goes back to sign-in when the server ends the session", async () => {
    const session = createSession(fakeApi(async () => ({ ok: true, data: full })));
    await session.check();
    const listener = vi.fn();
    session.subscribe(listener);
    showSignedOut();
    expect(session.get()).toEqual({ status: "signed-out" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("a new session takes the signed-out signal from the last, so listeners never pile up", async () => {
    const first = createSession(fakeApi(async () => ({ ok: true, data: full })));
    await first.check();
    const second = createSession(fakeApi(async () => ({ ok: true, data: full })));
    await second.check();
    showSignedOut();
    expect(second.get()).toEqual({ status: "signed-out" });
    expect(first.get()).toEqual({ status: "signed-in", account: full });
  });

  it("signs out after the client has finished, and reports a storage failure", async () => {
    let finish!: () => void;
    const api = fakeApi(
      async () => ({ ok: true, data: full }),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const session = createSession(api);
    await session.check();
    const signingOut = session.signOut();
    expect(session.get().status).toBe("signed-in");
    finish();
    expect(await signingOut).toBe(true);
    expect(session.get()).toEqual({ status: "signed-out" });

    api.signOut.mockRejectedValueOnce(new Error("Keychain busy"));
    session.signedIn(full);
    expect(await session.signOut()).toBe(false);
    // C01 then says this phone could not clear its saved sign-in (#155, Q5).
    expect(session.get()).toEqual({ status: "signed-out", notCleared: true });
  });

  it("keeps a sign-in that lands while a sign-out is finishing", async () => {
    let finish!: () => void;
    const api = fakeApi(
      async () => ({ ok: true, data: full }),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const session = createSession(api);
    const signingOut = session.signOut();
    session.signedIn(full);
    finish();
    await signingOut;
    expect(session.get()).toEqual({ status: "signed-in", account: full });
  });
});
