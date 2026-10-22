import { describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
};
const createBody = {
  email: account.email,
  name: account.name,
  phone: account.phone,
  reason: "Add a second platform administrator",
};
const code = { email: account.email, code: "123456" };
const category = {
  id: "00000000-0000-4000-8000-000000000101",
  parentId: null,
  name: "Groceries",
  active: true,
  effectiveActive: true,
};
const area = {
  id: "00000000-0000-4000-8000-000000000201",
  name: "Kothrud",
  pincodes: ["411029", "411038"],
  paused: false,
};
const denied = { error: { code: "UNAUTHENTICATED" } };
const forbidden = { error: { code: "FORBIDDEN" } };
const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

interface Call {
  path: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

function setup(handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const onSignedOut = vi.fn();
  const client = createAdminApiClient({
    baseUrl: "https://api.test/",
    onSignedOut,
    fetch: async (input, init) => {
      const call: Call = {
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handle(call);
    },
  });
  const refreshes = () => calls.filter((call) => call.path === "/v1/admin/auth/refresh");
  return { client, calls, refreshes, onSignedOut };
}

describe("Admin browser API client", () => {
  it("requests a code and verifies without exposing a refresh token or app headers", async () => {
    const { client, calls } = setup(({ path }) =>
      path.endsWith("/code") ? answer(204) : answer(200, { accessToken: "access-1", account }),
    );
    expect(await client.requestCode({ email: account.email })).toEqual({ ok: true, data: undefined });
    expect(await client.verifyCode(code)).toEqual({ ok: true, data: account });
    expect(calls.map((call) => [call.path, call.body])).toEqual([
      ["/v1/admin/auth/code", { email: account.email }],
      ["/v1/admin/auth/verify", code],
    ]);
    for (const call of calls) {
      expect(call.credentials).toBe("include");
      expect(call.headers.has("x-ygo-app-name")).toBe(false);
      expect(call.headers.has("x-ygo-app-version")).toBe(false);
      expect(call.headers.has("authorization")).toBe(false);
      expect(call.headers.has("cookie")).toBe(false);
      expect(call.headers.has("x-ygo-admin-refresh")).toBe(false);
    }
    expect(JSON.stringify(await client.verifyCode(code))).not.toContain("refreshToken");
  });

  it("rejects a browser session response that exposes a refresh token", async () => {
    const { client } = setup(() => answer(200, { accessToken: "access-1", refreshToken: "secret", account }));
    expect(await client.verifyCode(code)).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

  it("refreshes only when an account call needs access, never on a timer", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls, refreshes } = setup(({ path }) =>
        path.endsWith("/refresh")
          ? answer(200, { accessToken: "access-1", account })
          : answer(200, { accounts: [account] }),
      );
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(calls).toEqual([]);
      expect(await client.listAccounts()).toEqual({ ok: true, data: { accounts: [account] } });
      expect(refreshes()).toHaveLength(1);
      expect(calls[0]?.headers.get("x-ygo-admin-refresh")).toBe("1");
      expect(calls[0]?.credentials).toBe("include");
      expect(calls[0]?.body).toBeUndefined();
      expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-1");
      expect(calls[1]?.credentials).toBeUndefined();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(refreshes()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["EMAIL_IN_USE", "PHONE_IN_USE"])("lists accounts and preserves %s on create", async (conflictCode) => {
    const { client, calls } = setup(({ path, method }) => {
      if (path.endsWith("/verify")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET") return answer(200, { accounts: [account] });
      return answer(409, { error: { code: conflictCode } });
    });
    await client.verifyCode(code);
    expect(await client.listAccounts()).toEqual({ ok: true, data: { accounts: [account] } });
    expect(await client.createAccount(createBody)).toEqual({ ok: false, status: 409, code: conflictCode, fields: undefined });
    expect(calls.slice(1).map((call) => [call.path, call.method, call.body])).toEqual([
      ["/v1/admin/accounts", "GET", undefined],
      ["/v1/admin/accounts", "POST", createBody],
    ]);
    expect(calls.slice(1).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer access-1", "Bearer access-1",
    ]);
  });

  it("parses a created Admin account", async () => {
    const { client } = setup(({ path }) =>
      path.endsWith("/verify")
        ? answer(200, { accessToken: "access-1", account })
        : answer(201, account),
    );
    await client.verifyCode(code);
    expect(await client.createAccount(createBody)).toEqual({ ok: true, data: account });
  });

  it("lists, creates and edits categories with the Admin session", async () => {
    const { client, calls, refreshes } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET") return answer(200, { categories: [category] });
      return answer(method === "POST" ? 201 : 200, category);
    });
    expect(await client.listCategories()).toEqual({ ok: true, data: { categories: [category] } });
    expect(await client.createCategory({ name: "Groceries", parentId: null })).toEqual({ ok: true, data: category });
    expect(await client.editCategory(category.id, { active: false, reason: "No longer used" })).toEqual({ ok: true, data: category });
    expect(refreshes()).toHaveLength(1);
    expect(calls.slice(1).map(({ path, method, body }) => [path, method, body])).toEqual([
      ["/v1/admin/categories", "GET", undefined],
      ["/v1/admin/categories", "POST", { name: "Groceries", parentId: null }],
      [`/v1/admin/categories/${category.id}`, "PATCH", { active: false, reason: "No longer used" }],
    ]);
    expect(calls.slice(1).every(({ headers }) => headers.get("authorization") === "Bearer access-1")).toBe(true);
  });

  it("retries a category write after 401 and preserves category conflict codes", async () => {
    const { client, calls, refreshes } = setup(({ path, method, headers }) => {
      if (path.endsWith("/verify")) return answer(200, { accessToken: "access-1", account });
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-2", account });
      if (method === "POST" && headers.get("authorization") === "Bearer access-1") return answer(401, denied);
      return answer(409, { error: { code: "CATEGORY_NAME_IN_USE" } });
    });
    await client.verifyCode(code);
    expect(await client.createCategory({ name: "Groceries", parentId: null })).toEqual({
      ok: false, status: 409, code: "CATEGORY_NAME_IN_USE", fields: undefined,
    });
    expect(refreshes()).toHaveLength(1);
    expect(calls.filter(({ path }) => path === "/v1/admin/categories").map(({ headers }) => headers.get("authorization"))).toEqual([
      "Bearer access-1", "Bearer access-2",
    ]);
  });

  it("lists, creates and edits Areas with the Admin session", async () => {
    const { client, calls, refreshes } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET") return answer(200, { areas: [area] });
      return answer(method === "POST" ? 201 : 200, area);
    });
    const created = { name: "Kothrud", pincodes: ["411029", "411038"] };
    expect(await client.listAreas()).toEqual({ ok: true, data: { areas: [area] } });
    expect(await client.createArea(created)).toEqual({ ok: true, data: area });
    expect(await client.editArea(area.id, { paused: true, reason: "Monsoon flooding" })).toEqual({ ok: true, data: area });
    expect(await client.editArea(area.id, { pincodes: ["411029"], reason: "Split off Karve Nagar" })).toEqual({ ok: true, data: area });
    expect(refreshes()).toHaveLength(1);
    expect(calls.slice(1).map(({ path, method, body }) => [path, method, body])).toEqual([
      ["/v1/admin/areas", "GET", undefined],
      ["/v1/admin/areas", "POST", created],
      [`/v1/admin/areas/${area.id}`, "PATCH", { paused: true, reason: "Monsoon flooding" }],
      [`/v1/admin/areas/${area.id}`, "PATCH", { pincodes: ["411029"], reason: "Split off Karve Nagar" }],
    ]);
    expect(calls.slice(1).every(({ headers }) => headers.get("authorization") === "Bearer access-1")).toBe(true);
  });

  it("passes on each pincode another Area holds", async () => {
    const conflicts = [{ pincode: "411038", areaName: "Kothrud" }];
    const { client } = setup(({ path }) =>
      path.endsWith("/refresh")
        ? answer(200, { accessToken: "access-1", account })
        : answer(409, { error: { code: "PINCODE_IN_OTHER_AREA", conflicts } }),
    );
    expect(await client.createArea({ name: "Karve Nagar", pincodes: ["411038", "411052"] })).toEqual({
      ok: false, status: 409, code: "PINCODE_IN_OTHER_AREA", fields: undefined, conflicts,
    });
  });

  it("refreshes after a 401, retries once, and ends the session on a second 401", async () => {
    let accountCalls = 0;
    const { client, calls, refreshes, onSignedOut } = setup(({ path }) => {
      if (path.endsWith("/verify")) return answer(200, { accessToken: "access-1", account });
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-2", account });
      accountCalls += 1;
      return answer(401, denied);
    });
    await client.verifyCode(code);
    expect(await client.listAccounts()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED", fields: undefined });
    expect(accountCalls).toBe(2);
    expect(refreshes()).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/accounts")).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer access-1", "Bearer access-2",
    ]);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(await client.listAccounts()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED", fields: undefined });
    expect(refreshes()).toHaveLength(1);
  });

  it("ends the session on an account 403 without refreshing", async () => {
    const { client, refreshes, onSignedOut } = setup(({ path }) =>
      path.endsWith("/verify")
        ? answer(200, { accessToken: "access-1", account })
        : answer(403, forbidden),
    );
    await client.verifyCode(code);
    expect(await client.listAccounts()).toEqual({ ok: false, status: 403, code: "FORBIDDEN", fields: undefined });
    expect(refreshes()).toHaveLength(0);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("ends the session when refresh is refused with %i", async (status) => {
    const { client, refreshes, onSignedOut } = setup(() => answer(status, status === 401 ? denied : forbidden));
    expect(await client.listAccounts()).toMatchObject({ ok: false, status });
    expect(refreshes()).toHaveLength(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(await client.listAccounts()).toMatchObject({ ok: false, status: 401 });
    expect(refreshes()).toHaveLength(1);
  });

  it("shares one refresh across concurrent account calls", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const { client, calls, refreshes } = setup(async ({ path }) => {
      if (path.endsWith("/refresh")) {
        await waiting;
        return answer(200, { accessToken: "access-1", account });
      }
      return answer(200, { accounts: [account] });
    });
    const first = client.listAccounts();
    const second = client.listAccounts();
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, data: { accounts: [account] } },
      { ok: true, data: { accounts: [account] } },
    ]);
    expect(calls.filter((call) => call.path.endsWith("/accounts"))).toHaveLength(2);
  });

  it("shares one refresh when concurrent account calls both receive 401", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const { client, calls, refreshes } = setup(async ({ path, headers }) => {
      if (path.endsWith("/verify")) return answer(200, { accessToken: "access-1", account });
      if (path.endsWith("/refresh")) {
        await waiting;
        return answer(200, { accessToken: "access-2", account });
      }
      return headers.get("authorization") === "Bearer access-1"
        ? answer(401, denied)
        : answer(200, { accounts: [account] });
    });
    await client.verifyCode(code);
    const first = client.listAccounts();
    const second = client.listAccounts();
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, data: { accounts: [account] } },
      { ok: true, data: { accounts: [account] } },
    ]);
    expect(refreshes()).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/accounts")).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer access-1", "Bearer access-1", "Bearer access-2", "Bearer access-2",
    ]);
  });

  it.each([204, 401])("treats sign-out status %i as complete without firing onSignedOut", async (status) => {
    const { client, calls, onSignedOut } = setup(({ path }) =>
      path.endsWith("/sign-out") ? answer(status, status === 401 ? denied : undefined) : answer(200, { accessToken: "access-1", account }),
    );
    await client.verifyCode(code);
    expect(await client.signOut()).toEqual({ ok: true, data: undefined });
    expect(calls[1]?.path).toBe("/v1/admin/auth/sign-out");
    expect(calls[1]?.credentials).toBe("include");
    expect(calls[1]?.headers.get("x-ygo-admin-refresh")).toBe("1");
    expect(calls[1]?.headers.has("authorization")).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(await client.listAccounts()).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(2);
  });

  it("reports an unexpected sign-out answer, without restoring local access", async () => {
    const { client, calls, onSignedOut } = setup(({ path }) =>
      path.endsWith("/sign-out") ? answer(503, { error: { code: "UNAVAILABLE" } }) : answer(200, { accounts: [account] }),
    );
    expect(await client.signOut()).toEqual({ ok: false, status: 503, code: "UNAVAILABLE", fields: undefined });
    expect(await client.listAccounts()).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(1);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("rejects on sign-out network failure and leaves local access ended", async () => {
    const { client, calls, onSignedOut } = setup(() => { throw new TypeError("Network request failed"); });
    await expect(client.signOut()).rejects.toThrow("Network request failed");
    expect(await client.listAccounts()).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(1);
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
