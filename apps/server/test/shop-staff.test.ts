import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { connectDatabase } from "../src/db";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  name = `ygo_staff_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function signIn(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

/** An approved shop with its Owner signed in. */
async function shop(email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, 'approved', 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [shopId]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  return { ...owner, shopId };
}

/** A signed-in account that typed `phone` at sign-up. */
async function person(email: string, phone: string) {
  const who = await signIn(email);
  await database.pool.query("UPDATE accounts SET name = 'Ravi', phone = $2 WHERE id = $1", [who.id, phone]);
  return who;
}

const invite = (owner: { headers: { authorization: string } }, phone: string, canDeliver = false) =>
  app.inject({ method: "POST", url: "/v1/me/staff-invites", headers: owner.headers, payload: { phone, canDeliver } });
const join = (who: { headers: { authorization: string } }, code: string) =>
  app.inject({ method: "POST", url: "/v1/me/shop-join", headers: who.headers, payload: { code } });
const accessOf = async (who: { headers: { authorization: string } }) =>
  (await app.inject({ method: "GET", url: "/v1/sync/access", headers: who.headers })).json() as { shopId: string | null; role: string | null };

describe("Staff invite and join (#58)", () => {
  it("links the invited account only with the code (ACC-6)", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    const made = await invite(owner, "+919800000001", true);
    expect(made.statusCode).toBe(200);
    const { code } = made.json() as { code: string };
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    // The number alone grants nothing.
    expect(await accessOf(staff)).toMatchObject({ shopId: null, role: null });
    expect((await join(staff, code.replace(/^./, code[0] === "A" ? "B" : "A"))).json().error.code).toBe("CODE_WRONG");
    const joined = await join(staff, code.toLowerCase());
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({ shopName: "Sai General Stores" });
    expect(await accessOf(staff)).toMatchObject({ shopId: owner.shopId, role: "staff" });
    const { rows } = await database.pool.query("SELECT can_deliver FROM shop_members WHERE account_id = $1", [staff.id]);
    expect(rows).toEqual([{ can_deliver: true }]);
    // The code works once.
    expect((await join(staff, code)).json().error.code).toBe("ALREADY_LINKED");
  });

  it("refuses a code used from an account with another number", async () => {
    const owner = await shop();
    const { code } = (await invite(owner, "+919800000001")).json() as { code: string };
    const other = await person("other@example.com", "+919800000002");
    expect((await join(other, code)).json().error.code).toBe("CODE_WRONG");
    expect(await accessOf(other)).toMatchObject({ shopId: null });
  });

  it("locks the invitation after 5 wrong tries until the Owner invites again", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    const { code } = (await invite(owner, "+919800000001")).json() as { code: string };
    for (let i = 0; i < 5; i += 1) expect((await join(staff, "AAAAAAAA")).json().error.code).toBe("CODE_WRONG");
    expect((await join(staff, code)).statusCode).toBe(429);
    const fresh = (await invite(owner, "+919800000001")).json() as { code: string };
    expect((await join(staff, fresh.code)).statusCode).toBe(200);
  });

  it("expires the code after 24 hours", async () => {
    const owner = await shop();
    await person("staff@example.com", "+919800000001");
    const { code } = (await invite(owner, "+919800000001")).json() as { code: string };
    clock.set(new Date("2030-01-02T00:00:01.000Z"));
    const later = await signIn("staff@example.com");
    expect((await join(later, code)).json().error.code).toBe("CODE_EXPIRED");
  });

  it("works for a number that signs up after the invitation", async () => {
    const owner = await shop();
    const { code } = (await invite(owner, "9800000003")).json() as { code: string };
    const staff = await person("late@example.com", "+919800000003");
    expect((await join(staff, code)).statusCode).toBe(200);
  });

  it("deactivates at once and a re-invite restores the same account's link (ACC-7, ACC-11)", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001", true)).json() as { code: string }).code);
    const off = await app.inject({ method: "POST", url: `/v1/me/shop-staff/${staff.id}/deactivate`, headers: owner.headers });
    expect(off.statusCode).toBe(204);
    expect(await accessOf(staff)).toMatchObject({ shopId: null, role: null });
    const listed = (await app.inject({ method: "GET", url: "/v1/me/staff-invites", headers: owner.headers })).json();
    expect(listed.invites).toEqual([{ phone: "+919800000001", name: "Ravi", canDeliver: true, status: "deactivated", expiresAt: null }]);
    const again = await invite(owner, "+919800000001", false);
    expect(again.statusCode).toBe(200);
    expect((await join(staff, (again.json() as { code: string }).code)).statusCode).toBe(200);
    const { rows } = await database.pool.query("SELECT account_id, status FROM staff_invites WHERE shop_id = $1", [owner.shopId]);
    expect(rows).toEqual([{ account_id: staff.id, status: "active" }]);
    expect(await accessOf(staff)).toMatchObject({ shopId: owner.shopId, role: "staff" });
    expect((await database.pool.query("SELECT can_deliver FROM shop_members WHERE account_id = $1", [staff.id])).rows).toEqual([{ can_deliver: false }]);
  });

  it("opens Staff's shop instead of the Start screen (GET /v1/me/shop-application)", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    const read = async () => (await app.inject({ method: "GET", url: "/v1/me/shop-application", headers: staff.headers })).json();
    expect(await read()).toEqual({ application: null, liveCheck: null, staffShop: null });
    await join(staff, ((await invite(owner, "+919800000001")).json() as { code: string }).code);
    // The shop's name and state only: none of the Owner's application (PAN, FSSAI, UPI).
    expect(await read()).toEqual({ application: null, liveCheck: null, staffShop: { shopId: owner.shopId, shopName: "Sai General Stores", state: "approved" } });
    // Start refuses a Staff account, so the app must not offer it.
    expect((await app.inject({ method: "POST", url: "/v1/me/shop-application", headers: staff.headers })).json().error.code).toBe("SHOP_APPLICATION_EXISTS");
    // The Owner still sees their own application and no staffShop.
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-application", headers: owner.headers })).json()).toMatchObject({ application: { state: "approved" }, staffShop: null });
  });

  it("stops a deactivated Staff member's existing token at every shop resource, but not as a Customer (ACC-11)", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001", true)).json() as { code: string }).code);
    const shopRoutes = ["/v1/me/shop-orders", "/v1/me/shop-deliverers", "/v1/me/stock", "/v1/me/counter-bills"];
    for (const url of shopRoutes) expect((await app.inject({ method: "GET", url, headers: staff.headers })).statusCode, url).not.toBe(404);
    await app.inject({ method: "POST", url: `/v1/me/shop-staff/${staff.id}/deactivate`, headers: owner.headers });
    // The same access token, with no refresh and no new sign-in.
    for (const url of shopRoutes) expect((await app.inject({ method: "GET", url, headers: staff.headers })).statusCode, url).toBe(404);
    expect(await accessOf(staff)).toMatchObject({ shopId: null, role: null });
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-application", headers: staff.headers })).json().staffShop).toBeNull();
    expect((await app.inject({ method: "POST", url: "/v1/sync/actions", headers: staff.headers, payload: { actions: [] } })).statusCode).not.toBe(200);
    // The Customer side of the same account keeps working.
    expect((await app.inject({ method: "GET", url: "/v1/orders", headers: staff.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/me/addresses", headers: staff.headers })).statusCode).toBe(200);
  });

  it("lets the Owner of a Suspended shop still remove Staff, but not invite", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001")).json() as { code: string }).code);
    await database.pool.query("UPDATE shops SET state = 'suspended' WHERE id = $1", [owner.shopId]);
    expect((await invite(owner, "+919800000002")).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-staff/${staff.id}/deactivate`, headers: owner.headers })).statusCode).toBe(204);
    expect(await accessOf(staff)).toMatchObject({ shopId: null });
  });

  it("deactivates the right row after the member's number changed", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001")).json() as { code: string }).code);
    await database.pool.query("UPDATE accounts SET phone = '+919800000009' WHERE id = $1", [staff.id]);
    await app.inject({ method: "POST", url: `/v1/me/shop-staff/${staff.id}/deactivate`, headers: owner.headers });
    const { rows } = await database.pool.query("SELECT phone, status FROM staff_invites WHERE shop_id = $1", [owner.shopId]);
    expect(rows).toEqual([{ phone: "+919800000001", status: "deactivated" }]);
  });

  it("holds one shop link per account (ACC-4)", async () => {
    const owner = await shop();
    const other = await shop("owner2@example.com");
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001")).json() as { code: string }).code);
    expect((await invite(other, "+919800000001")).json().error.code).toBe("STAFF_AT_ANOTHER_SHOP");
    expect((await invite(owner, "+919800000001")).json().error.code).toBe("STAFF_ALREADY_MEMBER");
    const second = await person("again@example.com", "+919800000004");
    const { code } = (await invite(other, "+919800000004")).json() as { code: string };
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [second.id, owner.shopId]);
    expect((await join(second, code)).json().error.code).toBe("ALREADY_LINKED");
  });

  it("keeps the Owner's pages and the staff list away from Staff", async () => {
    const owner = await shop();
    const staff = await person("staff@example.com", "+919800000001");
    await join(staff, ((await invite(owner, "+919800000001")).json() as { code: string }).code);
    expect((await invite(staff, "+919800000009")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/me/staff-invites", headers: staff.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-staff", headers: staff.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-hours", headers: staff.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-staff/${owner.id}/deactivate`, headers: staff.headers })).statusCode).toBe(404);
  });
});
