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
  /** The store methods whose next call fails, as when secure storage is unavailable. */
  const failing = new Set<"get" | "set" | "clear">();
  const fail = (op: "get" | "set" | "clear") => {
    if (!failing.delete(op)) return;
    throw new Error("Keychain unavailable");
  };
  const onSignedOut = vi.fn();
  const onUpdateRequired = vi.fn();
  const client = createApiClient({
    baseUrl: "https://api.test",
    onSignedOut,
    onUpdateRequired,
    session: {
      get: async () => {
        fail("get");
        return stored;
      },
      set: async (token) => {
        sets.push(token);
        fail("set");
        const wait = held;
        held = null;
        await wait;
        stored = token;
      },
      clear: async () => {
        fail("clear");
        stored = null;
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
  /** Makes the store's next `op` fail, as when secure storage is unavailable. */
  const failNext = (op: "get" | "set" | "clear") => {
    failing.add(op);
  };
  return { client, calls, refreshes, sets, holdNextSet, failNext, stored: () => stored, onSignedOut, onUpdateRequired };
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

  it("keeps no session when the phone cannot save it", async () => {
    const { client, calls, failNext } = setup(fakeServer().handle);
    failNext("set");
    await expect(client.verifyCode(signIn)).rejects.toThrow("Keychain unavailable");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify"]);
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

  it("keeps the saved token when a 400 does not name it", async () => {
    const { client, stored, onSignedOut } = setup(
      () => answer(400, { error: { code: "VALIDATION_FAILED", fields: ["email"] } }),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 400, code: "INTERNAL" });
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("clears the store when a refresh succeeds but breaks the contract, since the saved token is used up", async () => {
    const { client, calls, stored, onSignedOut } = setup(() => answer(200, { accessToken: "a1", account }), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 200, code: "INTERNAL" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    // Trying again doesn't send the used-up token.
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls).toHaveLength(1);
  });

  it("keeps the saved token when a refresh failure is not JSON, so trying again refreshes with it", async () => {
    const fake = fakeServer();
    let refreshes = 0;
    const { client, calls, stored, onSignedOut } = setup((call) => {
      if (call.path === "/v1/auth/refresh" && ++refreshes === 1) return new Response("<html>Bad gateway</html>", { status: 502 });
      return fake.handle(call);
    }, "r0");
    expect(await client.me()).toEqual({ ok: false, status: 502, code: "INTERNAL" });
    expect(stored()).toBe("r0");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.map((call) => call.body)).toEqual([{ refreshToken: "r0" }, { refreshToken: "r0" }, undefined]);
    expect(stored()).toBe("r2");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("rejects a call when the phone cannot read the saved token, and the next call reads it again", async () => {
    const { client, calls, failNext } = setup(fakeServer().handle, "r0");
    failNext("get");
    await expect(client.me()).rejects.toThrow("Keychain unavailable");
    expect(calls).toEqual([]);
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls[0]?.body).toEqual({ refreshToken: "r0" });
  });

  it("keeps a refreshed session in memory when the phone cannot save it, since the old token is used up", async () => {
    const { client, calls, refreshes, failNext } = setup(fakeServer().handle, "r0");
    failNext("set");
    await expect(client.me()).rejects.toThrow("Keychain unavailable");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(refreshes()).toBe(1);
    expect(calls.at(-1)?.auth).toBe("Bearer a2");
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

  it("passes on two calls refused together and still refused after their shared refresh", async () => {
    const { client, calls, refreshes } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);
    const results = await Promise.all([client.me(), client.changeName({ name: "Asha K" })]);
    expect(results).toEqual([
      { ok: false, status: 401, code: "UNAUTHENTICATED" },
      { ok: false, status: 401, code: "UNAUTHENTICATED" },
    ]);
    expect(refreshes()).toBe(1);
    expect(calls.map((call) => call.auth)).toEqual([null, "Bearer a1", "Bearer a1", null, "Bearer a2", "Bearer a2"]);
  });

  it("sends a call refused after the refresh has landed again with the new token, without refreshing again", async () => {
    const server = holds();
    const fake = fakeServer();
    const { client, calls, refreshes } = setup(async (call) => {
      if (call.auth === "Bearer a1") await server.hold(call.path);
      return fake.handle(call);
    });
    await client.verifyCode(signIn);
    fake.expire();

    const loading = client.me();
    const saving = client.setProfile({ name: "Asha Kulkarni", phone: "+919876543210" });
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/me");
    expect(await loading).toEqual({ ok: true, data: account });
    server.release("/v1/me/profile");
    expect(await saving).toEqual({ ok: true, data: account });

    expect(refreshes()).toBe(1);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/me/profile", auth: "Bearer a2" });
  });

  it("refreshes once at most, so a call refused after refreshing first sends two requests, not four", async () => {
    const { client, calls } = setup(
      (call) => (call.path === "/v1/auth/refresh" ? answer(200, pair(1)) : answer(401, unauthenticated)),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
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

  it("answers a call made while it runs as signed out, without asking the server", async () => {
    const server = holds();
    const fake = fakeServer();
    const { client, calls, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/sign-out") await server.hold(call.path);
      return fake.handle(call);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify", "/v1/auth/sign-out"]);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not refresh for a call begun before it and refused while it runs", async () => {
    const server = holds();
    const { client, refreshes, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      await server.hold(call.path);
      return call.path === "/v1/auth/sign-out" ? answer(204) : answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const loading = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/me");
    expect(await loading).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(refreshes()).toBe(0);
    expect(stored()).toBeNull();
  });

  it("rejects when the phone cannot clear the saved token, and leaves later calls signed out", async () => {
    const { client, calls, failNext } = setup(fakeServer().handle);
    await client.verifyCode(signIn);
    failNext("clear");
    await expect(client.signOut()).rejects.toThrow("Keychain unavailable");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify", "/v1/auth/sign-out"]);
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

  it("a sign-out while a refresh is saving its token waits for it, then leaves no session", async () => {
    const { client, calls, sets, holdNextSet, stored, onSignedOut } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);
    const release = holdNextSet();

    const loading = client.me();
    await vi.waitFor(() => expect(sets).toEqual(["r1", "r2"]));
    const signingOut = client.signOut();
    await settle();
    release();
    await signingOut;

    expect(await loading).toEqual(signedOut);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(await client.me()).toEqual(signedOut);
    expect(calls.filter((call) => call.path === "/v1/auth/sign-out").map((call) => call.auth)).toEqual([
      "Bearer a2",
    ]);
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

  it("keeps a sign-in begun during a sign-out that answers after the sign-out ends", async () => {
    const server = holds();
    let signIns = 0;
    const { client, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") {
        if (++signIns === 2) await server.hold(call.path);
        return answer(200, pair(signIns));
      }
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(200, account);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/auth/sign-out");
    await signingOut;
    server.release("/v1/auth/verify");

    expect(await signingIn).toEqual({ ok: true, data: account });
    expect(stored()).toBe("r2");
    expect(await client.me()).toEqual({ ok: true, data: account });
  });

  it("calls onSignedOut when a sign-in kept during an older sign-out then ends", async () => {
    const server = holds();
    const { client, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    expect(await client.me()).toEqual(signedOut);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(stored()).toBeNull();
  });

  it("a refresh that answers after a newer sign-in changes nothing", async () => {
    const server = holds();
    const { client, calls, sets, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return answer(200, pair(9));
      }
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    server.release("/v1/auth/refresh");

    // The call begun before the sign-in is not sent with either session's token.
    expect(await opening).toEqual(signedOut);
    expect(sets).toEqual(["r1"]);
    expect(stored()).toBe("r1");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("a call after a sign-in does not wait for a refresh begun before it", async () => {
    const server = holds();
    const { client } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        throw new TypeError("Network request failed");
      }
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    let loaded = false;
    const loading = client.me().finally(() => (loaded = true));
    await vi.waitFor(() => expect(loaded).toBe(true));
    server.release("/v1/auth/refresh");

    expect(await loading).toEqual({ ok: true, data: account });
    await expect(opening).rejects.toThrow("Network request failed");
  });

  it("a sign-out tapped twice does not count as the session ending by itself", async () => {
    const server = holds();
    let signOuts = 0;
    const { client, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/sign-out" && ++signOuts === 1) {
        await server.hold(call.path);
        return answer(204);
      }
      if (call.path === "/v1/auth/refresh") await server.hold(call.path);
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const first = client.signOut();
    const second = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/auth/sign-out");
    await first;
    server.release("/v1/auth/refresh");
    await second;

    expect(onSignedOut).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it("a sign-out while the app is opening tells the server, with the refreshed token", async () => {
    const server = holds();
    const { client, calls, refreshes, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return answer(200, pair(1));
      }
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingOut = client.signOut();
    server.release("/v1/auth/refresh");
    await signingOut;
    await opening;

    expect(calls.filter((call) => call.path === "/v1/auth/sign-out")).toEqual([
      { method: "POST", path: "/v1/auth/sign-out", body: undefined, auth: "Bearer a1" },
    ]);
    expect(refreshes()).toBe(1);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
