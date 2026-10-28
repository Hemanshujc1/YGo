import { describe, expect, it, vi } from "vitest";
import type { OnboardingFee, RecordShopVisitBody, ShopOnboarding, ShopVisit } from "@ygo/contracts";
import { createAdminApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com", name: "Asha Kulkarni", phone: "+919876543210", theme: "system",
};
const id = "00000000-0000-4000-8000-000000000401";
const recordedAt = "2026-10-25T10:00:00.000Z";
const uploadBody = { contentType: "image/jpeg", byteLength: 1024 } as const;
const upload = { id, uploadUrl: "https://private.storage.test/visit-uploads/photo.jpg?signature=put" };
const access = { downloadUrl: "https://private.storage.test/visit-photos/photo.jpg?signature=get" };
const visitBody: RecordShopVisitBody = {
  photoUploadId: id, visitDate: "2026-10-25",
  checks: { pan: true, fssai: true, ownerPhone: true, ownerEmail: true, alarmPermission: true, testerOptIn: true },
  notes: "Owner present",
};
const visit: ShopVisit = {
  id, actorId: account.id, visitDate: visitBody.visitDate, recordedAt,
  checks: visitBody.checks, notes: "Owner present",
  photo: { id, latitude: 18.507, longitude: 73.807, capturedAt: "2026:10:25 15:20:00" },
};
const waived = { status: "waived", reason: "Pilot cohort" } as const;
const paid = { status: "paid", amount: "1250.50", paymentDate: "2026-10-25", reference: "UPI-123", reason: "Paid after pilot" } as const;
const fee: OnboardingFee = { ...waived, id, actorId: account.id, recordedAt };
const paidFee: OnboardingFee = { ...paid, id, actorId: account.id, recordedAt };
const onboarding: ShopOnboarding = {
  visits: [visit, { ...visit, photo: null, notes: null }], fees: [paidFee, fee],
  ownerPhoneState: "visit_confirmed", ownerEmailConfirmedAt: recordedAt,
};
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(handle: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const onSignedOut = vi.fn();
  const client = createAdminApiClient({
    baseUrl: "https://api.test", onSignedOut,
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

type Client = ReturnType<typeof createAdminApiClient>;
const operations = [
  { name: "upload issuance", call: (c: Client, shopId = id) => c.createVisitPhotoUpload(shopId, uploadBody), method: "POST", suffix: "/visit-photo-upload", body: uploadBody, response: upload, malformed: { ...upload, uploadUrl: "not-a-url" } },
  { name: "visit recording", call: (c: Client, shopId = id) => c.recordShopVisit(shopId, visitBody), method: "POST", suffix: "/visits", body: visitBody, response: visit, malformed: { ...visit, visitDate: "not-a-date" } },
  { name: "photo access", call: (c: Client, shopId = id) => c.getVisitPhotoAccess(shopId, "visit/id?#"), method: "GET", suffix: "/visits/visit%2Fid%3F%23/photo", body: undefined, response: access, malformed: { downloadUrl: "not-a-url" } },
  { name: "fee recording", call: (c: Client, shopId = id) => c.recordOnboardingFee(shopId, waived), method: "POST", suffix: "/onboarding-fees", body: waived, response: fee, malformed: { ...fee, status: "pending" } },
  { name: "onboarding history", call: (c: Client, shopId = id) => c.getShopOnboarding(shopId), method: "GET", suffix: "/onboarding", body: undefined, response: onboarding, malformed: { ...onboarding, ownerPhoneState: "confirmed" } },
];

describe("Admin visits and onboarding fees", () => {
  it.each(operations)("sends authenticated $name with encoded identifiers and parses its response", async (op) => {
    const { client, calls } = setup(() => answer(op.method === "POST" ? 201 : 200, op.response));
    expect(await op.call(client, "shop/id?#")).toEqual({ ok: true, data: op.response });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/v1/admin/auth/refresh");
    const request = calls[1];
    if (!request) throw new Error("Missing API request");
    expect(request.path).toBe(`/v1/admin/shop-applications/shop%2Fid%3F%23${op.suffix}`);
    expect(request.init.method).toBe(op.method);
    expect(request.init.body).toBe(op.body === undefined ? undefined : JSON.stringify(op.body));
    expect(request.init.credentials).toBeUndefined();
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe("Bearer fresh");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe(op.body === undefined ? null : "application/json");
    // Issuing URLs is an API call; neither signed storage destination receives the Admin token.
    expect(calls.every(({ path }) => path.startsWith("/v1/admin/"))).toBe(true);
  });

  it.each(operations)("rejects a malformed successful $name response", async (op) => {
    const { client } = setup(() => answer(200, op.malformed));
    expect(await op.call(client)).toEqual({ ok: false, status: 200, code: "INTERNAL" });
  });

  it("records a paid fee without losing amount precision or the reason", async () => {
    const { client, calls } = setup(() => answer(201, paidFee));
    expect(await client.recordOnboardingFee(id, paid)).toEqual({ ok: true, data: paidFee });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(paid);
  });

  it("accepts purged photo history and all phone confirmation states", async () => {
    for (const ownerPhoneState of ["unverified", "visit_confirmed", "sms_verified"] as const) {
      const history = { visits: [{ ...visit, photo: null, notes: null }], fees: [], ownerPhoneState, ownerEmailConfirmedAt: null };
      const { client } = setup(() => answer(200, history));
      expect(await client.getShopOnboarding(id)).toEqual({ ok: true, data: history });
    }
  });

  it.each(operations)("retries $name once after refresh with the same request", async (op) => {
    const { client, calls } = setup((_path, init) => new Headers(init.headers).get("authorization") === "Bearer old"
      ? answer(401, { error: { code: "UNAUTHENTICATED" } })
      : answer(200, op.response));
    await client.verifyCode({ email: account.email, code: "123456" });
    expect(await op.call(client)).toEqual({ ok: true, data: op.response });
    const requests = calls.filter(({ path }) => path.includes("/shop-applications/"));
    expect(requests).toHaveLength(2);
    expect(requests.map(({ init }) => new Headers(init.headers).get("authorization"))).toEqual(["Bearer old", "Bearer fresh"]);
    expect(requests[0]?.path).toBe(requests[1]?.path);
    expect(requests[0]?.init.body).toBe(requests[1]?.init.body);
    expect(calls.filter(({ path }) => path.endsWith("/refresh"))).toHaveLength(1);
  });

  it.each([
    { status: 400, code: "VALIDATION_FAILED", fields: ["photo"] },
    { status: 400, code: "VISIT_PHOTO_LOCATION_MISSING", fields: undefined },
    { status: 404, code: "NOT_FOUND", fields: undefined },
    { status: 503, code: "UNAVAILABLE", fields: undefined },
  ])("preserves $code without retrying", async ({ status, code, fields }) => {
    const { client, calls } = setup(() => answer(status, { error: { code, ...(fields && { fields }) } }));
    expect(await client.recordShopVisit(id, visitBody)).toMatchObject({ ok: false, status, code, fields });
    expect(calls.filter(({ path }) => path.endsWith("/visits"))).toHaveLength(1);
  });

  it.each(operations)("rejects network failures for $name without retrying", async (op) => {
    const { client, calls } = setup(() => { throw new TypeError("Network request failed"); });
    await expect(op.call(client)).rejects.toThrow("Network request failed");
    expect(calls.filter(({ path }) => path.includes("/shop-applications/"))).toHaveLength(1);
  });

  it.each([401, 403])("ends the session on a final %i and issues no further URLs", async (status) => {
    const { client, calls, onSignedOut } = setup(() => answer(status, { error: { code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" } }));
    await client.verifyCode({ email: account.email, code: "123456" });
    expect(await client.createVisitPhotoUpload(id, uploadBody)).toMatchObject({ ok: false, status });
    expect(onSignedOut).toHaveBeenCalledOnce();
    const count = calls.length;
    expect(await client.getVisitPhotoAccess(id, id)).toMatchObject({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls).toHaveLength(count);
    expect(calls.filter(({ path }) => path.endsWith("/visit-photo-upload"))).toHaveLength(status === 401 ? 2 : 1);
  });
});
