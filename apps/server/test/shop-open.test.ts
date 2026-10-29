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
import { holidaysNear, schedule } from "../src/shop-open";

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
    expect(schedule(ranges, [], ist("2030-01-07T01:00:00"))).toEqual({ open: true, nextOpening: ist("2030-01-08T09:00:00"), nextClosing: ist("2030-01-07T02:00:00") });
    expect(schedule(ranges, [], ist("2030-01-01T10:00:00"))).toEqual({ open: true, nextOpening: ist("2030-01-06T22:00:00"), nextClosing: ist("2030-01-01T17:00:00") });
    expect(schedule(ranges, [], ist("2030-01-01T17:00:00")).open).toBe(false);
    expect(schedule([], [], ist("2030-01-01T10:00:00"))).toEqual({ open: true, nextOpening: null, nextClosing: null });
  });
});

describe("holidays in the hours (#382)", () => {
  const daily = (opens: number, closes: number) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens, closes }));

  it("joins back-to-back holidays into one closed stretch and finds the opening after them", () => {
    const holidays = [{ starts: "2030-01-02", ends: "2030-01-03" }, { starts: "2030-01-04", ends: "2030-01-05" }];
    expect(schedule(daily(h(9), h(21)), holidays, ist("2030-01-01T10:00:00")))
      .toEqual({ open: true, nextOpening: ist("2030-01-06T09:00:00"), nextClosing: ist("2030-01-01T21:00:00") });
    expect(schedule(daily(h(9), h(21)), holidays, ist("2030-01-03T10:00:00")).open).toBe(false);
  });

  it("closes a holiday from 12:00 AM to 12:00 AM, cutting ranges that run past midnight on either side", () => {
    // 10:00 PM – 2:00 AM every day, with Wednesday 2 Jan off: Tuesday's range stops at midnight, Wednesday's opens at Thursday's.
    const holidays = [{ starts: "2030-01-02", ends: "2030-01-02" }];
    expect(schedule(daily(h(22), h(2)), holidays, ist("2030-01-01T23:00:00")))
      .toEqual({ open: true, nextOpening: ist("2030-01-03T00:00:00"), nextClosing: ist("2030-01-02T00:00:00") });
    expect(schedule(daily(h(22), h(2)), holidays, ist("2030-01-02T01:00:00")).open).toBe(false);
    expect(schedule(daily(h(22), h(2)), holidays, ist("2030-01-03T01:00:00")).open).toBe(true);
    // A shop that never closes closes for the holiday and opens at the next midnight.
    expect(schedule(daily(0, 0), holidays, ist("2030-01-01T10:00:00")))
      .toEqual({ open: true, nextOpening: ist("2030-01-03T00:00:00"), nextClosing: ist("2030-01-02T00:00:00") });
  });

  it("looks past a week for the next opening after a long holiday", () => {
    expect(schedule(daily(h(9), h(21)), [{ starts: "2030-01-01", ends: "2030-01-20" }], ist("2030-01-01T10:00:00")))
      .toEqual({ open: false, nextOpening: ist("2030-01-21T09:00:00"), nextClosing: ist("2030-01-21T21:00:00") });
  });

  it("names today's holiday and the weekdays of the coming week that are holidays", () => {
    // Tuesday 1 Jan: Tuesday itself, Thursday 3 Jan, and Monday 7 Jan, the seventh day.
    const holidays = [{ starts: "2030-01-01", ends: "2030-01-01" }, { starts: "2030-01-03", ends: "2030-01-03" }, { starts: "2030-01-07", ends: "2030-01-09" }];
    expect(holidaysNear(holidays, ist("2030-01-01T10:00:00"))).toEqual({ today: true, week: [1, 2, 4] });
    expect(holidaysNear(holidays, ist("2030-01-02T10:00:00"))).toEqual({ today: false, week: [1, 2, 4] });
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

describe("Holidays (#382)", () => {
  const holidays = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me/shop-holidays", headers });
  const add = (headers: Record<string, string>, starts: string, ends = starts) =>
    app.inject({ method: "POST", url: "/v1/me/shop-holidays", headers, payload: { starts, ends } });
  const edit = (headers: Record<string, string>, id: string, starts: string, ends = starts) =>
    app.inject({ method: "PUT", url: `/v1/me/shop-holidays/${id}`, headers, payload: { starts, ends } });
  const remove = (headers: Record<string, string>, id: string) => app.inject({ method: "DELETE", url: `/v1/me/shop-holidays/${id}`, headers });
  const dates = (list: Array<{ starts: string; ends: string }>) => list.map(({ starts, ends }) => `${starts} ${ends}`);
  const idOf = async (headers: Record<string, string>, starts: string) =>
    ((await holidays(headers)).json().upcoming as Array<{ id: string; starts: string }>).find((holiday) => holiday.starts === starts)?.id ?? "";

  it("adds, edits and removes whole days from today to 180 days ahead, never overlapping, and keeps ended ones as a record", async () => {
    const owner = await shop("approved");
    await move(owner, "2030-01-01T10:00:00");
    expect((await add(owner.headers, "2030-01-05", "2030-01-06")).statusCode).toBe(200);
    expect((await add(owner.headers, "2030-01-07")).statusCode).toBe(200);
    // The window: not before today, not past 180 days ahead.
    expect((await add(owner.headers, "2029-12-31")).json().error).toEqual({ code: "VALIDATION_FAILED", fields: ["starts"] });
    expect((await add(owner.headers, "2030-06-30")).statusCode).toBe(200);
    expect((await add(owner.headers, "2030-07-01")).json().error).toEqual({ code: "VALIDATION_FAILED", fields: ["ends"] });
    expect((await add(owner.headers, "2030-01-03", "2030-01-02")).statusCode).toBe(400);
    expect((await add(owner.headers, "2030-01-06", "2030-01-08")).json().error.code).toBe("HOLIDAY_OVERLAP");

    const sixth = await idOf(owner.headers, "2030-01-05");
    expect((await edit(owner.headers, sixth, "2030-01-07")).json().error.code).toBe("HOLIDAY_OVERLAP");
    // Editing may keep its own dates or move within them.
    const edited = await edit(owner.headers, sixth, "2030-01-04", "2030-01-06");
    expect(dates(edited.json().upcoming)).toEqual(["2030-01-04 2030-01-06", "2030-01-07 2030-01-07", "2030-06-30 2030-06-30"]);
    expect(dates((await remove(owner.headers, await idOf(owner.headers, "2030-06-30"))).json().upcoming)).toHaveLength(2);

    // Once ended, a holiday moves to the record, latest first, and can no longer change.
    await move(owner, "2030-01-08T10:00:00");
    const list = (await holidays(owner.headers)).json();
    expect(list.upcoming).toEqual([]);
    expect(dates(list.past)).toEqual(["2030-01-07 2030-01-07", "2030-01-04 2030-01-06"]);
    expect((await edit(owner.headers, list.past[0].id, "2030-01-10")).statusCode).toBe(404);
    expect((await remove(owner.headers, list.past[0].id)).statusCode).toBe(404);
  });

  it("allows 20 holidays not ended yet; ended ones don't count", async () => {
    const owner = await shop("approved");
    await move(owner, "2030-01-01T10:00:00");
    await add(owner.headers, "2030-01-01");
    for (let day = 10; day < 29; day++) expect((await add(owner.headers, `2030-01-${day}`)).statusCode).toBe(200);
    expect((await add(owner.headers, "2030-02-01")).json().error.code).toBe("TOO_MANY_HOLIDAYS");
    await move(owner, "2030-01-02T10:00:00");
    expect((await add(owner.headers, "2030-02-01")).statusCode).toBe(200);
  });

  it("keeps the start of a holiday under way, and removing it ends it yesterday", async () => {
    const owner = await shop("approved");
    await move(owner, "2030-01-01T10:00:00");
    await add(owner.headers, "2030-01-01", "2030-01-05");
    await move(owner, "2030-01-03T10:00:00");
    const id = await idOf(owner.headers, "2030-01-01");
    expect((await edit(owner.headers, id, "2030-01-03", "2030-01-05")).json().error.fields).toEqual(["starts"]);
    expect((await edit(owner.headers, id, "2030-01-01", "2030-01-02")).json().error.fields).toEqual(["ends"]);
    expect(dates((await edit(owner.headers, id, "2030-01-01", "2030-01-08")).json().upcoming)).toEqual(["2030-01-01 2030-01-08"]);
    const removed = (await remove(owner.headers, id)).json();
    expect(removed.upcoming).toEqual([]);
    expect(dates(removed.past)).toEqual(["2030-01-01 2030-01-02"]);
    // One that starts today is simply gone.
    await add(owner.headers, "2030-01-03");
    expect((await remove(owner.headers, await idOf(owner.headers, "2030-01-03"))).json().upcoming).toEqual([]);
  });

  it("closes a Live shop on its holidays; the Owner can still open, and a change to today cancels the switch", async () => {
    const owner = await shop("live");
    await setHours(owner.headers, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: h(9), closes: h(21) })));
    await move(owner, "2030-01-01T10:00:00");
    await add(owner.headers, "2030-01-01", "2030-01-10");
    expect((await status(owner.headers)).json()).toEqual({
      open: false, until: iso("2030-01-11T09:00:00"), setByOwner: false, scheduledOpen: false, nextOpening: iso("2030-01-11T09:00:00"),
    });
    // Opening on a holiday takes an end no later than the next opening, ten days on.
    expect((await turn(owner.headers, { open: true })).statusCode).toBe(400);
    expect((await turn(owner.headers, { open: true, until: iso("2030-01-11T09:30:00") })).statusCode).toBe(400);
    expect((await turn(owner.headers, { open: true, until: iso("2030-01-01T18:00:00") })).json()).toMatchObject({ open: true, setByOwner: true });

    // A change to later days leaves the switch alone.
    const id = await idOf(owner.headers, "2030-01-01");
    await edit(owner.headers, id, "2030-01-01", "2030-01-04");
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: true, until: iso("2030-01-01T18:00:00") });
    // Removing the holiday that covers today cancels it: the hours say open until 9:00 PM.
    await remove(owner.headers, id);
    expect((await status(owner.headers)).json()).toMatchObject({ open: true, setByOwner: false, until: iso("2030-01-01T21:00:00") });

    // Adding one for today cancels a running close the same way.
    await turn(owner.headers, { open: false });
    await add(owner.headers, "2030-01-01");
    expect((await status(owner.headers)).json()).toMatchObject({ open: false, setByOwner: false, until: iso("2030-01-02T09:00:00") });
  });

  it("is for the Owner of an Approved or Live shop only", async () => {
    const owner = await shop("approved");
    const staff = await signIn("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, owner.shopId]);
    expect((await holidays(staff.headers)).statusCode).toBe(404);
    expect((await add(staff.headers, "2030-01-02")).statusCode).toBe(404);
    const early = await shop("submitted", "early@example.com");
    expect((await holidays(early.headers)).json().error.code).toBe("SHOP_NOT_APPROVED");
    expect((await add(early.headers, "2030-01-02")).json().error.code).toBe("SHOP_NOT_APPROVED");
    expect((await holidays({})).statusCode).toBe(401);
    // Another shop's holiday is not found.
    await add(owner.headers, "2030-01-02");
    const other = await shop("approved", "other@example.com");
    expect((await remove(other.headers, await idOf(owner.headers, "2030-01-02"))).statusCode).toBe(404);
  });
});
