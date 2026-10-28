import { describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
  theme: "system",
};
const areaManager = { ...account, role: "area_manager" };
const createBody = {
  email: account.email,
  name: account.name,
  phone: account.phone,
  role: "area_manager" as const,
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
const product = {
  id: "00000000-0000-4000-8000-000000000301",
  name: "Apples",
  brand: "Farm",
  categoryId: category.id,
  categoryName: category.name,
  categoryActive: true,
  categoryEffectiveActive: true,
  baseUnit: "each",
  classification: "counted",
  imageUrls: {
    256: "https://images.test/256.webp",
    512: "https://images.test/512.webp",
    1024: "https://images.test/1024.webp",
  },
  published: true,
  active: true,
};
const pack = { id: "00000000-0000-4000-8000-000000000401", productId: product.id, quantity: "2", barcode: "12345678", active: true };
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
  it("lists waitlist captures with an Admin token and validates the response", async () => {
    const entry = { accountId: account.id, accountName: null, accountEmail: account.email, phone: "+919876543211", pincode: "411038", savedAt: "2030-01-01T00:00:00.000Z" };
    const { client, calls } = setup(({ path }) => path.endsWith("/refresh")
      ? answer(200, { accessToken: "access-1", account })
      : answer(200, { entries: [entry] }));
    expect(await client.listWaitlist()).toEqual({ ok: true, data: { entries: [entry] } });
    expect(calls[1]?.path).toBe("/v1/admin/waitlist");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer access-1");
    const malformed = setup(({ path }) => path.endsWith("/refresh")
      ? answer(200, { accessToken: "access-1", account })
      : answer(200, { entries: [{ ...entry, savedAt: "yesterday" }] }));
    expect(await malformed.client.listWaitlist()).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

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
          : answer(200, { accounts: [areaManager] }),
      );
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(calls).toEqual([]);
      expect(await client.listAccounts()).toEqual({ ok: true, data: { accounts: [areaManager] } });
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
      if (method === "GET") return answer(200, { accounts: [areaManager] });
      return answer(409, { error: { code: conflictCode } });
    });
    await client.verifyCode(code);
    expect(await client.listAccounts()).toEqual({ ok: true, data: { accounts: [areaManager] } });
    expect(await client.createAccount(createBody)).toEqual({ ok: false, status: 409, code: conflictCode, fields: undefined });
    expect(calls.slice(1).map((call) => [call.path, call.method, call.body])).toEqual([
      ["/v1/admin/accounts", "GET", undefined],
      ["/v1/admin/accounts", "POST", createBody],
    ]);
    expect(calls.slice(1).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer access-1", "Bearer access-1",
    ]);
  });

  it("reads the signed-in account with its role and saves its theme (#263, #343)", async () => {
    const dark = { ...account, theme: "dark" };
    const { client, calls } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      return answer(200, method === "GET" ? areaManager : dark);
    });
    expect(await client.me()).toEqual({ ok: true, data: areaManager });
    expect(await client.setTheme({ theme: "dark" })).toEqual({ ok: true, data: dark });
    expect(calls.slice(1).map(({ path, method, body, headers }) => [path, method, body, headers.get("authorization")])).toEqual([
      ["/v1/admin/me", "GET", undefined, "Bearer access-1"],
      ["/v1/admin/me/theme", "PUT", { theme: "dark" }, "Bearer access-1"],
    ]);
    const malformed = setup(({ path }) => path.endsWith("/refresh")
      ? answer(200, { accessToken: "access-1", account })
      : answer(200, { ...account, theme: "blue" }));
    expect(await malformed.client.setTheme({ theme: "dark" })).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

  it("asks for the role once per sign-in and forgets it when the session ends (#343)", async () => {
    const { client, calls } = setup(({ path }) =>
      path.endsWith("/refresh") ? answer(200, { accessToken: "access-1", account }) : answer(200, areaManager));
    expect(client.currentRole()).toBeNull();
    expect(await client.role()).toEqual({ ok: true, data: "area_manager" });
    expect(await client.role()).toEqual({ ok: true, data: "area_manager" });
    expect(client.currentRole()).toBe("area_manager");
    expect(calls.filter(({ path }) => path === "/v1/admin/me")).toHaveLength(1);
    await client.signOut();
    expect(client.currentRole()).toBeNull();
    expect(await client.role()).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("parses a created account and its role", async () => {
    const { client } = setup(({ path }) =>
      path.endsWith("/verify")
        ? answer(200, { accessToken: "access-1", account })
        : answer(201, areaManager),
    );
    await client.verifyCode(code);
    expect(await client.createAccount(createBody)).toEqual({ ok: true, data: areaManager });
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

  it("lists, creates and edits master products with the Admin session", async () => {
    const { client, calls } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET") return answer(200, { products: [product] });
      return answer(method === "POST" ? 201 : 200, product);
    });
    const create = {
      name: product.name,
      brand: product.brand,
      categoryId: product.categoryId,
      baseUnit: "each" as const,
      classification: "counted" as const,
      image: "aW1hZ2U=",
    };
    expect(await client.listMasterProducts()).toEqual({ ok: true, data: { products: [product] } });
    expect(await client.createMasterProduct(create)).toEqual({ ok: true, data: product });
    expect(await client.editMasterProduct(product.id, { name: "Green apples" })).toEqual({ ok: true, data: product });
    expect(calls.slice(1).map(({ path, method, body }) => [path, method, body])).toEqual([
      ["/v1/admin/products", "GET", undefined],
      ["/v1/admin/products", "POST", create],
      [`/v1/admin/products/${product.id}`, "PATCH", { name: "Green apples" }],
    ]);
    expect(calls.slice(1).every(({ headers }) => headers.get("authorization") === "Bearer access-1")).toBe(true);
  });

  it("lists, creates and edits packs with the Admin session", async () => {
    const { client, calls } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET") return answer(200, { packs: [pack] });
      return answer(method === "POST" ? 201 : 200, pack);
    });
    const create = { baseUnit: "each" as const, quantity: "2", barcode: pack.barcode };
    expect(await client.listPacks(product.id)).toEqual({ ok: true, data: { packs: [pack] } });
    expect(await client.createPack(product.id, create)).toEqual({ ok: true, data: pack });
    expect(await client.editPack(product.id, pack.id, { active: false, reason: "Discontinued" })).toEqual({ ok: true, data: pack });
    expect(calls.slice(1).map(({ path, method, body }) => [path, method, body])).toEqual([
      [`/v1/admin/products/${product.id}/packs`, "GET", undefined],
      [`/v1/admin/products/${product.id}/packs`, "POST", create],
      [`/v1/admin/products/${product.id}/packs/${pack.id}`, "PATCH", { active: false, reason: "Discontinued" }],
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
    const created = { name: "Kothrud", pincodes: ["411029", "411038"], reason: "Pilot launch" };
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

  it("lists, reads, corrects, assigns, starts review of and approves shop applications", async () => {
    const application = {
      id: "00000000-0000-4000-8000-000000000401",
      state: "submitted",
      shopName: "Sai General Stores",
      address: "Shop 3, Paud Road, Kothrud",
      pincode: "411038",
      location: null,
      ownerName: "Asha Kulkarni",
      entityType: null,
      pan: null,
      fssaiNumber: null,
      fssaiExpiry: null,
      serviceRadiusMetres: 2000,
      upiId: null,
      areaName: "Kothrud",
      ownerPhone: "+919876543210",
      ownerEmail: "asha@example.com",
      submittedAt: "2026-10-25T10:00:00.000Z",
      areaManager: { id: "00000000-0000-4000-8000-000000000402", name: "Ravi Patil", email: "ravi@example.com" },
    };
    const { client, calls } = setup(({ path, method }) => {
      if (path.endsWith("/refresh")) return answer(200, { accessToken: "access-1", account });
      if (method === "GET" && path.endsWith("/shop-applications")) return answer(200, { applications: [application] });
      return answer(200, application);
    });
    const correction = { upiId: "asha@oksbi", reason: "Owner gave the right UPI id" };
    const path = `/v1/admin/shop-applications/${application.id}`;
    expect(await client.listShopApplications()).toEqual({ ok: true, data: { applications: [application] } });
    expect(await client.getShopApplication(application.id)).toEqual({ ok: true, data: application });
    expect(await client.correctShopApplication(application.id, correction)).toEqual({ ok: true, data: application });
    const assignment = { areaManagerId: application.areaManager.id, reason: "Near their route" };
    expect(await client.assignShopAreaManager(application.id, assignment)).toEqual({ ok: true, data: application });
    expect(await client.startShopApplicationReview(application.id)).toEqual({ ok: true, data: application });
    expect(await client.approveShopApplication(application.id)).toEqual({ ok: true, data: application });
    expect(calls.slice(1).map(({ path, method, body }) => [path, method, body])).toEqual([
      ["/v1/admin/shop-applications", "GET", undefined],
      [path, "GET", undefined],
      [path, "PATCH", correction],
      [`${path}/area-manager`, "PUT", assignment],
      [`${path}/start-review`, "POST", undefined],
      [`${path}/approve`, "POST", undefined],
    ]);
  });

  it("passes on each pincode another Area holds", async () => {
    const conflicts = [{ pincode: "411038", areaName: "Kothrud" }];
    const { client } = setup(({ path }) =>
      path.endsWith("/refresh")
        ? answer(200, { accessToken: "access-1", account })
        : answer(409, { error: { code: "PINCODE_IN_OTHER_AREA", conflicts } }),
    );
    expect(await client.createArea({ name: "Karve Nagar", pincodes: ["411038", "411052"], reason: "Second Area" })).toEqual({
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
      return answer(200, { accounts: [areaManager] });
    });
    const first = client.listAccounts();
    const second = client.listAccounts();
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, data: { accounts: [areaManager] } },
      { ok: true, data: { accounts: [areaManager] } },
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
        : answer(200, { accounts: [areaManager] });
    });
    await client.verifyCode(code);
    const first = client.listAccounts();
    const second = client.listAccounts();
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, data: { accounts: [areaManager] } },
      { ok: true, data: { accounts: [areaManager] } },
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
      path.endsWith("/sign-out") ? answer(503, { error: { code: "UNAVAILABLE" } }) : answer(200, { accounts: [areaManager] }),
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
