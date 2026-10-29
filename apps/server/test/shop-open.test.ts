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
import { schedule } from "../src/shop-open";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const adminEmail = "admin@example.com";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { authorization: string };

beforeEach(async () => {
  name = `ygo_open_${randomUUID().replaceAll("-", "")}`;
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
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: adminEmail } });
  const code = mailer.sent.findLast((sent) => sent.to === adminEmail)?.text.match(/code is (\d{6})/)?.[1];
  const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: adminEmail, code } });
  admin = { authorization: `Bearer ${signed.json().accessToken as string}` };
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

/** A sent shop in `state` with its Owner signed in. */
async function shop(state = "approved", email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [shopId, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  return { ...owner, email, shopId };
}


const h = (hours: number) => hours * 60;
/** A time in India. 1 Jan 2030 is a Tuesday. */
const ist = (local: string) => new Date(`${local}+05:30`);
const iso = (local: string) => ist(local).toISOString();
const status = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me/shop-open", headers });
const turn = (headers: Record<string, string>, payload: object) => app.inject({ method: "PUT", url: "/v1/me/shop-open", headers, payload });
/** Moves the clock to a time in India and signs the Owner in again, as tokens last 15 minutes. */
async function move(owner: { email: string; headers: Record<string, string> }, local: string) {
  clock.set(ist(local));
  owner.headers = (await signIn(owner.email)).headers;
}
const setHours = (headers: Record<string, string>, ranges: object[]) => app.inject({ method: "PUT", url: "/v1/me/shop-hours", headers, payload: { ranges } });

describe("the weekly hours alone (#380)", () => {
  it("runs a past-midnight Sunday range into Monday and treats back-to-back ranges as one opening", () => {
    const ranges = [{ weekday: 7, opens: h(22), closes: h(2) }, { weekday: 2, opens: h(9), closes: h(13) }, { weekday: 2, opens: h(13), closes: h(17) }];
    expect(schedule(ranges, ist("2030-01-07T01:00:00"))).toEqual({ open: true, nextOpening: ist("2030-01-08T09:00:00"), nextClosing: ist("2030-01-07T02:00:00") });
    expect(schedule(ranges, ist("2030-01-01T10:00:00"))).toEqual({ open: true, nextOpening: ist("2030-01-06T22:00:00"), nextClosing: ist("2030-01-01T17:00:00") });
    expect(schedule(ranges, ist("2030-01-01T17:00:00")).open).toBe(false);
    expect(schedule([], ist("2030-01-01T10:00:00"))).toEqual({ open: true, nextOpening: null, nextClosing: null });
  });
});

describe("Open/closed switch (#380)", () => {
  it("closes until the next opening, counting back-to-back ranges as one, then opens by itself; the Owner can reopen sooner", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [{ weekday: 2, opens: h(9), closes: h(13) }, { weekday: 2, opens: h(13), closes: h(17) }, { weekday: 3, opens: h(9), closes: h(21) }]);
    await move(owner, "2030-01-01T10:00:00");
    const open = { open: true, until: iso("2030-01-01T17:00:00"), setByOwner: false, scheduledOpen: true, nextOpening: iso("2030-01-02T09:00:00") };
    expect((await status(owner.headers)).json()).toEqual(open);

    const closed = { ...open, open: false, until: iso("2030-01-02T09:00:00"), setByOwner: true };
    expect((await turn(owner.headers, { open: false })).json()).toEqual(closed);
    await move(owner, "2030-01-01T13:30:00");
    expect((await status(owner.headers)).json()).toEqual(closed);
    await move(owner, "2030-01-02T09:00:00");
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: false, until: iso("2030-01-02T21:00:00") });

    expect((await turn(owner.headers, { open: false })).json()).toMatchObject({ open: false, setByOwner: true });
    expect((await turn(owner.headers, { open: true })).json()).toMatchObject({ open: true, setByOwner: false, until: iso("2030-01-02T21:00:00") });
  });

  it("opens outside hours until a chosen half hour no later than the next opening, then the hours take over", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [{ weekday: 2, opens: h(9), closes: h(17) }, { weekday: 3, opens: h(9), closes: h(17) }]);
    await move(owner, "2030-01-01T18:10:00");
    expect((await status(owner.headers)).json()).toEqual({ open: false, until: iso("2030-01-02T09:00:00"), setByOwner: false, scheduledOpen: false, nextOpening: iso("2030-01-02T09:00:00") });
    for (const until of [undefined, iso("2030-01-01T18:00:00"), iso("2030-01-01T20:15:00"), iso("2030-01-02T09:30:00")]) {
      const refused = await turn(owner.headers, { open: true, until });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toEqual({ code: "VALIDATION_FAILED", fields: ["until"] });
    }

    expect((await turn(owner.headers, { open: true, until: iso("2030-01-01T22:00:00") })).json()).toMatchObject({ open: true, until: iso("2030-01-01T22:00:00"), setByOwner: true });
    await move(owner, "2030-01-01T21:59:00");
    expect((await status(owner.headers)).json().open).toBe(true);
    await move(owner, "2030-01-01T22:00:00");
    expect((await status(owner.headers)).json()).toMatchObject({ open: false, setByOwner: false, until: iso("2030-01-02T09:00:00") });

    // Up to the next opening itself, which hands straight over to the hours.
    expect((await turn(owner.headers, { open: true, until: iso("2030-01-02T09:00:00") })).json()).toMatchObject({ open: true, until: iso("2030-01-02T09:00:00") });
    await move(owner, "2030-01-02T09:00:00");
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: false, until: iso("2030-01-02T17:00:00") });
  });

  it("closes a shop with no closed time for 24 hours", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: 0, closes: 0 })));
    await move(owner, "2030-01-01T23:10:00");
    expect((await status(owner.headers)).json()).toEqual({ open: true, until: null, setByOwner: false, scheduledOpen: true, nextOpening: null });
    expect((await turn(owner.headers, { open: false })).json()).toMatchObject({ open: false, until: iso("2030-01-02T23:10:00"), setByOwner: true });
    await move(owner, "2030-01-02T23:10:00");
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: false });
  });

  it("cancels a running switch when the Owner saves new weekly hours", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [{ weekday: 2, opens: h(9), closes: h(21) }]);
    await move(owner, "2030-01-01T10:00:00");
    await turn(owner.headers, { open: false });
    expect((await setHours(owner.headers, [{ weekday: 2, opens: h(8), closes: h(20) }])).statusCode).toBe(200);
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: false, until: iso("2030-01-01T20:00:00") });
  });

  it("is for the Owner of a Live shop only: Staff 403, no shop 404, not Live 409", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [{ weekday: 2, opens: h(9), closes: h(21) }]);
    const staff = await signIn("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, owner.shopId]);
    expect((await turn(staff.headers, { open: false })).statusCode).toBe(403);
    expect((await status(staff.headers)).statusCode).toBe(403);
    expect((await turn((await signIn("nobody@example.com")).headers, { open: false })).statusCode).toBe(404);
    const approved = await shop("approved", "early@example.com");
    expect((await turn(approved.headers, { open: false })).json().error.code).toBe("SHOP_NOT_LIVE");
    expect((await status(approved.headers)).json().error.code).toBe("SHOP_NOT_LIVE");
    expect((await turn({}, { open: false })).statusCode).toBe(401);
    expect((await turn(admin, { open: false })).statusCode).toBe(403);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM shops WHERE open_override IS NOT NULL")).rows[0]).toEqual({ n: 0 });
  });
});
