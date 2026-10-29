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

async function category(categoryName: string, parentId: string | null = null) {
  // The migrations seed the top categories (CAT-5), so reuse one that exists.
  const found = await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2", [categoryName, parentId]);
  const row = found.rows[0] ? found : await database.pool.query<{ id: string }>("INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING id", [categoryName, parentId]);
  return row.rows[0]?.id ?? "";
}

/** A published product with one listed pack per entry; `stock` records an opening stock in base units. */
async function product(shopId: string, categoryId: string, productName: string, baseUnit: "each" | "kg",
  packs: Array<{ quantity: string; price: string; mrp: string; stock?: string; available?: boolean }>) {
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($1, $2, $3, $4, true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [productName, categoryId, baseUnit, baseUnit === "each" ? "counted" : "measured"]);
  const productId = row.rows[0]?.id ?? "";
  const listings: string[] = [];
  for (const pack of packs) {
    const packRow = await database.pool.query<{ id: string }>("INSERT INTO packs (product_id, quantity) VALUES ($1, $2) RETURNING id", [productId, pack.quantity]);
    const listing = await database.pool.query<{ id: string }>(
      `INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, available)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`, [shopId, packRow.rows[0]?.id, pack.price, pack.mrp, pack.available ?? true]);
    const listingId = listing.rows[0]?.id ?? "";
    if (pack.stock !== undefined) {
      await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) VALUES ($1, $2, $3, 'opening', $4)",
        [listingId, randomUUID(), randomUUID(), pack.stock]);
    }
    listings.push(listingId);
  }
  return { productId, listings };
}

const page = (id: string, query = "pincode=411038&latitude=18.5&longitude=73.8", headers: Record<string, string> = customer) =>
  app.inject({ method: "GET", url: `/v1/shops/${id}?${query}`, headers });

describe("Customer shop page (#370, DSC-2, DSC-4)", () => {
  it("shows the terms, then products under their top category with prices, discounts and stock", async () => {
    const id = await shop("Near Dairy", 300);
    await publish({ type: "global" }, card);
    await publish({ type: "shop", id }, { minimumCart: "150.5" });
    const groceries = await category("Groceries");
    const pulses = await category("Pulses", groceries);
    const stationery = await category("Stationery");
    const switchedOff = await category("Toys");
    await database.pool.query("UPDATE categories SET active = false WHERE id = $1", [switchedOff]);

    const dal = await product(id, pulses, "Toor Dal", "kg", [
      { quantity: "1", price: "135", mrp: "150", stock: "4" }, // 10% off
      { quantity: "0.5", price: "70", mrp: "70", stock: "0" }, // no discount, out of stock at zero
    ]);
    const atta = await product(id, groceries, "atta", "kg", [{ quantity: "5", price: "199.99", mrp: "200", stock: "10" }]); // 0.005% off rounds to 0
    const pen = await product(id, stationery, "Pen", "each", [{ quantity: "1", price: "10", mrp: "10" }]); // no stock recorded
    await product(id, groceries, "Hidden Rice", "kg", [{ quantity: "1", price: "60", mrp: "60", stock: "3", available: false }]);
    await product(id, switchedOff, "Ball", "each", [{ quantity: "1", price: "50", mrp: "50", stock: "3" }]);
    const unpublished = await product(id, groceries, "Draft Sugar", "kg", [{ quantity: "1", price: "45", mrp: "45", stock: "3" }]);
    await database.pool.query("UPDATE master_products SET published = false WHERE id = $1", [unpublished.productId]);

    const response = await page(id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      shop: { id, name: "Near Dairy", estimatedMinutes: 15, deliveryFee: "30", minimumOrder: "150.5", fssaiNumber: "11223344556677" },
      groups: [
        { category: "Groceries", products: [
          { id: atta.productId, name: "atta", brand: null, baseUnit: "kg", packs: [
            { listingId: atta.listings[0], quantity: "5", price: "199.99", mrp: "200.00", discountPercent: 0, outOfStock: false },
          ] },
          { id: dal.productId, name: "Toor Dal", brand: null, baseUnit: "kg", packs: [
            { listingId: dal.listings[1], quantity: "0.5", price: "70.00", mrp: null, discountPercent: null, outOfStock: true },
            { listingId: dal.listings[0], quantity: "1", price: "135.00", mrp: "150.00", discountPercent: 10, outOfStock: false },
          ] },
        ] },
        { category: "Stationery", products: [
          { id: pen.productId, name: "Pen", brand: null, baseUnit: "each", packs: [
            { listingId: pen.listings[0], quantity: "1", price: "10.00", mrp: null, discountPercent: null, outOfStock: true },
          ] },
        ] },
      ],
    });
  });

  it("answers 404 wherever the feed would leave the shop out, and refuses a bad query, the admin web and no sign-in", async () => {
    const id = await shop("Edge Stores", 2500);
    const approved = await shop("Approved Stores", 100, { state: "approved" });
    await publish({ type: "global" }, card);
    expect((await page(id)).statusCode).toBe(404); // beyond its radius
    await database.pool.query("UPDATE shops SET service_radius_metres = 3000 WHERE id = $1", [id]);
    expect((await page(id)).statusCode).toBe(200);
    expect((await page(approved)).statusCode).toBe(404);
    expect((await page(randomUUID())).statusCode).toBe(404);
    await database.pool.query("UPDATE areas SET paused = true WHERE id = $1", [shopAreaId]);
    expect((await page(id)).statusCode).toBe(404);
    await database.pool.query("UPDATE areas SET paused = false WHERE id = $1", [shopAreaId]);
    await publish({ type: "global" }, { ...card, minimumCart: undefined });
    expect((await page(id)).json()).toEqual({ error: { code: "NOT_FOUND" } });

    expect((await page("not-a-uuid")).statusCode).toBe(400);
    expect((await page(id, "pincode=411038")).statusCode).toBe(400);
    expect((await page(id, undefined, admin)).statusCode).toBe(403);
    expect((await page(id, undefined, {})).statusCode).toBe(401);
  });
});
