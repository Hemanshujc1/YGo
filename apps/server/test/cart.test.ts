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
let customer: { authorization: string };
let other: { authorization: string };

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_cart_${randomUUID().replaceAll("-", "")}`;
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
  other = await signIn("/v1/auth", "other@example.com");
  const area = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Kothrud') RETURNING id");
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1)", [area.rows[0]?.id]);
  const shopArea = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Paud Road') RETURNING id");
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1)", [shopArea.rows[0]?.id]);
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

const here = "pincode=411038&latitude=18.5&longitude=73.8";
const read = (shopId: string, headers: Record<string, string> = customer, query = here) =>
  app.inject({ method: "GET", url: `/v1/carts/${shopId}?${query}`, headers });
const save = (shopId: string, revision: number, lines: Array<{ listingId: string | undefined; count: number }>, headers: Record<string, string> = customer, query = here) =>
  app.inject({ method: "PUT", url: `/v1/carts/${shopId}?${query}`, headers, payload: { revision, lines } });
const dalLine = (listingId: string | undefined, count: number, more: object = {}) => ({
  listingId, name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", price: "135.00", count, state: "orderable", left: null, lineTotal: null, ...more,
});

/** A Live shop with a complete card, Toor Dal (1 kg, 10 in stock) and Atta (5 kg, 20 kg in stock: 4 packs). */
async function stocked() {
  const shopId = await shop("Sai General Stores", 300);
  await publish({ type: "global" }, { ...card, smallCartFee: { enabled: true, threshold: "200", amount: "15", cap: null, split: { platformPercentage: "100", shopPercentage: "0" } } });
  const groceries = await category("Groceries");
  const dal = (await product(shopId, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "135", mrp: "150", stock: "10" }])).listings[0];
  const atta = (await product(shopId, groceries, "Atta", "kg", [{ quantity: "5", price: "199.99", mrp: "200", stock: "20" }])).listings[0];
  return { shopId, dal, atta };
}

describe("Server cart and quote (#405, CRT-1, CRT-2, CRT-4, CRT-5)", () => {
  it("saves the whole cart and answers with the server's quote, every fee named and no commission", async () => {
    const { shopId, dal, atta } = await stocked();
    expect((await read(shopId)).json()).toEqual({ shop: { id: shopId, name: "Sai General Stores" }, revision: 0, lines: [], quote: null, placeable: false, reasons: [] });

    const saved = await save(shopId, 0, [{ listingId: dal, count: 2 }, { listingId: atta, count: 1 }]);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      shop: { id: shopId, name: "Sai General Stores" }, revision: 1,
      lines: [
        dalLine(dal, 2, { lineTotal: "270.00" }),
        { listingId: atta, name: "Atta", brand: null, baseUnit: "kg", quantity: "5", price: "199.99", count: 1, state: "orderable", left: null, lineTotal: "199.99" },
      ],
      quote: { productValue: "469.99", deliveryFee: "30.00", smallCartFee: null, total: "499.99" },
      placeable: true, reasons: [],
    });
    expect((await read(shopId)).json()).toEqual(saved.json());

    // Below the small-cart threshold its fee is named before checkout (CRT-5).
    expect((await save(shopId, 1, [{ listingId: dal, count: 1 }])).json()).toMatchObject({
      revision: 2, quote: { productValue: "135.00", deliveryFee: "30.00", smallCartFee: "15.00", total: "180.00" }, placeable: true,
    });
    // Emptying the cart keeps its revision going.
    expect((await save(shopId, 2, [])).json()).toMatchObject({ revision: 3, lines: [], quote: null, placeable: false });
  });

  it("refuses a save based on an older revision, and of two racing saves only one lands", async () => {
    const { shopId, dal, atta } = await stocked();
    await save(shopId, 0, [{ listingId: dal, count: 1 }]);
    const stale = await save(shopId, 0, [{ listingId: atta, count: 1 }]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: { code: "CART_CHANGED" } });
    expect((await read(shopId)).json()).toMatchObject({ revision: 1, lines: [{ listingId: dal, count: 1 }] });

    const raced = await Promise.all([save(shopId, 1, [{ listingId: dal, count: 2 }]), save(shopId, 1, [{ listingId: dal, count: 3 }])]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = raced.find((response) => response.statusCode === 200)?.json() as { lines: unknown };
    expect((await read(shopId)).json()).toMatchObject({ revision: 2, lines: winner.lines });

    // Two first saves of a new cart race the same way.
    const firsts = await Promise.all([save(shopId, 0, [{ listingId: dal, count: 1 }], other), save(shopId, 0, [{ listingId: atta, count: 1 }], other)]);
    expect(firsts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it("reads prices on the server, so a changed price changes the next quote", async () => {
    const { shopId, dal } = await stocked();
    await save(shopId, 0, [{ listingId: dal, count: 2 }]);
    await database.pool.query("UPDATE shop_listings SET online_price = 140 WHERE id = $1", [dal]);
    expect((await read(shopId)).json()).toMatchObject({
      lines: [{ price: "140.00", lineTotal: "280.00" }], quote: { productValue: "280.00", total: "310.00" },
    });
    // The body carries no price to trust.
    const priced = await app.inject({ method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer, payload: { revision: 1, lines: [{ listingId: dal, count: 1, price: "1" }] } });
    expect(priced.statusCode).toBe(400);
  });

  it("holds a count at stock, keeps an out-of-stock or no-longer-sold line out of the quote, and reserves nothing", async () => {
    const { shopId, dal, atta } = await stocked();
    // 20 kg of a 5 kg pack is 4 packs.
    expect((await save(shopId, 0, [{ listingId: dal, count: 1 }, { listingId: atta, count: 9 }])).json()).toMatchObject({
      lines: [{ count: 1, left: null }, { count: 4, left: 4, lineTotal: "799.96" }], placeable: true,
    });
    // Another Customer can fill a cart with the same stock: nothing is reserved.
    expect((await save(shopId, 0, [{ listingId: atta, count: 4 }], other)).json()).toMatchObject({ lines: [{ count: 4, left: 4 }] });

    // Stock falls to 1 pack: the count shown follows it.
    await database.pool.query("ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_no_update_delete");
    await database.pool.query("UPDATE stock_movements SET quantity = 5 WHERE listing_id = $1", [atta]);
    expect((await read(shopId)).json()).toMatchObject({ lines: [{ count: 1 }, { count: 1, left: 1, lineTotal: "199.99" }], quote: { productValue: "334.99" } });

    // None left: the line stays, unpriced, and the cart can't be ordered until it's removed (CRT-4).
    await database.pool.query("UPDATE stock_movements SET quantity = 4.999 WHERE listing_id = $1", [atta]);
    await database.pool.query("ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_no_update_delete");
    expect((await read(shopId)).json()).toMatchObject({
      revision: 1, lines: [{ count: 1, state: "orderable" }, { count: 4, state: "outOfStock", left: null, lineTotal: null }],
      quote: { productValue: "135.00" }, placeable: false, reasons: [{ code: "LINE_UNAVAILABLE" }],
    });
    // A pack the shop stops selling is marked the same way, and can be kept or removed but not newly added.
    await database.pool.query("UPDATE shop_listings SET available = false WHERE id = $1", [dal]);
    expect((await read(shopId)).json()).toMatchObject({
      lines: [{ state: "unavailable", lineTotal: null }, { state: "outOfStock" }], quote: null, placeable: false, reasons: [{ code: "LINE_UNAVAILABLE" }],
    });
    expect((await save(shopId, 1, [{ listingId: dal, count: 2 }])).statusCode).toBe(200);
    expect((await save(shopId, 0, [{ listingId: dal, count: 1 }], await signIn("/v1/auth", "third@example.com"))).statusCode).toBe(404);
    expect((await save(shopId, 2, [])).json()).toMatchObject({ lines: [], reasons: [] });
  });

  it("takes only this shop's packs, and each Customer sees only their own cart", async () => {
    const { shopId, dal } = await stocked();
    const nextDoor = await shop("Next Door", 500);
    const milk = (await product(nextDoor, await category("Groceries"), "Milk", "each", [{ quantity: "1", price: "30", mrp: "30", stock: "5" }])).listings[0];
    expect((await save(shopId, 0, [{ listingId: milk, count: 1 }])).json()).toEqual({ error: { code: "NOT_FOUND" } });
    expect((await save(shopId, 0, [{ listingId: randomUUID(), count: 1 }])).statusCode).toBe(404);
    expect((await read(shopId)).json()).toMatchObject({ revision: 0, lines: [] });

    await save(shopId, 0, [{ listingId: dal, count: 2 }]);
    expect((await read(shopId, other)).json()).toMatchObject({ revision: 0, lines: [] });
    await save(shopId, 0, [{ listingId: dal, count: 5 }], other);
    expect((await read(shopId)).json()).toMatchObject({ revision: 1, lines: [{ count: 2 }] });
    // One cart per shop: the other shop's cart is separate (CRT-1).
    expect((await save(nextDoor, 0, [{ listingId: milk, count: 1 }])).json()).toMatchObject({ shop: { name: "Next Door" }, revision: 1 });
    expect((await read(shopId)).json()).toMatchObject({ lines: [{ listingId: dal }] });
  });

  it("names the minimum order's shortfall and the contribution floor without a figure, at their boundaries", async () => {
    const shopId = await shop("Sai General Stores", 300);
    await publish({ type: "global" }, card);
    const groceries = await category("Groceries");
    const biscuit = (await product(shopId, groceries, "Biscuit", "each", [{ quantity: "1", price: "99.99", mrp: "100", stock: "10" }])).listings[0];
    const toffee = (await product(shopId, groceries, "Toffee", "each", [{ quantity: "1", price: "0.01", mrp: "1", stock: "10" }])).listings[0];
    expect((await save(shopId, 0, [{ listingId: biscuit, count: 1 }])).json()).toMatchObject({
      quote: { productValue: "99.99" }, placeable: false, reasons: [{ code: "BELOW_MINIMUM_CART", shortfall: "0.01" }],
    });
    expect((await save(shopId, 1, [{ listingId: biscuit, count: 1 }, { listingId: toffee, count: 1 }])).json()).toMatchObject({
      quote: { productValue: "100.00" }, placeable: true, reasons: [],
    });
    // At 100.00 YGo earns 10.00 commission and 6.00 of the delivery fee: 16.00.
    await publish({ type: "shop", id: shopId }, { deliveredContributionFloor: "16" });
    expect((await read(shopId)).json()).toMatchObject({ placeable: true, reasons: [] });
    await publish({ type: "shop", id: shopId }, { deliveredContributionFloor: "16.01" });
    const below = (await read(shopId)).json() as { placeable: boolean; reasons: unknown[] };
    expect(below).toMatchObject({ placeable: false });
    expect(below.reasons).toEqual([{ code: "BELOW_CONTRIBUTION_FLOOR" }]);
  });

  it("still prices a closed shop, and keeps a cart for a shop that can't deliver here without pricing it", async () => {
    const { shopId, dal, atta } = await stocked();
    await save(shopId, 0, [{ listingId: dal, count: 2 }]);
    await database.pool.query("UPDATE shops SET open_override = false, open_override_until = '2030-01-01T04:00:00Z' WHERE id = $1", [shopId]);
    expect((await read(shopId)).json()).toMatchObject({
      quote: { total: "300.00" }, placeable: false, reasons: [{ code: "SHOP_CLOSED", opensAt: "2030-01-01T04:00:00.000Z" }],
    });

    // 3 km away the shop can't deliver: the cart is shown unpriced, can be emptied, but takes nothing new.
    const far = "pincode=411038&latitude=18.473&longitude=73.8";
    expect((await read(shopId, customer, far)).json()).toMatchObject({
      shop: { name: "Sai General Stores" }, lines: [{ listingId: dal, count: 2, state: "orderable", lineTotal: null }],
      quote: null, placeable: false, reasons: [{ code: "NOT_DELIVERING" }],
    });
    expect((await save(shopId, 1, [{ listingId: dal, count: 2 }, { listingId: atta, count: 1 }], customer, far)).statusCode).toBe(404);
    expect((await save(shopId, 1, [{ listingId: dal, count: 1 }], customer, far)).statusCode).toBe(200);
    // With no cart there, a shop that can't deliver is not found, as on the shop page.
    expect((await read(shopId, other, far)).statusCode).toBe(404);
    expect((await save(shopId, 0, [], other, far)).statusCode).toBe(404);
    expect((await read(randomUUID())).statusCode).toBe(404);
  });

  it("refuses requests that aren't a signed-in Customer's whole, valid cart", async () => {
    const { shopId, dal } = await stocked();
    expect((await read(shopId, {})).statusCode).toBe(401);
    expect((await save(shopId, 0, [{ listingId: dal, count: 1 }], admin)).statusCode).toBe(403);
    for (const lines of [[{ listingId: dal, count: 0 }], [{ listingId: dal, count: 1000 }], [{ listingId: dal, count: 1 }, { listingId: dal, count: 2 }]]) {
      expect((await save(shopId, 0, lines)).statusCode).toBe(400);
    }
    expect((await read(shopId, customer, "pincode=411038")).statusCode).toBe(400);
    expect((await read(shopId)).json()).toMatchObject({ revision: 0 });
  });
});
