import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { accessToken, deriveKeys } from "../src/tokens";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "initial-admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

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
  app = buildApp({ checkDatabase: database.ping, database, clock, mailer, authTokenSecret: secret });
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
