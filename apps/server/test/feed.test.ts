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
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
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
      { id: near, name: "Near Dairy", estimatedMinutes: 15, deliveryFee: "25.5", open: true, opensAt: null, holiday: false },
      { id: far, name: "Far Kirana", estimatedMinutes: 20, deliveryFee: "30", open: true, opensAt: null, holiday: false },
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
  packs: Array<{ quantity: string; price: string; mrp: string; stock?: string; available?: boolean }>, brand: string | null = null) {
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, brand, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($1, $5, $2, $3, $4, true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [productName, categoryId, baseUnit, baseUnit === "each" ? "counted" : "measured", brand]);
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
    const atta = await product(id, groceries, "atta", "kg", [
      { quantity: "5", price: "199.99", mrp: "200", stock: "10" }, // 0.005% off rounds up to 0.01
      { quantity: "10", price: "60", mrp: "65", stock: "5" }, // 7.69% off (#411)
    ]);
    const pen = await product(id, stationery, "Pen", "each", [{ quantity: "1", price: "10", mrp: "10" }]); // no stock recorded
    await product(id, groceries, "Hidden Rice", "kg", [{ quantity: "1", price: "60", mrp: "60", stock: "3", available: false }]);
    await product(id, switchedOff, "Ball", "each", [{ quantity: "1", price: "50", mrp: "50", stock: "3" }]);
    const unpublished = await product(id, groceries, "Draft Sugar", "kg", [{ quantity: "1", price: "45", mrp: "45", stock: "3" }]);
    await database.pool.query("UPDATE master_products SET published = false WHERE id = $1", [unpublished.productId]);

    const response = await page(id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      // No hours yet counts as open (owner's answer 8 on #371); 1 Jan 2030 is a Tuesday.
      shop: {
        id, name: "Near Dairy", estimatedMinutes: 15, deliveryFee: "30", open: true, opensAt: null, holiday: false,
        minimumOrder: "150.5", fssaiNumber: "11223344556677", closesAt: null, hours: [], today: 2, holidays: [],
      },
      groups: [
        { category: "Groceries", products: [
          { id: atta.productId, name: "atta", brand: null, baseUnit: "kg", packs: [
            { listingId: atta.listings[0], quantity: "5", price: "199.99", mrp: "200.00", discountPercent: "0.01", outOfStock: false },
            { listingId: atta.listings[1], quantity: "10", price: "60.00", mrp: "65.00", discountPercent: "7.69", outOfStock: false },
          ] },
          { id: dal.productId, name: "Toor Dal", brand: null, baseUnit: "kg", packs: [
            { listingId: dal.listings[1], quantity: "0.5", price: "70.00", mrp: null, discountPercent: null, outOfStock: true },
            { listingId: dal.listings[0], quantity: "1", price: "135.00", mrp: "150.00", discountPercent: "10.00", outOfStock: false },
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

/** A time in India. 1 Jan 2030 is a Tuesday. */
const ist = (local: string) => new Date(`${local}+05:30`);
const iso = (local: string) => ist(local).toISOString();
const h = (hours: number) => hours * 60;

/** Moves the clock to a time in India and signs the Customer in again, as tokens last 15 minutes. */
async function at(local: string) {
  clock.set(ist(local));
  customer = await signIn("/v1/auth", "customer@example.com");
}

async function setHours(shopId: string, ranges: Array<[weekday: number, opens: number, closes: number]>) {
  for (const [weekday, opens, closes] of ranges) {
    await database.pool.query("INSERT INTO shop_hours (shop_id, weekday, opens, closes) VALUES ($1, $2, $3, $4)", [shopId, weekday, opens, closes]);
  }
}

describe("Open or closed for Customers (#381)", () => {
  it("lists open shops first, then closed ones with their next opening, nearest first in each", async () => {
    const tonight = await shop("Tonight Stores", 300);
    const pastMidnight = await shop("Late Kirana", 800);
    const friday = await shop("Friday Mart", 1000);
    const open = await shop("Day Dairy", 1500);
    await shop("New Stores", 1800);
    await publish({ type: "global" }, card);
    await setHours(tonight, [[2, h(18), h(22)]]);
    await setHours(pastMidnight, [[1, h(22), h(2)], [3, h(9), h(21)]]);
    await setHours(friday, [[5, h(9), h(21)]]);
    await setHours(open, [[2, h(9), h(21)]]);

    const listed = async () => ((await feed()).json().shops as Array<{ name: string; open: boolean; opensAt: string | null }>)
      .map(({ name, open, opensAt }) => [name, open, opensAt]);
    await at("2030-01-01T10:00:00");
    expect(await listed()).toEqual([
      ["Day Dairy", true, null],
      ["New Stores", true, null],
      ["Tonight Stores", false, iso("2030-01-01T18:00:00")],
      ["Late Kirana", false, iso("2030-01-02T09:00:00")],
      ["Friday Mart", false, iso("2030-01-04T09:00:00")],
    ]);

    // The Owner's switch overrides the hours both ways (#380).
    await database.pool.query("UPDATE shops SET open_override = false, open_override_until = $2 WHERE id = $1", [open, ist("2030-01-02T09:00:00")]);
    await database.pool.query("UPDATE shops SET open_override = true, open_override_until = $2 WHERE id = $1", [tonight, ist("2030-01-01T12:00:00")]);
    await at("2030-01-01T10:30:00");
    expect((await listed()).map(([name, isOpen, opensAt]) => `${String(name)} ${String(isOpen)} ${String(opensAt)}`)).toEqual([
      "Tonight Stores true null",
      "New Stores true null",
      "Late Kirana false " + iso("2030-01-02T09:00:00"),
      "Friday Mart false " + iso("2030-01-04T09:00:00"),
      "Day Dairy false " + iso("2030-01-02T09:00:00"),
    ]);

    // A week on, both switches have ended; Monday's 10:00 PM – 2:00 AM is still open at 1:00 AM on Tuesday.
    await at("2030-01-08T01:00:00");
    expect((await listed()).slice(0, 3)).toEqual([["Late Kirana", true, null], ["New Stores", true, null], ["Tonight Stores", false, iso("2030-01-08T18:00:00")]]);
  });

  it("gives the shop page the week's hours, today and when it next closes or opens", async () => {
    const id = await shop("Day Dairy", 300);
    await publish({ type: "global" }, card);
    await setHours(id, [[2, h(13), h(17)], [2, h(9), h(13)], [7, h(22), h(2)]]);
    await at("2030-01-01T10:00:00");
    expect((await page(id)).json().shop).toMatchObject({
      open: true, opensAt: null, closesAt: iso("2030-01-01T17:00:00"), today: 2,
      hours: [{ weekday: 2, opens: h(9), closes: h(13) }, { weekday: 2, opens: h(13), closes: h(17) }, { weekday: 7, opens: h(22), closes: h(2) }],
    });
    await at("2030-01-01T18:00:00");
    expect((await page(id)).json().shop).toMatchObject({ open: false, opensAt: iso("2030-01-06T22:00:00"), closesAt: null });
  });

  it("marks a shop closed for a holiday on C04 and C05, with the opening after it even beyond a week (#382)", async () => {
    const id = await shop("Day Dairy", 300);
    await publish({ type: "global" }, card);
    await setHours(id, [1, 2, 3, 4, 5, 6, 7].map((weekday): [number, number, number] => [weekday, h(9), h(21)]));
    // Tuesday 1 Jan to Thursday 10 Jan, then Saturday 12 Jan; 6 Jan is the Sunday of the coming week.
    await database.pool.query(
      "INSERT INTO shop_holidays (shop_id, starts, ends) VALUES ($1, '2030-01-01', '2030-01-10'), ($1, '2030-01-12', '2030-01-12')", [id]);
    await at("2030-01-01T10:00:00");
    expect((await feed()).json().shops).toEqual([expect.objectContaining({ open: false, holiday: true, opensAt: iso("2030-01-11T09:00:00") })]);
    expect((await page(id)).json().shop).toMatchObject({ open: false, holiday: true, opensAt: iso("2030-01-11T09:00:00"), holidays: [1, 2, 3, 4, 5, 6, 7] });
    // Friday 11 Jan, after closing: closed for the night, not a holiday, and Saturday's holiday is in the week.
    await at("2030-01-11T22:00:00");
    expect((await page(id)).json().shop).toMatchObject({ open: false, holiday: false, opensAt: iso("2030-01-13T09:00:00"), holidays: [6] });
  });
});

const search = (q: string, headers: Record<string, string> = customer) =>
  app.inject({ method: "GET", url: `/v1/search?pincode=411038&latitude=18.5&longitude=73.8&q=${encodeURIComponent(q)}`, headers });
/** Each matching shop's name with its products as "name in|out", and how many more match. */
const found = async (q: string) => ((await search(q)).json().shops as Array<{ name: string; products: Array<{ name: string; inStock: boolean }>; moreProducts: number }>)
  .map(({ name, products, moreProducts }) => [name, products.map((item) => `${item.name} ${item.inStock ? "in" : "out"}`), moreProducts]);

describe("Customer search (#398, DSC-3)", () => {
  it("matches every typed word in a product's name, its brand or the shop's name, at word starts, through search terms and near spellings", async () => {
    const dairy = await shop("Near Dairy", 300);
    const kirana = await shop("Shree Kirana", 800);
    await shop("Edge Stores", 2500); // beyond its radius
    await publish({ type: "global" }, card);
    const groceries = await category("Groceries");
    await product(dairy, groceries, "Toned Milk", "each", [{ quantity: "1", price: "30", mrp: "30", stock: "5" }], "Amul");
    await product(dairy, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "135", mrp: "150", stock: "0" }, { quantity: "0.5", price: "70", mrp: "70" }]);
    await product(kirana, groceries, "Toor Dal", "kg", [{ quantity: "0.5", price: "70", mrp: "70", stock: "0" }, { quantity: "1", price: "130", mrp: "150", stock: "2" }], "Tata");
    await product(kirana, groceries, "Onion", "kg", [{ quantity: "1", price: "40", mrp: "40", stock: "9" }]);
    await product(kirana, groceries, "Sandal Soap", "each", [{ quantity: "1", price: "40", mrp: "40", stock: "9" }]);
    await product(kirana, groceries, "Tomato", "kg", [{ quantity: "1", price: "30", mrp: "30", stock: "9" }]);
    await product(kirana, groceries, "Crème Fraîche", "each", [{ quantity: "1", price: "90", mrp: "90", stock: "1" }]);
    await product(kirana, groceries, "Hidden Onion", "kg", [{ quantity: "1", price: "40", mrp: "40", stock: "9", available: false }]);

    // Word starts only: "dal" finds Toor Dal, not Sandal; a product is in stock when any pack is (owner's answers 1 and 3 on #398).
    expect(await found("dal")).toEqual([["Near Dairy", ["Toor Dal out"], 0], ["Shree Kirana", ["Toor Dal in"], 0]]);
    expect(await found("ON")).toEqual([["Shree Kirana", ["Onion in"], 0]]);
    // Brand, accents, a near spelling from 4 letters, and words split across the shop's name and a product.
    expect(await found("amul")).toEqual([["Near Dairy", ["Toned Milk in"], 0]]);
    expect(await found("creme")).toEqual([["Shree Kirana", ["Crème Fraîche in"], 0]]);
    expect(await found("tomatoe")).toEqual([["Shree Kirana", ["Tomato in"], 0]]);
    expect(await found("potato")).toEqual([]);
    expect(await found("onn")).toEqual([]); // under 4 letters a word must match as typed
    expect(await found("kirana dal")).toEqual([["Shree Kirana", ["Toor Dal in"], 0]]);
    expect(await found("milk dal")).toEqual([]);
    // A shop matched by its name alone shows just its card, and a name that only starts like the search doesn't hide its products.
    expect(await found("near dairy")).toEqual([["Near Dairy", [], 0]]);
    const milkman = await shop("Milkman Stores", 500);
    await product(milkman, groceries, "Toned Milk", "each", [{ quantity: "1", price: "30", mrp: "30", stock: "5" }], "Gokul");
    expect(await found("milk")).toEqual([["Near Dairy", ["Toned Milk in"], 0], ["Milkman Stores", ["Toned Milk in"], 0]]);
    expect(await found("milkman")).toEqual([["Milkman Stores", [], 0]]);

    // Search terms: one word, and a phrase only when all its words are typed (owner's answer 4 on #398).
    await database.pool.query("INSERT INTO search_terms (typed_word, catalog_word) VALUES ('kanda', 'onion'), ('arhar dal', 'toor dal')");
    expect(await found("Kanda")).toEqual([["Shree Kirana", ["Onion in"], 0]]);
    expect(await found("arhar dal")).toEqual([["Near Dairy", ["Toor Dal out"], 0], ["Shree Kirana", ["Toor Dal in"], 0]]);
    expect(await found("arhar")).toEqual([]);
    expect(await found("!!")).toEqual([]);
  });

  it("puts open shops first, shows up to 5 products A to Z with how many more, and follows the feed's rules", async () => {
    const closed = await shop("Near Dairy", 300);
    const open = await shop("Far Kirana", 1500);
    await publish({ type: "global" }, card);
    await setHours(closed, [[3, h(9), h(21)]]);
    const groceries = await category("Groceries");
    for (const [id, brand] of [[closed, "Daawat"], [open, "India Gate"]] as const) await product(id, groceries, "Rice", "kg", [{ quantity: "1", price: "60", mrp: "60", stock: "3" }], brand);
    for (const grain of ["Basmati", "Brown", "Jeera", "Kolam", "Sona", "Red"]) {
      await product(open, groceries, `${grain} Rice`, "kg", [{ quantity: "1", price: "60", mrp: "60", stock: "3" }]);
    }
    await at("2030-01-01T10:00:00");
    const response = await search("rice");
    expect(response.statusCode).toBe(200);
    const shops = response.json().shops as Array<Record<string, unknown>>;
    expect(shops[0]).toMatchObject({ id: open, name: "Far Kirana", estimatedMinutes: 20, deliveryFee: "30", open: true, opensAt: null, holiday: false, moreProducts: 2 });
    expect(await found("rice")).toEqual([
      ["Far Kirana", ["Basmati Rice in", "Brown Rice in", "Jeera Rice in", "Kolam Rice in", "Red Rice in"], 2],
      ["Near Dairy", ["Rice in"], 0],
    ]);
    expect(shops[1]).toMatchObject({ open: false, opensAt: iso("2030-01-02T09:00:00") });

    await database.pool.query("UPDATE areas SET paused = true WHERE id = $1", [shopAreaId]);
    expect(await found("rice")).toEqual([]);
  });

  it("refuses a search shorter than 2 or longer than 60 characters, the admin web and no sign-in", async () => {
    expect((await search(" a ")).statusCode).toBe(400);
    expect((await search("a".repeat(61))).statusCode).toBe(400);
    expect((await search("a".repeat(60))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/search?pincode=411038&latitude=18.5&longitude=73.8", headers: customer })).statusCode).toBe(400);
    expect((await search("rice", admin)).statusCode).toBe(403);
    expect((await search("rice", {})).statusCode).toBe(401);
  });
});
