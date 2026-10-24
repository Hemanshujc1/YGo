import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { createProductImageStorage, type ProductImagePutClient } from "../src/adapters/product-images";
import { accessToken, deriveKeys } from "../src/tokens";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "initial-admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let productImagePuts: Parameters<ProductImagePutClient["putObject"]>[0][];
let failProductImagePuts: boolean;

beforeEach(async () => {
  name = `ygo_admin_routes_${randomUUID().replaceAll("-", "")}`;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try { await root.query(`CREATE DATABASE ${name}`); } finally { await root.end(); }
  const url = new URL(rootUrl);
  url.pathname = `/${name}`;
  const migrationClient = new pg.Client({ connectionString: url.href });
  try {
    await migrationClient.connect();
    await migrate(drizzle({ client: migrationClient }), {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  } finally { await migrationClient.end(); }
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, admin);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  productImagePuts = [];
  failProductImagePuts = false;
  const productImages = createProductImageStorage({
    client: {
      async putObject(input) {
        productImagePuts.push(input);
        if (failProductImagePuts) throw new Error("S3 unavailable");
      },
    },
    bucket: "test-product-images",
    imageBaseUrl: "https://images.ygo.example",
  });
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, productImages });
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try {
    await root.connect();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally { await root.end(); }
});

function codeFor(email: string) {
  const mail = mailer.sent.findLast((sent) => sent.to === email);
  return mail?.text.match(/code is (\d{6})/)?.[1] ?? "";
}

async function signIn(url: "/v1/auth" | "/v1/admin/auth", email = admin.email) {
  const code = await app.inject({ method: "POST", url: `${url}/code`, payload: { email } });
  expect(code.statusCode).toBe(204);
  const verify = await app.inject({ method: "POST", url: `${url}/verify`, payload: { email, code: codeFor(email) } });
  expect(verify.statusCode).toBe(200);
  return verify;
}

function cookie(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["set-cookie"]).split(";")[0] ?? "";
}

function adminRefresh(cookieHeader: string, header = "1") {
  return app.inject({ method: "POST", url: "/v1/admin/auth/refresh", headers: { cookie: cookieHeader, "x-ygo-admin-refresh": header } });
}

function accounts(token?: string) {
  return app.inject({ method: "GET", url: "/v1/admin/accounts", headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe("Admin routes and browser sessions", () => {
  it("seeds global categories and requires an Admin web session", async () => {
    const get = (token?: string) => app.inject({ method: "GET", url: "/v1/admin/categories", headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get()).statusCode).toBe(401);
    const mobile = (await signIn("/v1/auth")).json().accessToken as string;
    expect((await get(mobile)).statusCode).toBe(403);
    clock.advance(30_000);
    const token = (await signIn("/v1/admin/auth")).json().accessToken as string;
    expect((await get(token)).json().categories.map((row: { name: string }) => row.name)).toEqual([
      "Fruits and Vegetables", "Groceries", "Stationery",
    ]);
  });

  it("requires an Admin web session to create or edit categories", async () => {
    const id = (await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Groceries'")).rows[0]?.id;
    if (!id) throw new Error("Seeded category missing");
    const requests = [
      { method: "POST" as const, url: "/v1/admin/categories", payload: { name: "Snacks" } },
      { method: "PATCH" as const, url: `/v1/admin/categories/${id}`, payload: { name: "Food" } },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
    const mobile = (await signIn("/v1/auth")).json().accessToken as string;
    for (const request of requests) {
      expect((await app.inject({ ...request, headers: { authorization: `Bearer ${mobile}` } })).statusCode).toBe(403);
    }
  });

  it("creates, moves, deactivates and reactivates categories with atomic action records", async () => {
    const token = (await signIn("/v1/admin/auth")).json().accessToken as string;
    const headers = { authorization: `Bearer ${token}` };
    const create = (payload: object) => app.inject({ method: "POST", url: "/v1/admin/categories", headers, payload });
    const edit = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/v1/admin/categories/${id}`, headers, payload });
    const roots = (await app.inject({ method: "GET", url: "/v1/admin/categories", headers })).json().categories;
    const groceries = roots.find((row: { name: string }) => row.name === "Groceries").id as string;
    const stationery = roots.find((row: { name: string }) => row.name === "Stationery").id as string;
    const made = await create({ name: "  Snacks  ", parentId: groceries });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: "Snacks", parentId: groceries, active: true, effectiveActive: true });
    const id = made.json().id as string;
    expect((await create({ name: "snacks", parentId: groceries })).json()).toEqual({ error: { code: "CATEGORY_NAME_IN_USE" } });
    expect((await create({ name: "Snacks", parentId: stationery })).statusCode).toBe(201);
    expect((await create({ name: "Grandchild", parentId: id })).statusCode).toBe(400);
    expect((await edit(groceries, { parentId: id })).statusCode).toBe(400);
    expect((await edit(id, { parentId: stationery })).statusCode).toBe(409);
    expect((await edit(id, { name: "Bites", parentId: stationery })).json()).toMatchObject({ name: "Bites", parentId: stationery });
    expect((await edit(stationery, { active: false })).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
    expect((await edit(stationery, { active: false, reason: "No longer in use" })).statusCode).toBe(200);
    expect((await edit(stationery, { active: false, name: "Paper goods" })).statusCode).toBe(200);
    const listed = (await app.inject({ method: "GET", url: "/v1/admin/categories", headers })).json().categories;
    expect(listed.find((row: { id: string }) => row.id === id)).toMatchObject({ active: true, effectiveActive: false });
    expect((await edit(stationery, { active: true })).statusCode).toBe(200);
    const restored = (await app.inject({ method: "GET", url: "/v1/admin/categories", headers })).json().categories;
    expect(restored.find((row: { id: string }) => row.id === id).effectiveActive).toBe(true);
    const audit = await database.pool.query("SELECT action, target_type, target_id, reason FROM admin_actions WHERE target_type = 'category' ORDER BY created_at");
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "category.create", "category.create", "category.rename", "category.rename", "category.move", "category.deactivate", "category.reactivate",
    ].sort());
    expect(audit.rows.find((row) => row.action === "category.deactivate")?.reason).toBe("No longer in use");
    expect(audit.rows.every((row) => row.target_type === "category")).toBe(true);
  });

  it("lists and creates only for Admin web sessions, with an atomic action", async () => {
    const signed = await signIn("/v1/admin/auth");
    const token = signed.json().accessToken as string;
    expect((await accounts()).statusCode).toBe(401);
    expect((await accounts(token)).json().accounts).toHaveLength(1);
    const payload = { email: "second-admin@example.com", name: "Meera Shah", phone: "+919876543211", reason: "Coverage for the evening shift" };
    const created = await app.inject({ method: "POST", url: "/v1/admin/accounts", headers: { authorization: `Bearer ${token}` }, payload });
    expect(created.statusCode).toBe(201);
    const account = created.json();
    expect(account).toMatchObject({ email: payload.email, name: payload.name, phone: payload.phone });
    expect((await accounts(token)).json().accounts).toHaveLength(2);
    const rows = await database.pool.query(
      `SELECT a.role, m.account_id, x.actor_id, x.action, x.reason, x.target_id
       FROM accounts a JOIN admin_memberships m ON m.account_id = a.id
       JOIN admin_actions x ON x.target_id = a.id WHERE a.id = $1`,
      [account.id],
    );
    expect(rows.rows[0]).toMatchObject({ role: "customer", account_id: account.id, action: "admin.create", reason: payload.reason, target_id: account.id });
    expect(rows.rows[0].actor_id).not.toBe(account.id);
  });

  it("refuses both conflicts and rolls back when writing the action fails", async () => {
    const token = (await signIn("/v1/admin/auth")).json().accessToken as string;
    const create = (payload: object) => app.inject({ method: "POST", url: "/v1/admin/accounts", headers: { authorization: `Bearer ${token}` }, payload });
    const base = { email: "new-admin@example.com", name: "Meera Shah", phone: "+919876543211", reason: "Evening coverage" };
    expect((await create({ ...base, email: admin.email })).json()).toEqual({ error: { code: "EMAIL_IN_USE" } });
    expect((await create({ ...base, phone: admin.phone })).json()).toEqual({ error: { code: "PHONE_IN_USE" } });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions")).rows[0].n).toBe(1);
    await database.pool.query(`CREATE FUNCTION fail_admin_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'admin.create' THEN RAISE EXCEPTION 'test action failure'; END IF; RETURN NEW; END; $$`);
    await database.pool.query("CREATE TRIGGER test_fail_action BEFORE INSERT ON admin_actions FOR EACH ROW EXECUTE FUNCTION fail_admin_create()");
    expect((await create(base)).statusCode).toBe(500);
    expect((await database.pool.query("SELECT 1 FROM accounts WHERE email = $1", [base.email])).rowCount).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions")).rows[0].n).toBe(1);
  });

  it("hides membership on code request, rotates the cookie, enforces idle expiry and signs out", async () => {
    const unknown = await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: "unknown@example.com" } });
    expect(unknown.statusCode).toBe(204);
    await database.pool.query("INSERT INTO accounts (email) VALUES ('known-non-admin@example.com')");
    const nonAdmin = await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: "known-non-admin@example.com" } });
    expect(mailer.sent).toHaveLength(0);
    const adminCode = await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: admin.email } });
    expect({ status: nonAdmin.statusCode, body: nonAdmin.body }).toEqual({ status: adminCode.statusCode, body: adminCode.body });
    expect(mailer.sent).toHaveLength(1);
    const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: admin.email, code: codeFor(admin.email) } });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).not.toHaveProperty("refreshToken");
    const first = cookie(signed);
    expect(String(signed.headers["set-cookie"])).toContain("HttpOnly; Secure; SameSite=Strict; Path=/v1/admin/auth");
    expect((await adminRefresh(first, "")).statusCode).toBe(403);
    const refreshed = await adminRefresh(first);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).not.toHaveProperty("refreshToken");
    const second = cookie(refreshed);
    expect(second).not.toBe(first);
    expect((await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: second.split("=")[1] } })).statusCode).toBe(403);
    const out = await app.inject({ method: "POST", url: "/v1/admin/auth/sign-out", headers: { cookie: second, "x-ygo-admin-refresh": "1" } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await adminRefresh(second)).statusCode).toBe(401);
    clock.advance(30_000);
    const next = await signIn("/v1/admin/auth");
    clock.advance(30 * 60_000 + 1);
    expect((await adminRefresh(cookie(next))).statusCode).toBe(401);
  });

  it("uses the existing wrong-code lock and hourly code-request limit", async () => {
    const requestCode = () => app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: admin.email } });
    const verify = (code: string) => app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: admin.email, code } });
    expect((await requestCode()).statusCode).toBe(204);
    const wrong = codeFor(admin.email) === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await verify(wrong)).statusCode).toBe(attempt === 5 ? 429 : 400);
    }
    expect((await requestCode()).json()).toEqual({ error: { code: "CODE_LOCKED" } });
    clock.advance(15 * 60_000);
    for (let request = 2; request <= 5; request++) {
      expect((await requestCode()).statusCode).toBe(204);
      clock.advance(30_000);
    }
    expect((await requestCode()).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
  });

  it("keeps mobile and Admin sessions separate and denies revoked membership immediately", async () => {
    const mobile = await signIn("/v1/auth");
    const mobileBody = mobile.json();
    expect((await accounts(mobileBody.accessToken)).statusCode).toBe(403);
    const refused = await app.inject({
      method: "POST", url: "/v1/admin/accounts", headers: { authorization: `Bearer ${mobileBody.accessToken}` },
      payload: { email: "refused@example.com", name: "Meera Shah", phone: "+919876543211", reason: "No permission" },
    });
    expect(refused.statusCode).toBe(403);
    expect((await database.pool.query("SELECT 1 FROM accounts WHERE email = 'refused@example.com'")).rowCount).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions")).rows[0].n).toBe(1);
    expect((await adminRefresh(`__Secure-ygo-admin-refresh=${mobileBody.refreshToken}`)).statusCode).toBe(403);
    clock.advance(30_000);
    const web = await signIn("/v1/admin/auth");
    const webToken = web.json().accessToken as string;
    const webCookie = cookie(web);
    expect((await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: webCookie.split("=")[1] } })).statusCode).toBe(403);
    await database.pool.query("DELETE FROM admin_memberships WHERE account_id = (SELECT id FROM accounts WHERE email = $1)", [admin.email]);
    expect((await accounts(webToken)).statusCode).toBe(403);
    expect((await adminRefresh(webCookie)).statusCode).toBe(403);
    const nonAdmin = await database.pool.query<{ id: string }>("INSERT INTO accounts (email) VALUES ('other@example.com') RETURNING id");
    const id = nonAdmin.rows[0]?.id;
    if (!id) throw new Error("Missing account");
    const sessionId = randomUUID();
    await database.pool.query("INSERT INTO sessions (id, account_id, kind, expires_at) VALUES ($1, $2, 'admin_web', $3)", [sessionId, id, new Date("2030-02-01")]);
    expect((await accounts(accessToken(deriveKeys(secret), id, sessionId, clock.now()))).statusCode).toBe(403);
  });
});

describe("Areas, serviceability and the waitlist", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  async function adminHeaders() {
    return bearer((await signIn("/v1/admin/auth")).json().accessToken as string);
  }
  function areaActions() {
    return database.pool.query<{ action: string; target_id: string; reason: string }>(
      "SELECT action, target_id, reason FROM admin_actions WHERE target_type = 'area' ORDER BY created_at, action",
    );
  }

  it("refuses signed-out callers and non-Admins", async () => {
    const id = randomUUID();
    const admin = [
      { method: "GET" as const, url: "/v1/admin/waitlist" },
      { method: "GET" as const, url: "/v1/admin/areas" },
      { method: "POST" as const, url: "/v1/admin/areas", payload: { name: "Kothrud", pincodes: ["411038"], reason: "Launch" } },
      { method: "PATCH" as const, url: `/v1/admin/areas/${id}`, payload: { paused: true, reason: "Rain" } },
    ];
    const customer = [
      { method: "GET" as const, url: "/v1/serviceability?pincode=411038" },
      { method: "POST" as const, url: "/v1/waitlist", payload: { pincode: "411038", phone: "+919876543212" } },
    ];
    for (const request of [...admin, ...customer]) expect((await app.inject(request)).statusCode).toBe(401);
    const mobile = (await signIn("/v1/auth")).json().accessToken as string;
    for (const request of admin) expect((await app.inject({ ...request, headers: bearer(mobile) })).statusCode).toBe(403);
    expect((await database.pool.query("SELECT 1 FROM areas")).rowCount).toBe(0);
    expect((await areaActions()).rowCount).toBe(0);
  });

  it("creates and edits Areas, refuses clashes and records each change once with its reason", async () => {
    const headers = await adminHeaders();
    const create = (payload: object) => app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload });
    const edit = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/v1/admin/areas/${id}`, headers, payload });

    const kothrud = await create({ name: "  Kothrud ", pincodes: ["411038", "411029"], reason: "Launch area" });
    expect(kothrud.statusCode).toBe(201);
    expect(kothrud.json()).toMatchObject({ name: "Kothrud", pincodes: ["411029", "411038"], paused: false });
    const kothrudId = kothrud.json().id as string;
    expect((await create({ name: "KOTHRUD", pincodes: ["411001"], reason: "Again" })).json()).toEqual({ error: { code: "AREA_NAME_IN_USE" } });
    expect((await create({ name: "Baner", pincodes: ["411045", "411038", "411029"], reason: "Next" })).json()).toEqual({
      error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411029", areaName: "Kothrud" }, { pincode: "411038", areaName: "Kothrud" }] },
    });
    expect((await database.pool.query("SELECT 1 FROM areas WHERE name = 'Baner'")).rowCount).toBe(0);
    const baner = await create({ name: "Baner", pincodes: ["411045"], reason: "Second area" });
    expect(baner.statusCode).toBe(201);
    const banerId = baner.json().id as string;

    expect((await edit(banerId, { pincodes: ["411045", "411038"], reason: "Grow" })).json()).toEqual({
      error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411038", areaName: "Kothrud" }] },
    });
    expect((await edit(kothrudId, { pincodes: ["411052", "411038"], reason: "Hand 411029 to Baner" })).json())
      .toMatchObject({ pincodes: ["411038", "411052"] });
    expect((await edit(banerId, { pincodes: ["411029", "411045"], reason: "Take 411029" })).json())
      .toMatchObject({ pincodes: ["411029", "411045"] });
    expect((await edit(kothrudId, { pincodes: ["411038", "411052"], reason: "No change" })).json())
      .toMatchObject({ pincodes: ["411038", "411052"] });
    expect((await edit(kothrudId, { paused: true, reason: "Heavy rain" })).json()).toMatchObject({ paused: true });
    expect((await edit(kothrudId, { paused: true, reason: "Still raining" })).json()).toMatchObject({ paused: true });
    expect((await edit(kothrudId, { paused: false, reason: "Rain stopped" })).json()).toMatchObject({ paused: false });
    expect((await edit(randomUUID(), { paused: true, reason: "Missing" })).statusCode).toBe(404);

    const listed = await app.inject({ method: "GET", url: "/v1/admin/areas", headers });
    expect(listed.json().areas.map((row: { name: string; pincodes: string[] }) => [row.name, row.pincodes])).toEqual([
      ["Baner", ["411029", "411045"]], ["Kothrud", ["411038", "411052"]],
    ]);
    expect((await areaActions()).rows.map((row) => [row.action, row.target_id, row.reason])).toEqual([
      ["area.create", kothrudId, "Launch area"],
      ["area.create", banerId, "Second area"],
      ["area.edit_pincodes", kothrudId, "Hand 411029 to Baner"],
      ["area.edit_pincodes", banerId, "Take 411029"],
      ["area.pause", kothrudId, "Heavy rain"],
      ["area.resume", kothrudId, "Rain stopped"],
    ]);
  });

  it("keeps a pincode in one Area when two Admins save at once, without deadlocks", async () => {
    const headers = await adminHeaders();
    const create = (name: string) => app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload: { name, pincodes: ["411038"], reason: "Launch" } });
    const results = await Promise.all([create("Kothrud"), create("Karve Nagar")]);
    const won = results.find((result) => result.statusCode === 201);
    const lost = results.find((result) => result.statusCode === 409);
    expect(lost?.json()).toEqual({ error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411038", areaName: won?.json().name }] } });
    expect((await areaActions()).rowCount).toBe(1);

    // Two Areas swapping pincodes at once: each is refused, naming the other, and neither deadlocks.
    const baner = (await app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload: { name: "Baner", pincodes: ["411045"], reason: "Launch" } })).json();
    await database.pool.query("CREATE FUNCTION slow_pincode() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$");
    await database.pool.query("CREATE TRIGGER test_slow_pincode BEFORE INSERT ON area_pincodes FOR EACH ROW EXECUTE FUNCTION slow_pincode()");
    const swap = (id: string, pincode: string) => app.inject({ method: "PATCH", url: `/v1/admin/areas/${id}`, headers, payload: { pincodes: [pincode], reason: "Swap" } });
    const swapped = await Promise.all([swap(won?.json().id as string, "411045"), swap(baner.id as string, "411038")]);
    expect(swapped.map((result) => result.json())).toEqual([
      { error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411045", areaName: "Baner" }] } },
      { error: { code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411038", areaName: won?.json().name }] } },
    ]);
  });

  it("answers serviceable only for a pincode in an active Area", async () => {
    const headers = await adminHeaders();
    clock.advance(30_000);
    const customer = bearer((await signIn("/v1/auth", "customer@example.com")).json().accessToken as string);
    const check = async (pincode: string) => (await app.inject({ method: "GET", url: `/v1/serviceability?pincode=${pincode}`, headers: customer })).json();
    const id = (await app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload: { name: "Kothrud", pincodes: ["411038"], reason: "Launch" } })).json().id as string;
    const pause = (paused: boolean) => app.inject({ method: "PATCH", url: `/v1/admin/areas/${id}`, headers, payload: { paused, reason: "Weather" } });

    expect(await check("411038")).toEqual({ serviceable: true, areaName: "Kothrud" });
    expect(await check("400001")).toEqual({ serviceable: false });
    expect(await check("12")).toEqual({ error: { code: "VALIDATION_FAILED" } });
    expect((await pause(true)).statusCode).toBe(200);
    expect(await check("411038")).toEqual({ serviceable: false });
    const taken = await app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload: { name: "Baner", pincodes: ["411038"], reason: "Take it" } });
    expect(taken.json().error.code).toBe("PINCODE_IN_OTHER_AREA");
    expect((await pause(false)).statusCode).toBe(200);
    expect(await check("411038")).toEqual({ serviceable: true, areaName: "Kothrud" });
  });

  it("saves Leave my number, replaces the phone on a repeat and goes with the account", async () => {
    const signed = (await signIn("/v1/auth", "customer@example.com")).json();
    const leave = (phone: string) => app.inject({ method: "POST", url: "/v1/waitlist", headers: bearer(signed.accessToken as string), payload: { pincode: "400 001", phone } });
    const rows = () => database.pool.query("SELECT pincode, phone, saved_at FROM waitlist_entries WHERE account_id = $1", [signed.account.id]);

    expect((await leave("+919876543212")).statusCode).toBe(204);
    expect((await rows()).rows).toEqual([{ pincode: "400001", phone: "+919876543212", saved_at: new Date("2030-01-01T00:00:00.000Z") }]);
    clock.advance(60_000);
    expect((await leave("+919876543213")).statusCode).toBe(204);
    expect((await rows()).rows).toEqual([{ pincode: "400001", phone: "+919876543213", saved_at: new Date("2030-01-01T00:01:00.000Z") }]);
    expect((await leave("12")).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["phone"] } });
    await database.pool.query("DELETE FROM accounts WHERE id = $1", [signed.account.id]);
    expect((await rows()).rowCount).toBe(0);
  });

  it("lists all captures newest first, with stable ties, current account details and no read audit", async () => {
    const headers = await adminHeaders();
    const list = () => app.inject({ method: "GET", url: "/v1/admin/waitlist", headers });
    expect((await list()).json()).toEqual({ entries: [] });
    const mobile = (await signIn("/v1/auth", "customer@example.com")).json();
    const leave = (phone: string) => app.inject({ method: "POST", url: "/v1/waitlist", headers: bearer(mobile.accessToken), payload: { pincode: "411038", phone } });
    expect((await leave("+919876543212")).statusCode).toBe(204);
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    await database.pool.query("INSERT INTO accounts (id, email, name) VALUES ($1, 'first@example.com', 'First'), ($2, 'second@example.com', NULL)", [first, second]);
    await database.pool.query(
      `INSERT INTO waitlist_entries (account_id, pincode, phone, saved_at) VALUES
       ($1, '400001', '+919876543214', $3), ($2, '400001', '+919876543215', $3), ($1, '400002', '+919876543216', $3)`,
      [first, second, clock.now()],
    );
    clock.advance(60_000);
    expect((await leave("+919876543213")).statusCode).toBe(204);
    const area = await app.inject({ method: "POST", url: "/v1/admin/areas", headers, payload: { name: "Kothrud", pincodes: ["411038"], reason: "Expansion" } });
    expect(area.statusCode).toBe(201);
    const actions = (await database.pool.query("SELECT * FROM admin_actions")).rows;
    const listed = await list();
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ entries: [
      { accountId: mobile.account.id, accountName: null, accountEmail: "customer@example.com", phone: "+919876543213", pincode: "411038", savedAt: "2030-01-01T00:01:00.000Z" },
      { accountId: first, accountName: "First", accountEmail: "first@example.com", phone: "+919876543214", pincode: "400001", savedAt: "2030-01-01T00:00:00.000Z" },
      { accountId: second, accountName: null, accountEmail: "second@example.com", phone: "+919876543215", pincode: "400001", savedAt: "2030-01-01T00:00:00.000Z" },
      { accountId: first, accountName: "First", accountEmail: "first@example.com", phone: "+919876543216", pincode: "400002", savedAt: "2030-01-01T00:00:00.000Z" },
    ] });
    expect((await database.pool.query("SELECT * FROM admin_actions")).rows).toEqual(actions);
    await database.pool.query("DELETE FROM admin_memberships");
    expect((await list()).statusCode).toBe(403);
  });
});

describe("Catalog pack routes (#205)", () => {
  async function product(baseUnit = "each") {
    const made = await database.pool.query<{ id: string }>(
      `INSERT INTO master_products (name, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
       SELECT $1, id, $2, $3, 'small', 'medium', 'large', true FROM categories WHERE name = 'Groceries' RETURNING id`,
      [randomUUID(), baseUnit, baseUnit === "each" ? "counted" : "measured"],
    );
    const id = made.rows[0]?.id;
    if (!id) throw new Error("Test product missing");
    return id;
  }
  async function headers() {
    return { authorization: `Bearer ${(await signIn("/v1/admin/auth")).json().accessToken as string}` };
  }
  const path = (id: string) => `/v1/admin/products/${id}/packs`;
  function create(id: string, token: Record<string, string>, payload: object) {
    return app.inject({ method: "POST", url: path(id), headers: token, payload });
  }
  function edit(productId: string, id: string, token: Record<string, string>, payload: object) {
    return app.inject({ method: "PATCH", url: `${path(productId)}/${id}`, headers: token, payload });
  }

  it("requires a live Admin web session and current membership on every route", async () => {
    const id = await product();
    const requests = [
      { method: "GET" as const, url: path(id) },
      { method: "POST" as const, url: path(id), payload: { quantity: "1" } },
      { method: "PATCH" as const, url: `${path(id)}/${randomUUID()}`, payload: { quantity: "2" } },
    ];
    const check = async (token: Record<string, string>, status: number) => {
      for (const request of requests) expect((await app.inject({ ...request, headers: token })).statusCode).toBe(status);
    };
    await check({}, 401);
    await check({ authorization: `Bearer ${(await signIn("/v1/auth")).json().accessToken as string}` }, 403);
    clock.advance(30_000);
    const token = await headers();
    await database.pool.query("DELETE FROM admin_memberships");
    await check(token, 403);
    await database.pool.query("DELETE FROM sessions");
    await check(token, 401);
    expect((await database.pool.query("SELECT * FROM packs")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM admin_actions WHERE target_type = 'pack'")).rows).toEqual([]);
  });

  it("creates, lists, edits, deactivates and reactivates packs on inactive drafts with audit records", async () => {
    const id = await product();
    const token = await headers();
    await database.pool.query("UPDATE master_products SET active = false, published = false WHERE id = $1", [id]);
    const made = await create(id, token, { quantity: "12", barcode: "012345678901" });
    expect(made.statusCode).toBe(201);
    const pack = made.json().id as string;
    expect(made.json()).toEqual({ id: pack, productId: id, quantity: "12.000", barcode: "012345678901", active: true });
    expect((await create(id, token, { quantity: "1" })).json()).toMatchObject({ barcode: null });
    expect((await create(id, token, { quantity: "2" })).statusCode).toBe(201);
    expect((await edit(id, pack, token, { quantity: "24", barcode: "0012345678901" })).json()).toMatchObject({ quantity: "24.000", barcode: "0012345678901" });
    expect((await edit(id, pack, token, { active: false })).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
    expect((await edit(id, pack, token, { active: false, reason: " Retired size " })).json()).toMatchObject({ active: false });
    const list = await app.inject({ method: "GET", url: path(id), headers: token });
    expect(list.statusCode).toBe(200);
    expect(list.json().packs.map((row: { quantity: string }) => row.quantity)).toEqual(["1.000", "2.000", "24.000"]);
    expect(list.json().packs[2]).toMatchObject({ id: pack, active: false });
    expect((await edit(id, pack, token, { active: true })).json()).toMatchObject({ active: true });
    expect((await edit(id, pack, token, { barcode: null })).json()).toMatchObject({ barcode: null });
    expect((await edit(id, pack, token, { quantity: "24.0", active: true })).statusCode).toBe(200);
    const audit = await database.pool.query("SELECT action, reason, target_type, actor_id FROM admin_actions WHERE target_id = $1", [pack]);
    expect(audit.rows.map((row) => `${row.action}|${row.reason}|${row.target_type}`).sort()).toEqual([
      "pack.create|Pack created|pack", "pack.deactivate|Retired size|pack", "pack.edit|Pack edited|pack",
      "pack.edit|Pack edited|pack", "pack.reactivate|Pack reactivated|pack",
    ]);
    const actor = (await database.pool.query("SELECT id FROM accounts WHERE email = $1", [admin.email])).rows[0].id;
    expect(audit.rows.every((row) => row.actor_id === actor)).toBe(true);
  });

  it("reserves inactive barcodes globally and quantities per product in the API and database", async () => {
    const id = await product();
    const other = await product();
    const token = await headers();
    const pack = (await create(id, token, { quantity: "1", barcode: "01234567" })).json().id as string;
    await edit(id, pack, token, { active: false, reason: "Discontinued" });
    const duplicate = await create(other, token, { quantity: "2", barcode: "01234567" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: "BARCODE_IN_USE" } });
    expect((await create(id, token, { quantity: "1.000" })).json()).toEqual({ error: { code: "PACK_QUANTITY_IN_USE" } });
    const second = (await create(other, token, { quantity: "1" })).json().id as string;
    expect((await edit(other, second, token, { barcode: "01234567" })).statusCode).toBe(409);
    const third = (await create(id, token, { quantity: "2" })).json().id as string;
    expect((await edit(id, third, token, { quantity: "1" })).json()).toEqual({ error: { code: "PACK_QUANTITY_IN_USE" } });
    await expect(database.pool.query("INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, 3, '01234567')", [other])).rejects.toMatchObject({ code: "23505", constraint: "packs_barcode_idx" });
    await expect(database.pool.query("INSERT INTO packs (product_id, quantity) VALUES ($1, 1)", [id])).rejects.toMatchObject({ code: "23505", constraint: "packs_product_quantity_idx" });
    expect((await database.pool.query("SELECT barcode FROM packs WHERE id = $1", [second])).rows[0].barcode).toBeNull();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions WHERE target_type = 'pack'")).rows[0].n).toBe(4);
    const simultaneous = await Promise.all([id, other].map((parent) => create(parent, token, { quantity: "3", barcode: "123456789012" })));
    expect(simultaneous.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await create(id, token, { quantity: "4", barcode: "0123456789012" })).statusCode).toBe(201);
  });

  it("checks whole counted quantities, exact measured decimals and a single barcode", async () => {
    const id = await product();
    const token = await headers();
    expect((await create(id, token, { quantity: "0.125" })).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["quantity"] } });
    const pack = (await create(id, token, { quantity: "1" })).json().id as string;
    expect((await edit(id, pack, token, { quantity: "1.5" })).statusCode).toBe(400);
    for (const payload of [{ quantity: "0" }, { quantity: "1.0001" }, { quantity: 1 }, { quantity: "2", barcode: "bad" }, { quantity: "2", barcode: ["12345678"] }, { quantity: "2", barcodes: [] }]) {
      expect((await create(id, token, payload)).statusCode).toBe(400);
    }
    for (const unit of ["kg", "l"]) {
      const measured = await product(unit);
      expect((await create(measured, token, { quantity: "0.001" })).json()).toMatchObject({ quantity: "0.001" });
      const fractional = await create(measured, token, { quantity: "1.125" });
      expect(fractional.statusCode).toBe(201);
      expect((await edit(measured, fractional.json().id as string, token, { quantity: "999999999.999" })).json()).toMatchObject({ quantity: "999999999.999" });
    }
    await expect(database.pool.query("INSERT INTO packs (product_id, quantity) VALUES ($1, 0)", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, 2, 'bad')", [id])).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects missing or mismatched parents and offers no deletion route", async () => {
    const id = await product();
    const token = await headers();
    const pack = (await create(id, token, { quantity: "1" })).json().id as string;
    const missing = randomUUID();
    expect((await app.inject({ method: "GET", url: path(missing), headers: token })).statusCode).toBe(404);
    expect((await create(missing, token, { quantity: "1" })).statusCode).toBe(404);
    expect((await edit(missing, pack, token, { active: false, reason: "Remove" })).statusCode).toBe(404);
    expect((await edit(await product(), pack, token, { quantity: "2" })).statusCode).toBe(404);
    expect((await edit(id, missing, token, { quantity: "2" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${path(id)}/${pack}`, headers: token })).statusCode).toBe(404);
    expect((await database.pool.query("SELECT id FROM packs WHERE id = $1", [pack])).rowCount).toBe(1);
  });

  it("prevents base-unit changes once any active or inactive pack exists", async () => {
    const id = await product("kg");
    const token = await headers();
    const changeUnit = (unit: string) => app.inject({ method: "PATCH", url: `/v1/admin/products/${id}`, headers: token, payload: { baseUnit: unit } });
    expect((await changeUnit("l")).statusCode).toBe(200);
    const pack = (await create(id, token, { quantity: "1" })).json().id as string;
    expect((await changeUnit("kg")).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["baseUnit"] } });
    await edit(id, pack, token, { active: false, reason: "Retired" });
    expect((await changeUnit("kg")).statusCode).toBe(400);
    expect((await changeUnit("l")).statusCode).toBe(200);
  });

  it("serializes a concurrent unit change and counted-pack creation", async () => {
    const id = await product("kg");
    const token = await headers();
    const [made, changed] = await Promise.all([
      create(id, token, { quantity: "0.125" }),
      app.inject({ method: "PATCH", url: `/v1/admin/products/${id}`, headers: token, payload: { baseUnit: "each", classification: "counted" } }),
    ]);
    const parent = (await database.pool.query("SELECT base_unit FROM master_products WHERE id = $1", [id])).rows[0];
    const packs = (await database.pool.query("SELECT quantity FROM packs WHERE product_id = $1", [id])).rows;
    if (parent.base_unit === "each") {
      expect(changed.statusCode).toBe(200);
      expect(made.statusCode).toBe(400);
      expect(packs).toEqual([]);
    } else {
      expect(made.statusCode).toBe(201);
      expect(changed.statusCode).toBe(400);
      expect(packs).toEqual([{ quantity: "0.125" }]);
    }
  });
});

describe("Master product routes", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  async function headers() {
    return bearer((await signIn("/v1/admin/auth")).json().accessToken as string);
  }
  async function image() {
    return sharp({ create: { width: 40, height: 24, channels: 3, background: "orange" } }).png().toBuffer();
  }
  async function groceries() {
    const result = await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Groceries'");
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Seeded Groceries category missing");
    return id;
  }
  function createBody(categoryId: string, source: Buffer, extra: object = {}) {
    return {
      name: "  Apples ",
      categoryId,
      baseUnit: "each",
      classification: "counted",
      image: source.toString("base64"),
      ...extra,
    };
  }
  function create(headers: Record<string, string>, payload: object) {
    return app.inject({ method: "POST", url: "/v1/admin/products", headers, payload });
  }
  function edit(headers: Record<string, string>, id: string, payload: object) {
    return app.inject({ method: "PATCH", url: `/v1/admin/products/${id}`, headers, payload });
  }

  it("requires an Admin web session for list, create and edit", async () => {
    const categoryId = await groceries();
    const source = await image();
    const requests = [
      { method: "GET" as const, url: "/v1/admin/products" },
      { method: "POST" as const, url: "/v1/admin/products", payload: createBody(categoryId, source) },
      { method: "PATCH" as const, url: `/v1/admin/products/${randomUUID()}`, payload: { name: "Apples" } },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
    const mobile = (await signIn("/v1/auth")).json().accessToken as string;
    for (const request of requests) expect((await app.inject({ ...request, headers: bearer(mobile) })).statusCode).toBe(403);
    expect(productImagePuts).toEqual([]);
  });

  it("creates, lists and edits a product with image keys, category state and one audit row per change", async () => {
    const token = await headers();
    const source = await image();
    const made = await create(token, createBody(await groceries(), source));
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      name: "Apples", brand: null, baseUnit: "each", classification: "counted", active: true, published: true,
      categoryName: "Groceries", categoryActive: true, categoryEffectiveActive: true,
      imageUrls: {
        256: expect.stringMatching(/^https:\/\/images\.ygo\.example\/products\//),
        512: expect.stringMatching(/^https:\/\/images\.ygo\.example\/products\//),
        1024: expect.stringMatching(/^https:\/\/images\.ygo\.example\/products\//),
      },
    });
    expect(productImagePuts).toHaveLength(3);
    const id = made.json().id as string;
    const originalKeys = await database.pool.query(
      "SELECT image_256_key, image_512_key, image_1024_key FROM master_products WHERE id = $1",
      [id],
    );
    expect(Object.values(originalKeys.rows[0] ?? {}).every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    const list = await app.inject({ method: "GET", url: "/v1/admin/products", headers: token });
    expect(list.json().products).toHaveLength(1);
    expect(list.json().products[0]).toMatchObject({ id, name: "Apples", categoryEffectiveActive: true });

    productImagePuts = [];
    const renamed = await edit(token, id, { name: "Red apples" });
    expect(renamed.statusCode).toBe(200);
    expect(productImagePuts).toEqual([]);
    expect((await database.pool.query(
      "SELECT image_256_key, image_512_key, image_1024_key FROM master_products WHERE id = $1", [id],
    )).rows).toEqual(originalKeys.rows);
    expect((await edit(token, id, { active: false })).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
    expect((await edit(token, id, { active: false, reason: "Seasonal item removed" })).json()).toMatchObject({ active: false });
    expect((await edit(token, id, { active: true })).json()).toMatchObject({ active: true });
    const audit = await database.pool.query<{ action: string; reason: string; target_type: string }>(
      "SELECT action, reason, target_type FROM admin_actions WHERE target_id = $1", [id],
    );
    const actions = audit.rows.map((row) => `${row.action}|${row.reason}|${row.target_type}`).sort();
    expect(actions).toEqual([
      "product.create|Product created|product",
      "product.deactivate|Seasonal item removed|product",
      "product.edit|Product edited|product",
      "product.reactivate|Product reactivated|product",
    ]);
  });

  it("keeps incomplete drafts after an S3 failure and publishes them on retry", async () => {
    const token = await headers();
    const source = await image();
    failProductImagePuts = true;
    const failed = await create(token, createBody(await groceries(), source));
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toMatchObject({ code: "UNAVAILABLE", draftId: expect.any(String) });
    const id = failed.json().error.draftId as string;
    expect((await database.pool.query("SELECT published FROM master_products WHERE id = $1", [id])).rows[0].published).toBe(false);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM admin_actions WHERE target_id = $1", [id])).rows[0].count).toBe(1);

    const list = await app.inject({ method: "GET", url: "/v1/admin/products", headers: token });
    expect(list.statusCode).toBe(200);
    expect(list.json().products).toEqual([expect.objectContaining({ id, name: "Apples", published: false, imageUrls: null })]);

    failProductImagePuts = false;
    const retry = await edit(token, id, { image: source.toString("base64") });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ published: true, imageUrls: expect.any(Object) });
    expect((await database.pool.query("SELECT published, image_256_key, image_512_key, image_1024_key FROM master_products WHERE id = $1", [id])).rows[0])
      .toMatchObject({ published: true });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM admin_actions WHERE target_id = $1", [id])).rows[0].count).toBe(1);
  });

  it("keeps details, image keys and audit rows unchanged when image replacement fails", async () => {
    const token = await headers();
    const created = await create(token, createBody(await groceries(), await image()));
    const id = created.json().id as string;
    const snapshot = async () => ({
      product: (await database.pool.query(
        "SELECT name, published, image_256_key, image_512_key, image_1024_key FROM master_products WHERE id = $1", [id],
      )).rows[0],
      actions: (await database.pool.query("SELECT count(*)::int AS count FROM admin_actions WHERE target_id = $1", [id])).rows[0].count,
    });
    const before = await snapshot();
    const replacement = await sharp({ create: { width: 48, height: 24, channels: 3, background: "blue" } }).png().toBuffer();
    failProductImagePuts = true;

    for (const changes of [{ name: "Blue apples" }, {}]) {
      const failed = await edit(token, id, { ...changes, image: replacement.toString("base64") });
      expect(failed.statusCode).toBe(503);
      expect(await snapshot()).toEqual(before);
    }
    failProductImagePuts = false;
    const saved = await edit(token, id, { name: "Blue apples", image: replacement.toString("base64") });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ name: "Blue apples", published: true });
    const after = await snapshot();
    expect(after.product.image_256_key).not.toBe(before.product.image_256_key);
    expect(after.actions).toBe(before.actions + 1);
  });

  it("rejects bad base64, non-images and inputs over 10 MiB before S3", async () => {
    const token = await headers();
    const categoryId = await groceries();
    const source = await image();
    const invalidBase64 = await create(token, { ...createBody(categoryId, source), image: "not base64!" });
    expect(invalidBase64.statusCode).toBe(400);
    expect(invalidBase64.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["image"] } });
    const notImage = await create(token, { ...createBody(categoryId, source), image: Buffer.from("plain text").toString("base64") });
    expect(notImage.statusCode).toBe(400);
    expect(notImage.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["image"] } });
    const oversizedSource = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    const oversized = await create(token, { ...createBody(categoryId, source), image: oversizedSource });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["image"] } });
    expect(productImagePuts).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM master_products")).rows[0].count).toBe(0);
  });

  it("uses 14 MiB only for product writes and preserves the default 1 MiB limit elsewhere", async () => {
    const token = await headers();
    const productBody = { image: "A".repeat(14 * 1024 * 1024) };
    const tooLargeProduct = await create(token, productBody);
    expect(tooLargeProduct.statusCode).toBe(413);
    expect(tooLargeProduct.json()).toEqual({ error: { code: "VALIDATION_FAILED" } });
    const tooLargeCategory = await app.inject({
      method: "POST", url: "/v1/admin/categories", headers: token,
      payload: { name: "x".repeat(1024 * 1024) },
    });
    expect(tooLargeCategory.statusCode).toBe(413);
    expect(tooLargeCategory.json()).toEqual({ error: { code: "VALIDATION_FAILED" } });
  });

  it("enforces case-insensitive name and brand identity and counted/measured units", async () => {
    const token = await headers();
    const categoryId = await groceries();
    const source = await image();
    const first = await create(token, createBody(categoryId, source, { brand: "Farm" }));
    expect(first.statusCode).toBe(201);
    expect((await create(token, createBody(categoryId, source, { name: "apples", brand: "FARM" }))).json())
      .toEqual({ error: { code: "PRODUCT_NAME_IN_USE" } });
    expect((await create(token, createBody(categoryId, source, { baseUnit: "kg", classification: "counted" }))).json())
      .toEqual({ error: { code: "VALIDATION_FAILED", fields: ["baseUnit"] } });
    expect(productImagePuts).toHaveLength(3);
  });

  it("rejects inactive category assignments but preserves existing associations", async () => {
    const token = await headers();
    const categoryId = await groceries();
    const source = await image();
    const made = await create(token, createBody(categoryId, source));
    const id = made.json().id as string;
    const deactivated = await app.inject({
      method: "PATCH", url: `/v1/admin/categories/${categoryId}`, headers: token,
      payload: { active: false, reason: "Category retired" },
    });
    expect(deactivated.statusCode).toBe(200);

    productImagePuts = [];
    const list = await app.inject({ method: "GET", url: "/v1/admin/products", headers: token });
    expect(list.json().products[0]).toMatchObject({ categoryId, categoryActive: false, categoryEffectiveActive: false });
    expect((await edit(token, id, { name: "Apples, local" })).statusCode).toBe(200);
    expect((await create(token, createBody(categoryId, source))).json()).toEqual({
      error: { code: "VALIDATION_FAILED", fields: ["categoryId"] },
    });
    expect(productImagePuts).toEqual([]);
  });
});
