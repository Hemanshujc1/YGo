import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com", name: "Asha Kulkarni", phone: "+919876543210", theme: "system",
};
const files = () => ({
  catalogCsv: new File(["productCode,name\napple,Apples\n"], "catalog.csv", { type: "text/csv" }),
  imagesZip: new File([new Uint8Array([80, 75, 3, 4])], "images.zip", { type: "application/zip" }),
});
const rowErrors = [{ rowNumber: 2, reason: "PRODUCT_DETAILS_MISMATCH", field: "categoryName" }] as const;
const preview = { rowCount: 1, productCount: 1, packCount: 1, errors: [...rowErrors] };
const imported = { productsCreated: 1, productsSkipped: 0, packsCreated: 1, packsSkipped: 0 };
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(handle: (path: string, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: { path: string; init: RequestInit }[] = [];
  const onSignedOut = vi.fn();
  const client = createAdminApiClient({
    baseUrl: "https://api.test", timeoutMs, onSignedOut,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, init });
      if (path.endsWith("/refresh") || path.endsWith("/verify")) {
        return answer(200, { accessToken: path.endsWith("/verify") ? "old" : "fresh", account });
      }
      return handle(path, init);
    },
  });
  return { client, calls, onSignedOut };
}

afterEach(() => vi.restoreAllMocks());

describe("Admin catalog import", () => {
  it("sends both original files with browser-generated multipart boundaries and validates results", async () => {
    const selected = files();
    const { client, calls } = setup((path) => answer(200, path.endsWith("/preview") ? preview : imported));
    expect(await client.previewCatalogImport(selected)).toEqual({ ok: true, data: preview });
    expect(await client.commitCatalogImport(selected)).toEqual({ ok: true, data: imported });
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/admin/auth/refresh", "/v1/admin/catalog/import/preview", "/v1/admin/catalog/import/commit",
    ]);
    for (const { init } of calls.slice(1)) {
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer fresh");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.has("content-type")).toBe(false);
      // Serialize through the platform, proving the boundary and uploaded bytes agree.
      const request = new Request("https://api.test/import", init);
      expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const body = await request.formData();
      expect([...body.keys()]).toEqual(["catalogCsv", "imagesZip"]);
      for (const field of ["catalogCsv", "imagesZip"] as const) {
        const file = body.get(field) as File;
        expect(file.name).toBe(selected[field].name);
        expect(file.type).toBe(selected[field].type);
        expect(await file.arrayBuffer()).toEqual(await selected[field].arrayBuffer());
      }
    }
  });

  it("preserves commit row errors and file-level validation fields", async () => {
    const { client } = setup((path) => path.endsWith("/commit")
      ? answer(409, { error: { code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors } })
      : answer(400, { error: { code: "VALIDATION_FAILED", fields: ["imagesZip"] } }));
    expect(await client.commitCatalogImport(files())).toMatchObject({
      ok: false, status: 409, code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors,
    });
    expect(await client.previewCatalogImport(files())).toMatchObject({
      ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["imagesZip"],
    });
  });

  it.each(["previewCatalogImport", "commitCatalogImport"] as const)("rejects malformed %s responses", async (method) => {
    const { client } = setup(() => answer(200, { ...imported, productsCreated: -1 }));
    expect(await client[method](files())).toEqual({ ok: false, status: 200, code: "INTERNAL" });
    const malformed = setup(() => answer(409, { error: {
      code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors: [{ rowNumber: 1, reason: "UNKNOWN" }],
    } }));
    expect(await malformed.client[method](files())).toEqual({ ok: false, status: 409, code: "INTERNAL" });
  });

  it.each(["previewCatalogImport", "commitCatalogImport"] as const)("replays both files once after %s receives 401", async (method) => {
    const selected = files();
    const { client, calls } = setup((_path, init) => new Headers(init.headers).get("authorization") === "Bearer old"
      ? answer(401, { error: { code: "UNAUTHENTICATED" } })
      : answer(200, method === "previewCatalogImport" ? preview : imported));
    await client.verifyCode({ email: account.email, code: "123456" });
    expect((await client[method](selected)).ok).toBe(true);
    const uploads = calls.filter(({ path }) => path.includes("/catalog/import/"));
    expect(uploads).toHaveLength(2);
    expect(calls.filter(({ path }) => path.endsWith("/refresh"))).toHaveLength(1);
    expect(uploads.map(({ init }) => new Headers(init.headers).get("authorization"))).toEqual(["Bearer old", "Bearer fresh"]);
    for (const { init } of uploads) {
      const body = await new Request("https://api.test/import", init).formData();
      for (const field of ["catalogCsv", "imagesZip"] as const) {
        expect(await (body.get(field) as File).arrayBuffer()).toEqual(await selected[field].arrayBuffer());
      }
    }
  });

  it("ends the session after a second upload 401", async () => {
    const { client, calls, onSignedOut } = setup(() => answer(401, { error: { code: "UNAUTHENTICATED" } }));
    await client.verifyCode({ email: account.email, code: "123456" });
    expect(await client.commitCatalogImport(files())).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(calls.filter(({ path }) => path.endsWith("/commit"))).toHaveLength(2);
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it.each([undefined, 1234])("limits only import requests to five minutes (normal timeout %s)", async (timeoutMs) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { client } = setup((path) => answer(200,
      path.endsWith("/preview") ? preview : path.endsWith("/commit") ? imported : account), timeoutMs);
    await client.previewCatalogImport(files());
    await client.me();
    await client.commitCatalogImport(files());
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([timeoutMs ?? 10_000, 300_000, timeoutMs ?? 10_000, 300_000]);
  });

  it.each(["previewCatalogImport", "commitCatalogImport"] as const)("does not retry %s on network or 503 failure", async (method) => {
    const unavailable = setup(() => answer(503, { error: { code: "UNAVAILABLE" } }));
    expect(await unavailable.client[method](files())).toMatchObject({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(unavailable.calls.filter(({ path }) => path.includes("/catalog/import/"))).toHaveLength(1);
    const network = setup(() => { throw new TypeError("Network request failed"); });
    await expect(network.client[method](files())).rejects.toThrow("Network request failed");
    expect(network.calls.filter(({ path }) => path.includes("/catalog/import/"))).toHaveLength(1);
  });
});
