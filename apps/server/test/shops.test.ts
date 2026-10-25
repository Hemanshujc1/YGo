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

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  name = `ygo_shops_${randomUUID().replaceAll("-", "")}`;
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
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
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

/** The sign-in code last mailed to `email`. */
function codeFor(email: string) {
  return mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
}

/** Signs someone in on the Shopkeeper app, with a name and phone unless `profile` is false. */
async function owner(email: string, profile = true, phone = "+919876543210") {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = codeFor(email);
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  clock.advance(1_000);
  const headers = { authorization: `Bearer ${signed.accessToken as string}` };
  if (profile) await app.inject({ method: "PUT", url: "/v1/me/profile", headers, payload: { name: "Asha Kulkarni", phone } });
  return { id: signed.account.id as string, headers };
}

async function area(pincode: string, paused = false) {
  const inserted = await database.pool.query<{ id: string }>("INSERT INTO areas (name, paused) VALUES ('Kothrud', $1) RETURNING id", [paused]);
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ($1, $2)", [pincode, inserted.rows[0]?.id]);
}

// The FSSAI check reads the real clock (the contract's rule), not the test clock.
const complete = {
  shopName: "Sai General Stores",
  address: "Shop 3, Paud Road, Kothrud",
  pincode: "411038",
  location: { latitude: 18.5074, longitude: 73.8077 },
  ownerName: "Asha Kulkarni",
  entityType: "proprietorship",
  pan: "ABCDE1234F",
  fssaiNumber: "11223344556677",
  fssaiExpiry: "2099-03-31",
  serviceRadiusMetres: 2000,
  upiId: "asha.k@okhdfcbank",
};

const draft = {
  id: expect.any(String),
  state: "draft",
  shopName: null,
  address: null,
  pincode: null,
  location: null,
  ownerName: "Asha Kulkarni",
  entityType: null,
  pan: null,
  fssaiNumber: null,
  fssaiExpiry: null,
  serviceRadiusMetres: 2000,
  upiId: null,
  areaName: null,
  ownerPhone: "+919876543210",
  ownerEmail: "asha@example.com",
  submittedAt: null,
};

describe("shop application", () => {
  const url = "/v1/me/shop-application";
  const read = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url, headers })).json();
  const start = (headers: Record<string, string>) => app.inject({ method: "POST", url, headers });
  const save = (headers: Record<string, string>, payload: object) => app.inject({ method: "PATCH", url, headers, payload });
  const send = (headers: Record<string, string>, payload: object) => app.inject({ method: "POST", url: `${url}/send`, headers, payload });

  it("refuses signed-out callers", async () => {
    for (const request of [
      { method: "GET" as const, url },
      { method: "POST" as const, url },
      { method: "PATCH" as const, url, payload: {} },
      { method: "POST" as const, url: `${url}/send`, payload: complete },
    ]) expect((await app.inject(request)).statusCode).toBe(401);
  });

  it("starts a Draft with the account's name, phone and email, once", async () => {
    const { id, headers } = await owner("asha@example.com");
    expect(await read(headers)).toEqual({ application: null });
    const started = await start(headers);
    expect(started.statusCode).toBe(201);
    expect(started.json()).toEqual(draft);
    expect(await read(headers)).toEqual({ application: started.json() });
    const link = await database.pool.query("SELECT shop_id AS \"shopId\", role FROM shop_members WHERE account_id = $1", [id]);
    expect(link.rows).toEqual([{ shopId: started.json().id, role: "owner" }]);

    expect((await start(headers)).json()).toEqual({ error: { code: "SHOP_APPLICATION_EXISTS" } });
    expect((await database.pool.query("SELECT 1 FROM shops")).rowCount).toBe(1);
  });

  it("needs a name and phone on the account to start", async () => {
    const { headers } = await owner("asha@example.com", false);
    const refused = await start(headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: { code: "PROFILE_REQUIRED" } });
    expect(await read(headers)).toEqual({ application: null });
  });

  it("saves a Draft in parts, empties a field with null, and takes a pincode in no Area", async () => {
    const { headers } = await owner("asha@example.com");
    expect((await save(headers, { shopName: "Sai Stores" })).json()).toEqual({ error: { code: "NOT_FOUND" } });
    await start(headers);
    const first = await save(headers, { shopName: " Sai Stores ", pincode: "411038", location: complete.location, fssaiExpiry: "2020-01-31" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ...draft, shopName: "Sai Stores", pincode: "411038", location: complete.location, fssaiExpiry: "2020-01-31" });
    const second = await save(headers, { pan: "abcde1234f", location: null, serviceRadiusMetres: 3500 });
    expect(second.json()).toEqual({ ...first.json(), pan: "ABCDE1234F", location: null, serviceRadiusMetres: 3500 });
    expect((await save(headers, {})).json()).toEqual(second.json());
    expect(await read(headers)).toEqual({ application: second.json() });
  });

  it("refuses a Draft value that breaks its rule, and an empty radius", async () => {
    const { headers } = await owner("asha@example.com");
    await start(headers);
    const refused = await save(headers, { pan: "ABCDE1234", serviceRadiusMetres: null, ownerPhone: "+919999999999" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fields).toEqual(["pan", "serviceRadiusMetres", "ownerPhone"]);
  });

  it("sends with every field, taking the pincode's Area even when paused", async () => {
    await area("411038", true);
    const { headers } = await owner("asha@example.com");
    await start(headers);
    await save(headers, { shopName: "Old name" });
    clock.advance(60_000);
    const sent = await send(headers, complete);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ ...draft, ...complete, state: "submitted", areaName: "Kothrud", submittedAt: "2030-01-01T00:01:01.000Z" });
    expect(await read(headers)).toEqual({ application: sent.json() });
  });

  it("follows the pincode when an Admin moves it to another Area, or out of every Area", async () => {
    await area("411038");
    const { headers } = await owner("asha@example.com");
    await start(headers);
    await send(headers, complete);
    const baner = await database.pool.query<{ id: string }>("INSERT INTO areas (name, paused) VALUES ('Baner', false) RETURNING id");
    await database.pool.query("UPDATE area_pincodes SET area_id = $1 WHERE pincode = '411038'", [baner.rows[0]?.id]);
    expect((await read(headers)).application.areaName).toBe("Baner");
    await database.pool.query("DELETE FROM area_pincodes");
    expect((await read(headers)).application.areaName).toBeNull();
  });

  it("names each missing field and a past FSSAI expiry together", async () => {
    await area("411038");
    const { headers } = await owner("asha@example.com");
    await start(headers);
    const refused = await send(headers, { ...complete, pan: undefined, location: undefined, fssaiExpiry: "2020-01-31" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fields).toEqual(["location", "pan", "fssaiExpiry"]);
  });

  it("refuses a pincode in no Area, and saves nothing", async () => {
    const { headers } = await owner("asha@example.com");
    const started = (await start(headers)).json();
    const refused = await send(headers, complete);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: { code: "PINCODE_NOT_IN_AREA" } });
    expect(await read(headers)).toEqual({ application: started });
  });

  it("refuses a save or a second send once sent", async () => {
    await area("411038");
    const { headers } = await owner("asha@example.com");
    expect((await send(headers, complete)).json()).toEqual({ error: { code: "NOT_FOUND" } });
    await start(headers);
    const sent = (await send(headers, complete)).json();
    expect((await save(headers, { shopName: "New name" })).json()).toEqual({ error: { code: "SHOP_APPLICATION_SENT" } });
    expect((await send(headers, complete)).json()).toEqual({ error: { code: "SHOP_APPLICATION_SENT" } });
    expect(await read(headers)).toEqual({ application: sent });
  });

  it("keeps a sent shop complete, one shop per account, and the account while linked", async () => {
    const { id, headers } = await owner("asha@example.com");
    const shopId = (await start(headers)).json().id as string;
    await expect(database.pool.query("UPDATE shops SET state = 'submitted' WHERE id = $1", [shopId])).rejects.toMatchObject({ constraint: "shops_sent_complete" });
    const other = await database.pool.query<{ id: string }>("INSERT INTO shops (created_at) VALUES (now()) RETURNING id");
    await expect(database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [id, other.rows[0]?.id]))
      .rejects.toMatchObject({ constraint: "shop_members_pkey" });
    await expect(database.pool.query("DELETE FROM accounts WHERE id = $1", [id])).rejects.toMatchObject({ constraint: "shop_members_account_id_accounts_id_fk" });
  });
});

describe("shop application, Admin", () => {
  const url = "/v1/admin/shop-applications";
  async function adminHeaders() {
    await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: "admin@example.com" } });
    const signed = (await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: "admin@example.com", code: codeFor("admin@example.com") } })).json();
    return { authorization: `Bearer ${signed.accessToken as string}` };
  }
  /** An Owner's application, sent unless `sent` is false. */
  async function application(email: string, sent = true, phone = "+919876543210") {
    const { headers } = await owner(email, true, phone);
    const started = (await app.inject({ method: "POST", url: "/v1/me/shop-application", headers })).json();
    if (!sent) return started;
    return (await app.inject({ method: "POST", url: "/v1/me/shop-application/send", headers, payload: complete })).json();
  }
  function actions(shopId: string) {
    return database.pool.query<{ action: string; reason: string }>(
      "SELECT action, reason FROM admin_actions WHERE target_type = 'shop' AND target_id = $1 ORDER BY created_at, action",
      [shopId],
    ).then((result) => result.rows);
  }
  const move = (headers: Record<string, string>, id: string, step: string) => app.inject({ method: "POST", url: `${url}/${id}/${step}`, headers });
  const correct = (headers: Record<string, string>, id: string, payload: object) => app.inject({ method: "PATCH", url: `${url}/${id}`, headers, payload });

  it("refuses signed-out callers and app accounts", async () => {
    const { headers } = await owner("asha@example.com");
    const id = randomUUID();
    for (const request of [
      { method: "GET" as const, url },
      { method: "GET" as const, url: `${url}/${id}` },
      { method: "PATCH" as const, url: `${url}/${id}`, payload: { shopName: "Sai Stores", reason: "Typo" } },
      { method: "POST" as const, url: `${url}/${id}/start-review` },
      { method: "POST" as const, url: `${url}/${id}/approve` },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await app.inject({ ...request, headers })).statusCode).toBe(403);
    }
  });

  it("lists sent applications, the longest waiting first, and reads one; a Draft is not found", async () => {
    await area("411038");
    const later = await application("asha@example.com", false);
    const first = await application("bina@example.com", true, "+919876543211");
    clock.advance(60_000);
    await app.inject({ method: "POST", url: "/v1/me/shop-application/send", headers: (await owner("asha@example.com")).headers, payload: complete });
    const draft = await application("chitra@example.com", false, "+919876543212");
    const headers = await adminHeaders();
    const listed = (await app.inject({ method: "GET", url, headers })).json().applications;
    expect(listed.map((one: { id: string }) => one.id)).toEqual([first.id, later.id]);
    const read = await app.inject({ method: "GET", url: `${url}/${later.id}`, headers });
    expect(read.json()).toEqual(listed[1]);
    expect(read.json()).toMatchObject({ state: "submitted", ownerPhone: "+919876543210", ownerEmail: "asha@example.com", areaName: "Kothrud" });
    for (const id of [draft.id, randomUUID()]) {
      for (const refused of [
        await app.inject({ method: "GET", url: `${url}/${id}`, headers }),
        await correct(headers, id, { shopName: "Sai Stores", reason: "Typo" }),
        await move(headers, id, "start-review"),
        await move(headers, id, "approve"),
      ]) expect(refused.json()).toEqual({ error: { code: "NOT_FOUND" } });
    }
  });

  it("starts review then approves, each logged with its fixed reason; any other move is refused", async () => {
    await area("411038");
    const { id } = await application("asha@example.com");
    const headers = await adminHeaders();
    const refused = { error: { code: "SHOP_STATE_CHANGE_REFUSED" } };
    expect((await move(headers, id, "approve")).json()).toEqual(refused);
    const reviewing = await move(headers, id, "start-review");
    expect(reviewing.statusCode).toBe(200);
    expect(reviewing.json().state).toBe("under_review");
    expect((await move(headers, id, "start-review")).json()).toEqual(refused);
    expect((await move(headers, id, "approve")).json().state).toBe("approved");
    for (const step of ["start-review", "approve"]) expect((await move(headers, id, step)).statusCode).toBe(409);
    expect(await actions(id)).toEqual([
      { action: "shop.start_review", reason: "Started review" },
      { action: "shop.approve", reason: "Approved" },
    ]);
  });

  it("lets only one of two Start reviews at once through", async () => {
    await area("411038");
    const { id } = await application("asha@example.com");
    const headers = await adminHeaders();
    const both = await Promise.all([move(headers, id, "start-review"), move(headers, id, "start-review")]);
    expect(both.map((one) => one.statusCode).sort()).toEqual([200, 409]);
    expect(await actions(id)).toHaveLength(1);
  });

  it("corrects an Approved shop, logging each changed field by name with the reason", async () => {
    await area("411038");
    const { id } = await application("asha@example.com");
    const headers = await adminHeaders();
    await move(headers, id, "start-review");
    const approved = (await move(headers, id, "approve")).json();
    const location = { latitude: 18.5081, longitude: 73.8102 };
    const corrected = await correct(headers, id, {
      shopName: "Sai Super Mart", pan: "abcde1234f", location, fssaiExpiry: "2020-01-31", serviceRadiusMetres: 2000, reason: "Owner called support",
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toEqual({ ...approved, shopName: "Sai Super Mart", location, fssaiExpiry: "2020-01-31" });
    const logged = ["shop.correct.fssai_expiry", "shop.correct.location", "shop.correct.shop_name"]
      .map((action) => ({ action, reason: "Owner called support" }));
    expect((await actions(id)).slice(2)).toEqual(logged);

    const same = await correct(headers, id, { shopName: "Sai Super Mart", location, reason: "Again" });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toEqual(corrected.json());
    expect((await actions(id)).slice(2)).toEqual(logged);
    expect((await correct(headers, id, { reason: "Nothing" })).json().error.fields).toEqual(["fields"]);
  });

  it("moves the shop to a corrected pincode's Area, and refuses one in no Area", async () => {
    await area("411038");
    const baner = await database.pool.query<{ id: string }>("INSERT INTO areas (name, paused) VALUES ('Baner', true) RETURNING id");
    await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1)", [baner.rows[0]?.id]);
    const { id } = await application("asha@example.com");
    const headers = await adminHeaders();
    const moved = await correct(headers, id, { pincode: "411045", reason: "Shop is in Baner" });
    expect(moved.json()).toMatchObject({ pincode: "411045", areaName: "Baner" });
    const refused = await correct(headers, id, { pincode: "411001", shopName: "Sai Stores", reason: "Wrong pincode" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: { code: "PINCODE_NOT_IN_AREA" } });
    expect((await app.inject({ method: "GET", url: `${url}/${id}`, headers })).json()).toEqual(moved.json());
    expect(await actions(id)).toEqual([{ action: "shop.correct.pincode", reason: "Shop is in Baner" }]);
  });
});
