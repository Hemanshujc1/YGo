import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
};
const pair = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, account });
const unauthenticated = { error: { code: "UNAUTHENTICATED" } };

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/**
 * A server that signs in with pair 1 and issues the next pair on each
 * refresh. Only the newest access token is accepted.
 */
function fakeServer() {
  let issued = 1;
  let valid = "a1";
  return {
    expire() {
      valid = "";
    },
    handle(call: Call): Response {
      if (call.path === "/v1/auth/code") return answer(204);
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        issued += 1;
        valid = `a${issued}`;
        return answer(200, pair(issued));
      }
      if (call.auth !== `Bearer ${valid}`) return answer(401, unauthenticated);
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return answer(200, account);
    },
  };
}

/** A client over `handle`, with a store holding `saved` as if from an earlier launch. */
function setup(handle: (call: Call) => Response | Promise<Response>, saved: string | null = null) {
  const calls: Call[] = [];
  let stored = saved;
  /** Each token passed to `set`, when it is called. */
  const sets: string[] = [];
  let held: Promise<void> | null = null;
  const onSignedOut = vi.fn();
  const onUpdateRequired = vi.fn();
  const client = createApiClient({
    baseUrl: "https://api.test",
    onSignedOut,
    onUpdateRequired,
    session: {
      get: () => Promise.resolve(stored),
      set: async (token) => {
        sets.push(token);
        const wait = held;
        held = null;
        await wait;
        stored = token;
      },
      clear: () => {
        stored = null;
        return Promise.resolve();
      },
    },
    fetch: (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        auth: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      return Promise.resolve(handle(call));
    },
  });
  const refreshes = () => calls.filter((call) => call.path === "/v1/auth/refresh").length;
  /** Holds the store's next `set` until the returned function is called. */
  const holdNextSet = () => {
    let release = () => {};
    held = new Promise((resolve) => (release = resolve));
    return () => release();
  };
  return { client, calls, refreshes, sets, holdNextSet, stored: () => stored, onSignedOut, onUpdateRequired };
}

/** A server answer held until `release(path)`; `waiting()` counts those held. */
function holds() {
  const held = new Map<string, () => void>();
  return {
    hold: (path: string) => new Promise<void>((release) => held.set(path, release)),
    release: (path: string) => held.get(path)?.(),
    waiting: () => held.size,
  };
}

const signIn = { email: "asha@example.com", code: "123456" };

describe("each call", () => {
  it("sends its method, path, body and token", async () => {
    const { client, calls, stored } = setup(fakeServer().handle);
    expect(await client.requestCode({ email: "asha@example.com" })).toEqual({ ok: true, data: undefined });
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: true,
      data: account,
    });
    expect(stored()).toBe("r1");
    await client.me();
    await client.setProfile({ name: "Asha Kulkarni", phone: "+919876543210" });
    await client.changeName({ name: "Asha K" });
    await client.signOut();

    expect(calls).toEqual([
      { method: "POST", path: "/v1/auth/code", body: { email: "asha@example.com" }, auth: null },
      { method: "POST", path: "/v1/auth/verify", body: { email: "asha@example.com", code: "123456" }, auth: null },
      { method: "GET", path: "/v1/me", body: undefined, auth: "Bearer a1" },
      {
        method: "PUT",
        path: "/v1/me/profile",
        body: { name: "Asha Kulkarni", phone: "+919876543210" },
        auth: "Bearer a1",
      },
      { method: "PATCH", path: "/v1/me", body: { name: "Asha K" }, auth: "Bearer a1" },
      { method: "POST", path: "/v1/auth/sign-out", body: undefined, auth: "Bearer a1" },
    ]);
    expect(stored()).toBeNull();
  });

  it("counts a sign-in answer that breaks the contract as INTERNAL and keeps no session", async () => {
    const { client, stored } = setup(() => answer(200, { accessToken: "a1", account }));
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: false,
      status: 200,
      code: "INTERNAL",
    });
    expect(stored()).toBeNull();
  });

  it("passes on a refused code", async () => {
    const { client } = setup(() => answer(400, { error: { code: "CODE_WRONG" } }));
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: false,
      status: 400,
      code: "CODE_WRONG",
    });
  });

  it("refuses to sign in without a session store", async () => {
    const client = createApiClient({ baseUrl: "https://api.test", fetch: () => Promise.resolve(answer(200, pair(1))) });
    await expect(client.verifyCode({ email: "asha@example.com", code: "123456" })).rejects.toThrow(
      "session store",
    );
  });
});

describe("refresh", () => {
  it("refreshes once when the access token has expired, and the call succeeds", async () => {
    const server = fakeServer();
    const { client, calls, refreshes, stored } = setup(server.handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    server.expire();

    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(refreshes()).toBe(1);
    expect(calls.find((call) => call.path === "/v1/auth/refresh")?.body).toEqual({ refreshToken: "r1" });
    expect(calls.at(-1)?.auth).toBe("Bearer a2");
    expect(stored()).toBe("r2");
  });

  it("shares one refresh between three calls refused together", async () => {
    const server = fakeServer();
    const { client, refreshes } = setup(server.handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    server.expire();

    const results = await Promise.all([client.me(), client.me(), client.changeName({ name: "Asha K" })]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(refreshes()).toBe(1);
  });

  it("refreshes before the first call when only the saved token is left, as when the app has just opened", async () => {
    const { client, calls } = setup(fakeServer().handle, "r0");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
    expect(calls[0]?.body).toEqual({ refreshToken: "r0" });
  });

  it("answers UNAUTHENTICATED without calling the server when there is no session", async () => {
    const { client, calls, onSignedOut } = setup(fakeServer().handle);
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls).toEqual([]);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("clears the store and calls onSignedOut when the server refuses the refresh token", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(401, unauthenticated), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("clears the store when the server says the refresh token is malformed", async () => {
    const { client, stored, onSignedOut } = setup(
      () => answer(400, { error: { code: "VALIDATION_FAILED", fields: ["refreshToken"] } }),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("shares a failed refresh too, so calls refused together do not refresh twice", async () => {
    const { client, refreshes } = setup(() => answer(503, { error: { code: "UNAVAILABLE" } }), "r0");
    const results = await Promise.all([client.me(), client.changeName({ name: "Asha K" })]);
    expect(results).toEqual([
      { ok: false, status: 503, code: "UNAVAILABLE" },
      { ok: false, status: 503, code: "UNAVAILABLE" },
    ]);
    expect(refreshes()).toBe(1);
  });

  it("keeps the saved token when there is no network", async () => {
    const { client, stored, onSignedOut } = setup(() => Promise.reject(new TypeError("Network request failed")), "r0");
    await expect(client.me()).rejects.toThrow("Network request failed");
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("keeps the saved token and passes on the answer when the server is down", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(503, { error: { code: "UNAVAILABLE" } }), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("passes on a call still refused after a refresh, without refreshing again", async () => {
    // Signs in and refreshes, but refuses every other call.
    const { client, refreshes } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      return answer(401, unauthenticated);
    });
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(refreshes()).toBe(1);
  });
});

describe("signOut", () => {
  it("clears the store when the network is down", async () => {
    const { client, stored, onSignedOut } = setup(() => Promise.reject(new TypeError("Network request failed")), "r0");
    await client.signOut();
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not call onSignedOut when the session had already ended", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(401, unauthenticated), "r0");
    await client.signOut();
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("fires onUpdateRequired when the server refuses this version", async () => {
    const { client, stored, onUpdateRequired } = setup(() => answer(426, { error: { code: "UPDATE_REQUIRED" } }), "r0");
    await client.signOut();
    expect(onUpdateRequired).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it("is not undone by a refresh that lands after it", async () => {
    const server = holds();
    const { client, calls, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/sign-out" || call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return call.path === "/v1/auth/sign-out" ? answer(204) : answer(200, pair(2));
      }
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    const loading = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/auth/sign-out");
    await signingOut;
    server.release("/v1/auth/refresh");

    expect(await loading).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.path === "/v1/me" && call.auth === null)).toEqual([]);
  });

  it("leaves later calls signed out", async () => {
    const { client } = setup(fakeServer().handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    await client.signOut();
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  });
});

describe("a sign-in or sign-out during another change", () => {
  const signedOut = { ok: false, status: 401, code: "UNAUTHENTICATED" };
  /** Lets every answer and store write already released finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a sign-out while a refresh is saving its token leaves no session", async () => {
    const server = holds();
    const { client, calls, sets, holdNextSet, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);
    const release = holdNextSet();

    const signingOut = client.signOut();
    const loading = client.me();
    await vi.waitFor(() => expect(sets).toEqual(["r1", "r2"]));
    server.release("/v1/auth/sign-out");
    await settle();
    release();
    await signingOut;

    expect(await loading).toEqual(signedOut);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(await client.me()).toEqual(signedOut);
    expect(calls.filter((call) => call.auth === "Bearer a2")).toEqual([]);
  });

  it("a newer sign-in while a refresh is saving its token keeps the newer session", async () => {
    let signIns = 0;
    const { client, calls, sets, holdNextSet, stored } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(++signIns * 10));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(11));
      if (call.auth === "Bearer a10") return answer(401, unauthenticated);
      return answer(200, account);
    });
    await client.verifyCode(signIn);
    const release = holdNextSet();

    const loading = client.me();
    await vi.waitFor(() => expect(sets).toEqual(["r10", "r11"]));
    const signingIn = client.verifyCode(signIn);
    await settle();
    release();

    expect(await signingIn).toEqual({ ok: true, data: account });
    // A call begun in the older session is not sent with the newer one.
    expect(await loading).toEqual(signedOut);
    expect(sets).toEqual(["r10", "r11", "r20"]);
    expect(stored()).toBe("r20");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a20");
  });

  it("drops a sign-in answer that arrives after sign-out", async () => {
    const server = holds();
    const { client, calls, stored } = setup(async (call) => {
      await server.hold(call.path);
      return answer(200, pair(1));
    });

    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.signOut();
    server.release("/v1/auth/verify");

    expect(await signingIn).toEqual(signedOut);
    expect(stored()).toBeNull();
    expect(await client.me()).toEqual(signedOut);
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify"]);
  });

  it("a sign-out does not clear a sign-in begun after it", async () => {
    const server = holds();
    let signIns = 0;
    const { client, calls, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(++signIns));
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(200, account);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    expect(await client.verifyCode(signIn)).toEqual({ ok: true, data: account });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(stored()).toBe("r2");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a2");
  });
});
