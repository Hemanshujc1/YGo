import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { InvalidVisitPhotoError, VisitPhotoLocationMissingError, type VisitPhotoStorage } from "../src/adapters/visit-photos";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date());
const mailer = createLocalMailer();
const photos = {
  createUpload: vi.fn(async () => { const id = randomUUID(); return { id, uploadUrl: `https://private.example/${id}?X-Amz-Signature=put` }; }),
  validate: vi.fn<VisitPhotoStorage["validate"]>(async (id) => ({ key: `visit-photos/${id}/hash.jpg`, latitude: 18.5074, longitude: 73.8077, capturedAt: "2026:10:27 10:30:00" as string | null })),
  downloadUrl: vi.fn(async (key: string) => `https://private.example/${key}?X-Amz-Signature=get`),
};
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; headers: Record<string, string> };
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const checks = { pan: true, fssai: true, ownerPhone: true, ownerEmail: true, alarmPermission: true, testerOptIn: true };
const paid = () => ({ status: "paid", amount: "1250.50", paymentDate: today(), reference: "receipt-1" });
const base = (id: string) => `/v1/admin/shop-applications/${id}`;

beforeEach(async () => {
  name = `ygo_visits_routes_${randomUUID().replaceAll("-", "")}`;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try { await root.query(`CREATE DATABASE ${name}`); } finally { await root.end(); }
  const url = new URL(rootUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  } finally { await client.end(); }
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date());
  mailer.sent.length = 0;
  vi.clearAllMocks();
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, visitPhotos: photos });
  admin = await signIn("admin@example.com");
});
afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});
async function signIn(email: string, mobile = false) {
  const path = mobile ? "/v1/auth" : "/v1/admin/auth";
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const result = (await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code } })).json();
  return { id: result.account.id as string, headers: { authorization: `Bearer ${result.accessToken as string}` } };
}
async function shop(state = "submitted") {
  const id = randomUUID();
  const ownerId = randomUUID();
  await database.pool.query("INSERT INTO accounts (id, email, name, phone) VALUES ($1, $2, 'Asha', $3)", [ownerId, `${ownerId}@example.com`, `+91${Math.floor(6_000_000_000 + Math.random() * 3_000_000_000)}`]);
  await database.pool.query(`INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name,
    entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
    VALUES ($1, $2, 'Sai General Shop', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
    'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [id, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [ownerId, id]);
  return { id, ownerId };
}
const upload = (id: string, headers = admin.headers, payload: object = { contentType: "image/jpeg", byteLength: 123 }) => app.inject({ method: "POST", url: `${base(id)}/visit-photo-upload`, headers, payload });
const visit = (id: string, photoUploadId: string, extra: object = {}, headers = admin.headers) => app.inject({ method: "POST", url: `${base(id)}/visits`, headers, payload: { photoUploadId, visitDate: today(), checks, ...extra } });
const saveFee = (id: string, payload: object = paid(), headers = admin.headers) => app.inject({ method: "POST", url: `${base(id)}/onboarding-fees`, headers, payload });
const history = (id: string, headers = admin.headers) => app.inject({ method: "GET", url: `${base(id)}/onboarding`, headers });
const photo = (id: string, visitId: string, headers = admin.headers) => app.inject({ method: "GET", url: `${base(id)}/visits/${visitId}/photo`, headers });
async function count(table: "shop_visits" | "visit_photos" | "visit_photo_uploads" | "onboarding_fees") {
  return (await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
}

describe("Admin visit and fee routes", () => {
  it("refuses every endpoint without an Admin web session before storage calls", async () => {
    const { id } = await shop();
    const mobile = await signIn("owner@example.com", true);
    const removed = admin.headers;
    await database.pool.query("DELETE FROM admin_memberships WHERE account_id = $1", [admin.id]);
    for (const [headers, status] of [[{}, 401], [mobile.headers, 403], [removed, 403]] as const) {
      const responses = await Promise.all([upload(id, headers), visit(id, randomUUID(), {}, headers), saveFee(id, paid(), headers), history(id, headers), photo(id, randomUUID(), headers)]);
      expect(responses.map((r) => r.statusCode)).toEqual(Array(5).fill(status));
    }
    expect(photos.createUpload).not.toHaveBeenCalled();
    expect(photos.validate).not.toHaveBeenCalled();
    expect(photos.downloadUrl).not.toHaveBeenCalled();
  });

  it("hides drafts and missing shops on every endpoint without storage calls", async () => {
    for (const id of [(await shop("draft")).id, randomUUID()]) {
      const responses = await Promise.all([upload(id), visit(id, randomUUID()), saveFee(id), history(id), photo(id, randomUUID())]);
      expect(responses.map((r) => r.statusCode)).toEqual(Array(5).fill(404));
    }
    expect(photos.createUpload).not.toHaveBeenCalled();
    expect(photos.validate).not.toHaveBeenCalled();
    expect(photos.downloadUrl).not.toHaveBeenCalled();
  });

  it("stores the upload's actor, shop, exact size and 15 minute expiry", async () => {
    const { id } = await shop();
    const start = clock.now();
    const result = await upload(id);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ id: expect.any(String), uploadUrl: expect.stringContaining("X-Amz-Signature=") });
    expect((await database.pool.query("SELECT * FROM visit_photo_uploads")).rows).toEqual([{
      id: result.json().id, actor_id: admin.id, shop_id: id, byte_length: 123, expires_at: new Date(start.getTime() + 900_000),
    }]);
    for (const payload of [{ contentType: "image/png", byteLength: 123 }, { contentType: "image/jpeg", byteLength: 10_000_001 }, { contentType: "image/jpeg", byteLength: 0 }]) {
      expect((await upload(id, admin.headers, payload)).statusCode).toBe(400);
    }
    expect(photos.createUpload).toHaveBeenCalledTimes(1);
  });

  it.each(["submitted", "under_review", "approved"])("records %s visits, private metadata and current contact confirmation atomically", async (state) => {
    const { id, ownerId } = await shop(state);
    const pending = (await upload(id)).json();
    const result = await visit(id, pending.id, { notes: "Shop front checked" });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ id: expect.any(String), actorId: admin.id, visitDate: today(), recordedAt: clock.now().toISOString(), checks,
      notes: "Shop front checked", photo: { id: pending.id, latitude: 18.5074, longitude: 73.8077, capturedAt: "2026:10:27 10:30:00" } });
    expect(photos.validate).toHaveBeenCalledWith(pending.id, 123);
    expect(await count("visit_photo_uploads")).toBe(0);
    const account = (await database.pool.query("SELECT phone_verified, phone_visit_confirmed_at, email_visit_confirmed_at FROM accounts WHERE id = $1", [ownerId])).rows[0];
    expect(account).toEqual({ phone_verified: false, phone_visit_confirmed_at: clock.now(), email_visit_confirmed_at: clock.now() });
    expect((await history(id)).json()).toEqual({ visits: [result.json()], fees: [], ownerPhoneState: "visit_confirmed", ownerEmailConfirmedAt: clock.now().toISOString() });
    const access = await photo(id, result.json().id);
    expect(access.statusCode).toBe(200);
    expect(access.json().downloadUrl).toContain("X-Amz-Signature=get");
    expect(photos.downloadUrl).toHaveBeenCalledWith(`visit-photos/${pending.id}/hash.jpg`);
    expect((await database.pool.query("SELECT action FROM admin_actions WHERE target_id = $1", [id])).rows).toEqual([{ action: "shop.visit" }]);
  });

  it("rejects mismatched actor/shop, missing, expired and consumed upload associations", async () => {
    const a = await shop();
    const b = await shop();
    const pending = (await upload(a.id)).json();
    expect((await visit(b.id, pending.id)).statusCode).toBe(400);
    expect((await visit(a.id, randomUUID())).statusCode).toBe(400);
    await database.pool.query("UPDATE visit_photo_uploads SET actor_id = $1", [randomUUID()]);
    expect((await visit(a.id, pending.id)).statusCode).toBe(400);
    await database.pool.query("UPDATE visit_photo_uploads SET actor_id = $1, expires_at = $2", [admin.id, clock.now()]);
    expect((await visit(a.id, pending.id)).statusCode).toBe(400);
    expect(photos.validate).not.toHaveBeenCalled();
    await database.pool.query("UPDATE visit_photo_uploads SET expires_at = $1", [new Date(clock.now().getTime() + 900_000)]);
    expect((await visit(a.id, pending.id)).statusCode).toBe(201);
    expect((await visit(a.id, pending.id)).statusCode).toBe(400);
    expect(photos.validate).toHaveBeenCalledTimes(1);
  });

  it("consumes an upload once when two requests race", async () => {
    const { id } = await shop();
    const pending = (await upload(id)).json();
    const results = await Promise.all([visit(id, pending.id), visit(id, pending.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(await count("shop_visits")).toBe(1);
    expect(photos.validate).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete checks, future/invalid dates, missing evidence and untrusted keys before reading", async () => {
    const { id } = await shop();
    const pending = (await upload(id)).json();
    for (const check of Object.keys(checks)) {
      for (const value of [false, undefined]) expect((await visit(id, pending.id, { checks: { ...checks, [check]: value } })).statusCode).toBe(400);
    }
    for (const extra of [{ visitDate: "2099-01-01" }, { visitDate: "not-a-date" }, { photoUploadId: undefined }, { key: "../other.jpg" }, { latitude: 10 }, { uploadUrl: "https://evil.example" }]) {
      expect((await visit(id, pending.id, extra)).statusCode).toBe(400);
    }
    expect(photos.validate).not.toHaveBeenCalled();
    expect(await count("shop_visits")).toBe(0);
  });

  it("maps invalid/unreadable evidence and missing GPS without consuming uploads or confirming contacts", async () => {
    const { id, ownerId } = await shop();
    const pending = (await upload(id)).json();
    for (const [error, code, status] of [
      [new InvalidVisitPhotoError("bad JPEG or declared size"), "VALIDATION_FAILED", 400],
      [Object.assign(new Error("missing"), { name: "NoSuchKey" }), "VALIDATION_FAILED", 400],
      [new VisitPhotoLocationMissingError(), "VISIT_PHOTO_LOCATION_MISSING", 400],
      [new Error("storage down"), "UNAVAILABLE", 503],
    ] as const) {
      photos.validate.mockRejectedValueOnce(error);
      const result = await visit(id, pending.id);
      expect(result.statusCode).toBe(status);
      expect(result.json().error.code).toBe(code);
    }
    expect(await count("shop_visits")).toBe(0);
    expect(await count("visit_photos")).toBe(0);
    expect(await count("visit_photo_uploads")).toBe(1);
    expect((await database.pool.query("SELECT phone_visit_confirmed_at, email_visit_confirmed_at FROM accounts WHERE id = $1", [ownerId])).rows[0])
      .toEqual({ phone_visit_confirmed_at: null, email_visit_confirmed_at: null });
  });

  it("rolls back visit, photo, confirmation and upload consumption after a later failure", async () => {
    const { id, ownerId } = await shop();
    const pending = (await upload(id)).json();
    await database.pool.query(`CREATE FUNCTION fail_visit_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'shop.visit' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_visit_action BEFORE INSERT ON admin_actions FOR EACH ROW EXECUTE FUNCTION fail_visit_action()`);
    expect((await visit(id, pending.id)).statusCode).toBe(500);
    expect(await count("shop_visits")).toBe(0);
    expect(await count("visit_photos")).toBe(0);
    expect(await count("visit_photo_uploads")).toBe(1);
    expect((await database.pool.query("SELECT phone_visit_confirmed_at FROM accounts WHERE id = $1", [ownerId])).rows[0].phone_visit_confirmed_at).toBeNull();
  });

  it("appends repeat visits newest first, preserves SMS verification and clears confirmation when contacts change", async () => {
    const { id, ownerId } = await shop();
    await database.pool.query("UPDATE accounts SET phone_verified = true WHERE id = $1", [ownerId]);
    const first = (await visit(id, (await upload(id)).json().id)).json();
    clock.advance(1_000);
    photos.validate.mockResolvedValueOnce({ key: `visit-photos/${randomUUID()}/hash.jpg`, latitude: 0, longitude: 0, capturedAt: null });
    const second = (await visit(id, (await upload(id)).json().id, { visitDate: "2020-01-01" })).json();
    expect((await history(id)).json()).toMatchObject({ visits: [second, first], ownerPhoneState: "sms_verified" });
    await database.pool.query("UPDATE accounts SET phone = '+919000000001', email = 'new@example.com' WHERE id = $1", [ownerId]);
    expect((await history(id)).json()).toMatchObject({ ownerEmailConfirmedAt: null });
    expect((await database.pool.query("SELECT phone_visit_confirmed_at FROM accounts WHERE id = $1", [ownerId])).rows[0].phone_visit_confirmed_at).toBeNull();
  });

  it("does not sign access for another shop, a missing visit or purged evidence", async () => {
    const { id } = await shop();
    const other = await shop();
    const saved = (await visit(id, (await upload(id)).json().id)).json();
    expect((await photo(other.id, saved.id)).statusCode).toBe(404);
    expect((await photo(id, randomUUID())).statusCode).toBe(404);
    await database.pool.query("DELETE FROM visit_photos WHERE visit_id = $1", [saved.id]);
    expect((await photo(id, saved.id)).statusCode).toBe(404);
    expect(photos.downloadUrl).not.toHaveBeenCalled();
    expect((await history(id)).json().visits).toEqual([{ ...saved, photo: null }]);
  });

  it("records paid and waived fees as reasoned history without requiring a visit", async () => {
    const { id } = await shop();
    expect((await history(id)).json()).toEqual({ visits: [], fees: [], ownerPhoneState: "unverified", ownerEmailConfirmedAt: null });
    const first = await saveFee(id);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ ...paid(), id: expect.any(String), actorId: admin.id, recordedAt: clock.now().toISOString(), reason: null });
    clock.advance(1_000);
    expect((await saveFee(id)).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
    const waived = await saveFee(id, { status: "waived", reason: "Pilot cohort" });
    expect(waived.statusCode).toBe(201);
    clock.advance(1_000);
    const correction = await saveFee(id, { ...paid(), reason: "Payment received later" });
    expect(correction.statusCode).toBe(201);
    expect((await history(id)).json().fees).toEqual([correction.json(), waived.json(), first.json()]);
    expect(await count("shop_visits")).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions WHERE action = 'shop.onboarding_fee'")).rows[0].n).toBe(3);
  });

  it("validates fee fields and serializes simultaneous first payments", async () => {
    const { id } = await shop();
    for (const payload of [{ status: "waived" }, { status: "waived", reason: " " }, { ...paid(), amount: "0" }, { ...paid(), amount: "-1" },
      { ...paid(), paymentDate: "2099-01-01" }, { ...paid(), reference: "" }]) expect((await saveFee(id, payload)).statusCode).toBe(400);
    const results = await Promise.all([saveFee(id), saveFee(id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(await count("onboarding_fees")).toBe(1);
  });

  it("rejects an Owner without a phone and an upload expiring during validation", async () => {
    const { id, ownerId } = await shop();
    const pending = (await upload(id)).json();
    await database.pool.query("UPDATE accounts SET phone = NULL WHERE id = $1", [ownerId]);
    expect((await visit(id, pending.id)).statusCode).toBe(400);
    expect(photos.validate).not.toHaveBeenCalled();
    await database.pool.query("UPDATE accounts SET phone = '+919000000001' WHERE id = $1", [ownerId]);
    photos.validate.mockImplementationOnce(async () => {
      clock.advance(900_000);
      return { key: "visit-photos/frozen.jpg", latitude: 18, longitude: 73, capturedAt: null };
    });
    expect((await visit(id, pending.id)).statusCode).toBe(400);
    expect(await count("shop_visits")).toBe(0);
    expect(await count("visit_photo_uploads")).toBe(1);
  });

  it("lets a concurrent contact change clear the confirmation after the visit commits", async () => {
    const { id, ownerId } = await shop();
    const pending = (await upload(id)).json();
    let started!: () => void;
    let finish!: () => void;
    const validating = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    photos.validate.mockImplementationOnce(async () => {
      started(); await release;
      return { key: "visit-photos/frozen.jpg", latitude: 18, longitude: 73, capturedAt: null };
    });
    const saving = visit(id, pending.id).then((r) => r);
    await validating;
    const changing = database.pool.query("UPDATE accounts SET phone = $1 WHERE id = $2", ["+919000000001", ownerId]);
    try {
      await expect.poll(async () => (await database.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query = 'UPDATE accounts SET phone = $1 WHERE id = $2'`)).rows[0].n).toBe(1);
    } finally { finish(); }
    expect((await saving).statusCode).toBe(201);
    await changing;
    expect((await history(id)).json()).toMatchObject({ ownerPhoneState: "unverified", ownerEmailConfirmedAt: clock.now().toISOString() });
  });

  it("holds current Admin membership while issuing an upload URL", async () => {
    const { id } = await shop();
    let started!: () => void;
    let finish!: () => void;
    const signing = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    photos.createUpload.mockImplementationOnce(async () => {
      started(); await release;
      return { id: randomUUID(), uploadUrl: "https://private.example/upload?X-Amz-Signature=put" };
    });
    const issuing = upload(id).then((r) => r);
    await signing;
    const revoking = database.pool.query("DELETE FROM admin_memberships WHERE account_id = $1", [admin.id]);
    try {
      await expect.poll(async () => (await database.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query = 'DELETE FROM admin_memberships WHERE account_id = $1'`)).rows[0].n).toBe(1);
    } finally { finish(); }
    expect((await issuing).statusCode).toBe(201);
    await revoking;
    expect((await upload(id)).statusCode).toBe(403);
    expect(photos.createUpload).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for absent storage, storage signing failures and access signing failures", async () => {
    const { id } = await shop();
    photos.createUpload.mockRejectedValueOnce(new Error("offline"));
    expect((await upload(id)).statusCode).toBe(503);
    expect(await count("visit_photo_uploads")).toBe(0);
    const pending = (await upload(id)).json();
    const saved = (await visit(id, pending.id)).json();
    photos.downloadUrl.mockRejectedValueOnce(new Error("offline"));
    expect((await photo(id, saved.id)).statusCode).toBe(503);
    await app.close();
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    expect((await upload(id)).statusCode).toBe(503);
    const waitingId = randomUUID();
    await database.pool.query("INSERT INTO visit_photo_uploads (id, shop_id, actor_id, byte_length, expires_at) VALUES ($1, $2, $3, 123, $4)",
      [waitingId, id, admin.id, new Date(clock.now().getTime() + 900_000)]);
    expect((await visit(id, waitingId)).statusCode).toBe(503);
    expect((await photo(id, saved.id)).statusCode).toBe(503);
    // Existing history and fee writes do not depend on the photo service.
    expect((await history(id)).statusCode).toBe(200);
    expect((await saveFee(id, { status: "waived", reason: "Pilot" })).statusCode).toBe(201);
  });
});
