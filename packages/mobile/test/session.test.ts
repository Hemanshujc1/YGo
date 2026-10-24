import type { ApiResult } from "@ygo/api-client";
import type { Account, ThemeChoice } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session";
import { showSignedOut } from "../src/signed-out";

const blank: Account = { id: "6f1c1d1e-0000-4000-8000-000000000001", email: "asha@example.com", name: null, phone: null, theme: "system" };
const full: Account = { ...blank, name: "Asha", phone: "+919876543210" };
const refused: ApiResult<Account> = { ok: false, status: 401, code: "UNAUTHENTICATED" };

function fakeApi(me: () => Promise<ApiResult<Account>>, signOut = async () => {}) {
  return { me: vi.fn(me), setTheme: vi.fn(async (): Promise<ApiResult<Account>> => ({ ok: true, data: full })), signOut: vi.fn(signOut) };
}

/** The phone's copy of the theme; `now` is what the app shows. */
function fakeTheme(now: ThemeChoice = "system") {
  const theme = { now, saved: () => theme.now, keep: vi.fn((choice: ThemeChoice) => void (theme.now = choice)) };
  return theme;
}

const start = (api: ReturnType<typeof fakeApi>, theme = fakeTheme()) => createSession(api, theme);

describe("createSession", () => {
  it("starts checking", () => {
    expect(start(fakeApi(async () => refused)).get()).toEqual({ status: "checking" });
  });

  it.each([
    ["signed-in", { ok: true, data: full }],
    ["profile-needed", { ok: true, data: blank }],
    ["profile-needed", { ok: true, data: { ...blank, name: "Asha" } }],
    ["signed-out", refused],
    ["unreachable", { ok: false, status: 503, code: "UNAVAILABLE" }],
  ] as const)("a launch check answers %s", async (status, answer) => {
    const session = start(fakeApi(async () => answer));
    await session.check();
    expect(session.get().status).toBe(status);
  });

  it("keeps the saved token when there is no answer, and Try again checks again", async () => {
    const api = fakeApi(() => Promise.reject(new TypeError("Network request failed")));
    const session = start(api);
    await session.check();
    expect(session.get().status).toBe("unreachable");
    expect(api.signOut).not.toHaveBeenCalled();

    api.me.mockResolvedValueOnce({ ok: true, data: full });
    await session.check();
    expect(session.get()).toEqual({ status: "signed-in", account: full });
  });

  it("drops a launch check that answers after a sign-in", async () => {
    let answer!: (value: ApiResult<Account>) => void;
    const session = start(fakeApi(() => new Promise((resolve) => (answer = resolve))));
    const checking = session.check();
    session.signedIn(blank);
    answer(refused);
    await checking;
    expect(session.get()).toEqual({ status: "profile-needed", account: blank });
  });

  it("goes back to sign-in when the server ends the session", async () => {
    const session = start(fakeApi(async () => ({ ok: true, data: full })));
    await session.check();
    const listener = vi.fn();
    session.subscribe(listener);
    showSignedOut();
    expect(session.get()).toEqual({ status: "signed-out" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("a new session takes the signed-out signal from the last, so listeners never pile up", async () => {
    const first = start(fakeApi(async () => ({ ok: true, data: full })));
    await first.check();
    const second = start(fakeApi(async () => ({ ok: true, data: full })));
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
    const session = start(api);
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

  it("still marks a failed clear when the store signals the sign-out before it throws", async () => {
    // The real store calls showSignedOut, then rejects, when the Keychain delete fails.
    const api = fakeApi(
      async () => ({ ok: true, data: full }),
      async () => {
        showSignedOut();
        throw new Error("Keychain busy");
      },
    );
    const session = start(api);
    session.signedIn(full);
    expect(await session.signOut()).toBe(false);
    expect(session.get()).toEqual({ status: "signed-out", notCleared: true });
  });

  it("keeps a sign-in that lands while a sign-out is finishing", async () => {
    let finish!: () => void;
    const api = fakeApi(
      async () => ({ ok: true, data: full }),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const session = start(api);
    const signingOut = session.signOut();
    session.signedIn(full);
    finish();
    await signingOut;
    expect(session.get()).toEqual({ status: "signed-in", account: full });
  });
});

describe("the theme", () => {
  const dark: Account = { ...full, theme: "dark" };

  it("follows the account at launch and at sign-in, over the phone's copy", async () => {
    const theme = fakeTheme("light");
    const session = start(fakeApi(async () => ({ ok: true, data: dark })), theme);
    await session.check();
    expect(theme.now).toBe("dark");
    session.signedIn({ ...blank, theme: "system" });
    expect(theme.now).toBe("system");
  });

  it("keeps the phone's copy when signed out or unreachable", async () => {
    const theme = fakeTheme("dark");
    await start(fakeApi(async () => refused), theme).check();
    await start(fakeApi(() => Promise.reject(new TypeError("Network request failed"))), theme).check();
    expect(theme.keep).not.toHaveBeenCalled();
  });

  it("ignores the theme of a launch check that answers after a sign-in", async () => {
    let answer!: (value: ApiResult<Account>) => void;
    const theme = fakeTheme();
    const session = start(fakeApi(() => new Promise((resolve) => (answer = resolve))), theme);
    const checking = session.check();
    session.signedIn(full);
    answer({ ok: true, data: dark });
    await checking;
    expect(theme.now).toBe("system");
  });

  it("changes at once and saves the choice to the account", async () => {
    const api = fakeApi(async () => ({ ok: true, data: full }));
    const theme = fakeTheme();
    const session = start(api, theme);
    const saving = session.chooseTheme("dark");
    expect(theme.now).toBe("dark");
    expect(await saving).toBe(true);
    expect(api.setTheme).toHaveBeenCalledExactlyOnceWith({ theme: "dark" });
    expect(theme.now).toBe("dark");
  });

  it.each([
    ["refused", async (): Promise<ApiResult<Account>> => ({ ok: false, status: 503, code: "UNAVAILABLE" })],
    ["unanswered", () => Promise.reject(new TypeError("Network request failed"))],
  ] as const)("goes back to the old theme when the save is %s, and doesn't retry", async (_, setTheme) => {
    const api = fakeApi(async () => ({ ok: true, data: full }));
    api.setTheme.mockImplementationOnce(setTheme);
    const theme = fakeTheme("light");
    const session = start(api, theme);
    expect(await session.chooseTheme("dark")).toBe(false);
    expect(theme.now).toBe("light");
    expect(api.setTheme).toHaveBeenCalledOnce();
  });
});
