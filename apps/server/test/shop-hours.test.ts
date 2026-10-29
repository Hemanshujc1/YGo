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
const adminEmail = "admin@example.com";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { authorization: string };

beforeEach(async () => {
  name = `ygo_hours_${randomUUID().replaceAll("-", "")}`;
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
  return { ...owner, shopId };
}

const h = (hours: number) => hours * 60;
const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me/shop-hours", headers });
const save = (headers: Record<string, string>, ranges: object[]) => app.inject({ method: "PUT", url: "/v1/me/shop-hours", headers, payload: { ranges } });

describe("Opening hours (#371)", () => {
  it("starts empty, saves the whole week and replaces it on the next save", async () => {
    const owner = await shop();
    expect((await get(owner.headers)).json()).toEqual({ ranges: [] });

    const week = [
      { weekday: 7, opens: h(22), closes: h(2) },
      { weekday: 1, opens: h(16), closes: h(22) },
      { weekday: 1, opens: h(9), closes: h(13) },
      { weekday: 2, opens: 0, closes: 0 },
    ];
    const saved = await save(owner.headers, week);
    expect(saved.statusCode).toBe(200);
    // By day, then opening time; Sunday's past-midnight range runs into Monday before 9:00 AM.
    const sorted = { ranges: [week[2], week[1], week[3], week[0]] };
    expect(saved.json()).toEqual(sorted);
    expect((await get(owner.headers)).json()).toEqual(sorted);

    const replaced = [{ weekday: 3, opens: h(8), closes: h(20) }];
    expect((await save(owner.headers, replaced)).json()).toEqual({ ranges: replaced });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM shop_hours")).rows[0]).toEqual({ n: 1 });
  });

  it("refuses overlaps, a fourth range a day, off-step times and an empty week, keeping what was saved", async () => {
    const owner = await shop("live");
    await save(owner.headers, [{ weekday: 1, opens: h(9), closes: h(21) }]);
    for (const ranges of [
      [{ weekday: 1, opens: h(9), closes: h(13) }, { weekday: 1, opens: h(12), closes: h(17) }],
      [{ weekday: 3, opens: h(22), closes: h(3) }, { weekday: 4, opens: h(2), closes: h(10) }],
      [{ weekday: 7, opens: h(20), closes: h(1) }, { weekday: 1, opens: 0, closes: h(9) }],
      [0, 2, 4, 6].map((start) => ({ weekday: 5, opens: h(start), closes: h(start + 1) })),
      [{ weekday: 1, opens: h(9) + 15, closes: h(21) }],
      [],
    ]) {
      const refused = await save(owner.headers, ranges);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect((await get(owner.headers)).json()).toEqual({ ranges: [{ weekday: 1, opens: h(9), closes: h(21) }] });
  });

  it("lets only the Owner of an Approved or Live shop read and save", async () => {
    const owner = await shop();
    const staff = await signIn("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, owner.shopId]);
    const monday = [{ weekday: 1, opens: h(9), closes: h(21) }];
    expect((await save(staff.headers, monday)).statusCode).toBe(404);
    expect((await get(staff.headers)).statusCode).toBe(404);
    expect((await save((await signIn("nobody@example.com")).headers, monday)).statusCode).toBe(404);

    const early = await shop("under_review", "early@example.com");
    expect((await save(early.headers, monday)).json().error.code).toBe("SHOP_NOT_APPROVED");
    expect((await get(early.headers)).json().error.code).toBe("SHOP_NOT_APPROVED");
    expect((await save({}, monday)).statusCode).toBe(401);
    expect((await save(admin, monday)).statusCode).toBe(403);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM shop_hours")).rows[0]).toEqual({ n: 0 });
  });
});
