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
import { estimatedMinutes } from "../src/routes/feed";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const adminEmail = "admin@example.com";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { authorization: string };
let customer: { authorization: string };
let areaId: string;
let shopAreaId: string;

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_feed_${randomUUID().replaceAll("-", "")}`;
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
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signIn("/v1/admin/auth", adminEmail);
  customer = await signIn("/v1/auth", "customer@example.com");
  const area = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Kothrud') RETURNING id");
  areaId = area.rows[0]?.id ?? "";
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1)", [areaId]);
  const shopArea = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Paud Road') RETURNING id");
  shopAreaId = shopArea.rows[0]?.id ?? "";
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1)", [shopAreaId]);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

/** A shop `northMetres` north of the Customer, in pincode 411045 (another Area: DSC-1 doesn't need the Customer's). */
async function shop(shopName: string, northMetres: number, options: { state?: string; radius?: number; fssaiExpiry?: string } = {}) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, $2, $3, 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, $4::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', $5, 'asha@upi', $6, now(), now())`,
    [id, options.state ?? "live", shopName, northMetres, options.fssaiExpiry ?? "2031-03-31", options.radius ?? 2000]);
  return id;
}

async function publish(scope: object, values: object) {
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope, values, reason: "Pilot card" } });
  expect(response.statusCode).toBe(201);
}

const card = {
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};

const feed = (query = "pincode=411038&latitude=18.5&longitude=73.8", headers: Record<string, string> = customer) =>
  app.inject({ method: "GET", url: `/v1/feed?${query}`, headers });
const names = async () => ((await feed()).json().shops as Array<{ name: string }>).map((listed) => listed.name);

describe("Customer feed (#369, DSC-1, DSC-2, ONB-4)", () => {
  it("rounds 10 minutes plus 4 a km up to the next 5", () => {
    expect([0, 1, 1250, 1500, 2500, 5000].map(estimatedMinutes)).toEqual([10, 15, 15, 20, 20, 30]);
  });

  it("lists Live shops nearest first with time and delivery fee, each rule leaving a shop out", async () => {
    const far = await shop("Far Kirana", 1500);
    const near = await shop("Near Dairy", 300);
    const outOfRange = await shop("Edge Stores", 2500);
    await shop("Approved Stores", 100, { state: "approved" });
    const expired = await shop("Expired Stores", 200, { fssaiExpiry: "2030-01-01" });
    expect(await names()).toEqual([]);

    await publish({ type: "global" }, card);
    await publish({ type: "shop", id: near }, { deliveryFee: { amount: "25.5", split: { platformPercentage: "20", shopPercentage: "80" } } });
    expect((await feed()).json()).toEqual({ shops: [
      { id: near, name: "Near Dairy", estimatedMinutes: 15, deliveryFee: "25.5" },
      { id: far, name: "Far Kirana", estimatedMinutes: 20, deliveryFee: "30" },
    ] });

    // The shop's own radius decides, up to 5 km; an FSSAI expiring tomorrow still lists.
    await database.pool.query("UPDATE shops SET service_radius_metres = 3000 WHERE id = $1", [outOfRange]);
    await database.pool.query("UPDATE shops SET fssai_expiry = '2030-01-02' WHERE id = $1", [expired]);
    expect(await names()).toEqual(["Expired Stores", "Near Dairy", "Far Kirana", "Edge Stores"]);

    // A card that becomes incomplete takes the shop out, unless its own card fills the gap (ONB-4).
    await publish({ type: "global" }, { ...card, minimumCart: undefined });
    await publish({ type: "shop", id: far }, { minimumCart: "50" });
    expect(await names()).toEqual(["Far Kirana"]);
    await publish({ type: "global" }, card);

    // A paused Area, or a pincode in none, lists nothing even with shops in range (DSC-5).
    await database.pool.query("UPDATE areas SET paused = true WHERE id = $1", [areaId]);
    expect(await names()).toEqual([]);
    await database.pool.query("UPDATE areas SET paused = false WHERE id = $1", [areaId]);
    expect((await feed("pincode=411001&latitude=18.5&longitude=73.8")).json()).toEqual({ shops: [] });
    expect(await names()).toHaveLength(4);

    // The shop's own Area paused, or its pincode in no Area, takes it out too (owner's answer 13 on #47).
    await database.pool.query("UPDATE areas SET paused = true WHERE id = $1", [shopAreaId]);
    expect(await names()).toEqual([]);
    await database.pool.query("UPDATE areas SET paused = false WHERE id = $1", [shopAreaId]);
    await database.pool.query("DELETE FROM area_pincodes WHERE pincode = '411045'");
    expect(await names()).toEqual([]);
  });

  it("refuses a bad query, the admin web and no sign-in", async () => {
    expect((await feed("pincode=411038&latitude=50&longitude=73.8")).statusCode).toBe(400);
    expect((await feed("pincode=411038")).statusCode).toBe(400);
    expect((await feed(undefined, admin)).statusCode).toBe(403);
    expect((await feed(undefined, {})).statusCode).toBe(401);
  });
});
