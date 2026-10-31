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
import { OrderStatus } from "@ygo/contracts";
import { connectDatabase } from "../src/db";
import { stockOf } from "../src/listings";
import { canMove } from "../src/orders";

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
  name = `ygo_orders_${randomUUID().replaceAll("-", "")}`;
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

/** Sets a listing's stock by rewriting its movements, which the trigger otherwise keeps append-only. */
async function setStock(listingId: string | undefined, quantity: string) {
  await database.pool.query("ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_no_update_delete");
  await database.pool.query("UPDATE stock_movements SET quantity = $2 WHERE listing_id = $1", [listingId, quantity]);
  await database.pool.query("ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_no_update_delete");
}

const here = "pincode=411038&latitude=18.5&longitude=73.8";
const save = (shopId: string, revision: number, lines: Array<{ listingId: string | undefined; count: number }>, headers: Record<string, string> = customer) =>
  app.inject({ method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers, payload: { revision, lines } });
const place = (shopId: string, body: { revision: number; total: string; addressId: string }, headers: Record<string, string> = customer) =>
  app.inject({ method: "POST", url: `/v1/carts/${shopId}/order`, headers, payload: body });
const cancel = (orderId: string, headers: Record<string, string> = customer) =>
  app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel`, headers });

/** A saved address for `email`'s account, `northMetres` north of the Customer's spot; no pin when `northMetres` is null. */
async function address(email: string, northMetres: number | null = 0, flat = "Flat 4B") {
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
     SELECT id, CASE WHEN $2 = 'Flat 4B' THEN 'home' ELSE 'other' END, $2, 'Kothrud', '411038',
       CASE WHEN $3::float8 IS NULL THEN NULL ELSE ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, $3::float8, 0::float8)::geography END, now()
     FROM accounts WHERE email = $1 RETURNING id`, [email, flat, northMetres]);
  return row?.id ?? "";
}

/** A Live shop with an Owner whose phone is +919876500001, Toor Dal (1 kg, 10 in stock) and Atta (5 kg, 20 kg in stock). */
async function stocked() {
  const shopId = await shop("Sai General Stores", 300);
  await publish({ type: "global" }, { ...card, smallCartFee: { enabled: true, threshold: "200", amount: "15", cap: null, split: { platformPercentage: "100", shopPercentage: "0" } } });
  const groceries = await category("Groceries");
  const dal = (await product(shopId, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "135", mrp: "150", stock: "10" }])).listings[0] ?? "";
  const atta = (await product(shopId, groceries, "Atta", "kg", [{ quantity: "5", price: "199.99", mrp: "200", stock: "20" }], "Aashirvaad")).listings[0] ?? "";
  const owner = await signIn("/v1/auth", "owner@example.com");
  await database.pool.query("UPDATE accounts SET name = 'Asha', phone = '+919876500001' WHERE email = 'owner@example.com'");
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);
  return { shopId, dal, atta, owner, home: await address("customer@example.com") };
}

/** Saves the cart and places it at the total it showed. */
async function ordered(shopId: string, lines: Array<{ listingId: string; count: number }>, addressId: string, headers = customer) {
  const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers })).json() as { revision: number };
  const cart = (await save(shopId, revision, lines, headers)).json() as { revision: number; quote: { total: string } };
  return place(shopId, { revision: cart.revision, total: cart.quote.total, addressId }, headers);
}

const orderCount = async () => Number((await database.pool.query<{ count: string }>("SELECT count(*) FROM orders")).rows[0]?.count);

describe("Customer places an instant order (#424, CRT-2, MNY-7, ORD-5, ORD-7)", () => {
  it("places the cart for delivery, freezes every figure and line, and empties the cart", async () => {
    const { shopId, dal, atta, home } = await stocked();
    const placed = await ordered(shopId, [{ listingId: dal, count: 2 }, { listingId: atta, count: 1 }], home);
    expect(placed.statusCode).toBe(201);
    const order = placed.json() as { id: string };
    expect(order).toEqual({
      id: expect.any(String), number: 1001, status: "placed", placedAt: "2030-01-01T00:00:00.000Z",
      shop: { id: shopId, name: "Sai General Stores", phone: "+919876500001" },
      address: { label: "home", flat: "Flat 4B", areaLine: "Kothrud", pincode: "411038" },
      lines: [
        { name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, unitPrice: "135.00", lineTotal: "270.00" },
        { name: "Atta", brand: "Aashirvaad", baseUnit: "kg", quantity: "5", count: 1, part: null, unitPrice: "199.99", lineTotal: "199.99" },
      ],
      productValue: "469.99", deliveryFee: "30.00", smallCartFee: null, total: "499.99", rejectReason: null, answerExpired: false,
    });
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toEqual(order);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: other })).statusCode).toBe(404);

    // The engine's whole result and the rate-card version are kept; stock is taken in the listing's unit (kg).
    const { rows: [frozen] } = await database.pool.query<{ version: string; commission: string }>(
      "SELECT rate_card_version::text AS version, quote->>'commission' AS commission FROM orders WHERE id = $1", [order.id]);
    expect(frozen?.version).toBe("1");
    expect(frozen?.commission).toBeDefined();
    expect((await database.pool.query("SELECT trim_scale(stock_quantity)::text AS stock FROM order_lines WHERE order_id = $1 ORDER BY position", [order.id])).rows)
      .toEqual([{ stock: "2" }, { stock: "5" }]);
    expect((await database.pool.query("SELECT from_status, to_status, actor_role, reason_code, client_id FROM order_status_history WHERE order_id = $1", [order.id])).rows)
      .toEqual([{ from_status: null, to_status: "placed", actor_role: "customer", reason_code: null, client_id: null }]);

    // The cart is empty at a new revision; stock is only checked, not held (ORD-6).
    expect((await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json()).toMatchObject({ revision: 2, lines: [] });
    const later = await database.pool.query("UPDATE shop_listings SET online_price = 140 WHERE id = $1", [dal]);
    expect(later.rowCount).toBe(1);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ lines: [{ unitPrice: "135.00" }, {}], total: "499.99" });
  });

  it("takes the part of a pack from stock as the part bought (#377)", async () => {
    const { shopId, dal, atta, home } = await stocked();
    await setStock(atta, "2");
    const placed = await ordered(shopId, [{ listingId: dal, count: 3 }, { listingId: atta, count: 1 }], home);
    expect(placed.json()).toMatchObject({ lines: [{ count: 3, part: null }, { quantity: "5", count: 1, part: "2", unitPrice: "80.00", lineTotal: "80.00" }] });
    expect((await database.pool.query("SELECT trim_scale(stock_quantity)::text AS stock FROM order_lines ORDER BY position")).rows).toEqual([{ stock: "3" }, { stock: "2" }]);
  });

  it("refuses a changed revision or total with the cart as it is now, and places nothing", async () => {
    const { shopId, dal, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { revision: number; quote: { total: string } };
    expect(cart.quote.total).toBe("180.00");

    const stale = await place(shopId, { revision: 1, total: "165.00", addressId: home });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { revision: 1, quote: { total: "180.00" } } } });

    await save(shopId, 1, [{ listingId: dal, count: 2 }]);
    expect((await place(shopId, { revision: 1, total: "180.00", addressId: home })).json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { revision: 2, quote: { total: "300.00" } } } });

    // A price changed after C07 showed the total.
    await database.pool.query("UPDATE shop_listings SET online_price = 140 WHERE id = $1", [dal]);
    expect((await place(shopId, { revision: 2, total: "300.00", addressId: home })).json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { quote: { total: "310.00" } } } });
    expect(await orderCount()).toBe(0);
    expect((await place(shopId, { revision: 2, total: "310.00", addressId: home })).statusCode).toBe(201);
  });

  it("checks the cart again under its locks, so a price edit landing while the order is placed refuses it", async () => {
    const { shopId, dal, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    const edit = await database.pool.connect();
    try {
      await edit.query("BEGIN");
      await edit.query("UPDATE shop_listings SET online_price = 140 WHERE id = $1", [dal]);
      // Priced at the old price; then waits on the listing's lock until the edit commits.
      const placing = place(shopId, { revision: 1, total: cart.quote.total, addressId: home });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await edit.query("COMMIT");
      expect((await placing).json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { quote: { total: "185.00" } } } });
    } finally { edit.release(); }
    expect(await orderCount()).toBe(0);
  });

  it("answers a cart saved while placement waits on its lock with that newer cart, not the one first read", async () => {
    const { shopId, dal, atta, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    const edit = await database.pool.connect();
    try {
      await edit.query("BEGIN");
      const { rows: [locked] } = await edit.query<{ id: string }>(
        "SELECT carts.id FROM carts JOIN accounts ON accounts.id = carts.account_id WHERE accounts.email = 'customer@example.com' FOR UPDATE");
      // Reads revision 1 and its total, then waits on the cart's lock.
      const placing = place(shopId, { revision: 1, total: cart.quote.total, addressId: home });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // A save lands first, as the cart route writes one: 2 Atta in place of the Dal, at revision 2.
      await edit.query("DELETE FROM cart_lines WHERE cart_id = $1", [locked?.id]);
      await edit.query("INSERT INTO cart_lines (cart_id, listing_id, position, count) VALUES ($1, $2, 1, 2)", [locked?.id, atta]);
      await edit.query("UPDATE carts SET revision = 2 WHERE id = $1", [locked?.id]);
      await edit.query("COMMIT");
      const changed = await placing;
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ error: { code: "CART_CHANGED", cart: {
        revision: 2, lines: [{ listingId: atta, count: 2, lineTotal: "399.98" }], quote: { total: "429.98" }, placeable: true,
      } } });
    } finally { edit.release(); }
    expect(await orderCount()).toBe(0);
  });

  it("reads a cart's revision and lines from one snapshot, so a save landing between them can't mix the two", async () => {
    const { shopId, dal, atta, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    const edit = await database.pool.connect();
    try {
      await edit.query("BEGIN");
      // Holds back any read of the lines, but not of the cart row, while a save writes revision 2 with 2 Atta.
      await edit.query("LOCK TABLE cart_lines IN ACCESS EXCLUSIVE MODE");
      const { rows: [saved] } = await edit.query<{ id: string }>(
        "SELECT carts.id FROM carts JOIN accounts ON accounts.id = carts.account_id WHERE accounts.email = 'customer@example.com'");
      await edit.query("DELETE FROM cart_lines WHERE cart_id = $1", [saved?.id]);
      await edit.query("INSERT INTO cart_lines (cart_id, listing_id, position, count) VALUES ($1, $2, 1, 2)", [saved?.id, atta]);
      await edit.query("UPDATE carts SET revision = 2 WHERE id = $1", [saved?.id]);
      const placing = place(shopId, { revision: 1, total: cart.quote.total, addressId: home });
      const waiting = () => database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      for (let tries = 0; ((await waiting()).rows[0]?.n ?? 0) < 1; tries += 1) {
        if (tries > 100) throw new Error("Placement never waited on the lines");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await edit.query("COMMIT");
      expect((await placing).json()).toMatchObject({ error: { code: "CART_CHANGED", cart: {
        revision: 2, lines: [{ listingId: atta, count: 2 }], quote: { total: "429.98" },
      } } });
    } finally { edit.release(); }
    expect(await orderCount()).toBe(0);
  });

  it("refuses stock gone since the cart was saved, a closed or paused shop, and a cart that can't be ordered", async () => {
    const { shopId, dal, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    await setStock(dal, "0");
    expect((await place(shopId, { revision: 1, total: cart.quote.total, addressId: home })).json())
      .toMatchObject({ error: { code: "CART_CHANGED", cart: { placeable: false, reasons: [{ code: "LINE_UNAVAILABLE" }] } } });
    await setStock(dal, "10");
    await database.pool.query("UPDATE shops SET open_override = false, open_override_until = '2030-01-01T06:00:00Z' WHERE id = $1", [shopId]);
    expect((await place(shopId, { revision: 1, total: cart.quote.total, addressId: home })).json())
      .toMatchObject({ error: { code: "CART_CHANGED", cart: { placeable: false, reasons: [{ code: "SHOP_CLOSED" }] } } });
    await database.pool.query("UPDATE shops SET open_override = NULL, open_override_until = NULL WHERE id = $1", [shopId]);
    await database.pool.query("UPDATE areas SET paused = true WHERE name = 'Paud Road'");
    expect((await place(shopId, { revision: 1, total: cart.quote.total, addressId: home })).json())
      .toMatchObject({ error: { code: "CART_CHANGED", cart: { placeable: false, reasons: [{ code: "NOT_DELIVERING" }] } } });
    expect(await orderCount()).toBe(0);
  });

  it("checks the address on the server: the Customer's own, with a pin, inside the shop's radius", async () => {
    const { shopId, dal, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    const body = { revision: 1, total: cart.quote.total };
    expect((await place(shopId, { ...body, addressId: await address("other@example.com") })).statusCode).toBe(404);
    expect((await place(shopId, { ...body, addressId: await address("customer@example.com", null, "Flat 9") })).statusCode).toBe(404);
    // 2.6 km from the shop, outside its 2 km radius, though C07 was priced for a spot inside it.
    const far = await address("customer@example.com", -2300, "Flat 12");
    expect((await place(shopId, { ...body, addressId: far })).json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { reasons: [{ code: "NOT_DELIVERING" }] } } });
    expect((await place(shopId, { ...body, addressId: home })).statusCode).toBe(201);
  });

  it("lists for C07 only the Customer's pinned addresses the shop delivers to, newest first (#427)", async () => {
    const { shopId, home } = await stocked();
    const near = await address("customer@example.com", 500, "Flat 7");
    await address("customer@example.com", null, "Flat 9");
    await address("customer@example.com", -2300, "Flat 12");
    await address("other@example.com");
    await database.pool.query("UPDATE saved_addresses SET saved_at = now() + interval '1 minute' WHERE id = $1", [near]);
    const listed = await app.inject({ method: "GET", url: `/v1/me/addresses?shopId=${shopId}`, headers: customer });
    expect((listed.json() as { addresses: Array<{ id: string }> }).addresses.map((row) => row.id)).toEqual([near, home]);
    // Without a shop every address lists, as C15 shows them.
    expect((await app.inject({ method: "GET", url: "/v1/me/addresses", headers: customer })).json().addresses).toHaveLength(4);
    // A paused Area delivers nowhere.
    await database.pool.query("UPDATE areas SET paused = true WHERE name = 'Kothrud'");
    expect((await app.inject({ method: "GET", url: `/v1/me/addresses?shopId=${shopId}`, headers: customer })).json()).toEqual({ addresses: [] });
    expect((await app.inject({ method: "GET", url: "/v1/me/addresses?shopId=nope", headers: customer })).statusCode).toBe(400);
  });

  it("refuses the shop's own Owner or Staff, and their cart says why (ACC-9)", async () => {
    const { shopId, dal, owner } = await stocked();
    const ownHome = await address("owner@example.com");
    const cart = await save(shopId, 0, [{ listingId: dal, count: 1 }], owner);
    expect(cart.json()).toMatchObject({ placeable: false, reasons: [{ code: "OWN_SHOP" }] });
    const placed = await place(shopId, { revision: 1, total: "180.00", addressId: ownHome }, owner);
    expect(placed.statusCode).toBe(403);
    expect(placed.json()).toEqual({ error: { code: "OWN_SHOP" } });
  });

  it("numbers orders from one sequence, and of two placements of one cart only one lands", async () => {
    const { shopId, dal, atta, home } = await stocked();
    const otherHome = await address("other@example.com");
    const first = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    const second = (await save(shopId, 0, [{ listingId: atta, count: 1 }], other)).json() as { quote: { total: string } };
    const raced = await Promise.all([
      place(shopId, { revision: 1, total: first.quote.total, addressId: home }),
      place(shopId, { revision: 1, total: first.quote.total, addressId: home }),
      place(shopId, { revision: 1, total: second.quote.total, addressId: otherHome }, other),
    ]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 201, 409]);
    expect(raced.flatMap((response) => response.statusCode === 201 ? [(response.json() as { number: number }).number] : []).sort()).toEqual([1001, 1002]);
    expect(await orderCount()).toBe(2);
  });

  it("lets the Customer cancel for free only while the order is placed", async () => {
    const { shopId, dal, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    expect((await cancel(order.id, other)).statusCode).toBe(404);
    clock.set(new Date("2030-01-01T00:02:00.000Z"));
    const cancelled = await cancel(order.id);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: order.id, status: "cancelled_by_customer" });
    expect((await database.pool.query("SELECT from_status, to_status, actor_role, at FROM order_status_history WHERE order_id = $1 ORDER BY id", [order.id])).rows).toEqual([
      { from_status: null, to_status: "placed", actor_role: "customer", at: new Date("2030-01-01T00:00:00.000Z") },
      { from_status: "placed", to_status: "cancelled_by_customer", actor_role: "customer", at: new Date("2030-01-01T00:02:00.000Z") },
    ]);
    const again = await cancel(order.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
  });

  it("refuses any change to a frozen order but its status, and any delete of orders, lines or history", async () => {
    const { shopId, dal, home } = await stocked();
    const { id } = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const refused = (sql: string) => expect(database.pool.query(sql, [id])).rejects.toThrow(/frozen at placement|append-only/);
    await refused("UPDATE orders SET total = 1 WHERE id = $1");
    await refused("UPDATE orders SET quote = '{}' WHERE id = $1");
    await refused("UPDATE orders SET address_flat = 'Flat 1' WHERE id = $1");
    await refused("DELETE FROM orders WHERE id = $1");
    await refused("UPDATE order_lines SET unit_price = 1 WHERE order_id = $1");
    await refused("UPDATE order_lines SET stock_quantity = 0 WHERE order_id = $1");
    await refused("DELETE FROM order_lines WHERE order_id = $1");
    await refused("UPDATE order_status_history SET reason_code = 'x' WHERE order_id = $1");
    await refused("DELETE FROM order_status_history WHERE order_id = $1");
    await expect(database.pool.query("TRUNCATE order_lines, order_status_history, orders")).rejects.toThrow(/append-only|frozen/);
    expect((await database.pool.query("UPDATE orders SET status = 'accepted', status_changed_at = now() WHERE id = $1", [id])).rowCount).toBe(1);
  });
});

describe("Order transitions (#9)", () => {
  it("allows only the moves this ticket builds, each by its actor", () => {
    const roles = ["customer", "owner", "staff", "system"] as const;
    const allowed = OrderStatus.options.flatMap((from) => OrderStatus.options.flatMap((to) =>
      roles.filter((role) => canMove(from, to, role)).map((role) => `${from} → ${to} by ${role}`)));
    expect(allowed).toEqual([
      "placed → accepted by owner", "placed → accepted by staff", "placed → rejected_by_shop by owner", "placed → rejected_by_shop by staff",
      "placed → cancelled_by_customer by customer",
    ]);
  });
});

const accept = (orderId: string, headers: Record<string, string>) => app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers });
const reject = (orderId: string, headers: Record<string, string>, reason = "too_busy") =>
  app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/reject`, headers, payload: { reason } });
const at = (iso: string) => clock.set(new Date(iso));
/** Stock left to sell, as C05, search, the cart and placement read it. */
const left = async (listingId: string) =>
  (await database.pool.query<{ left: string }>(`SELECT trim_scale(${stockOf("l")})::text AS left FROM shop_listings l WHERE l.id = $1`, [listingId])).rows[0]?.left;
const history = async (orderId: string) => (await database.pool.query(
  "SELECT from_status, to_status, actor_role, reason_code FROM order_status_history WHERE order_id = $1 AND from_status IS NOT NULL", [orderId])).rows;

/** A Staff member of `shopId`; staff join shops by SQL until #58. */
async function staffOf(shopId: string, email = "staff@example.com") {
  const headers = await signIn("/v1/auth", email);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'staff' FROM accounts WHERE email = $2", [shopId, email]);
  return headers;
}

describe("Shop accepts or rejects an order (#425, ORD-2, ORD-7)", () => {
  it("lets the Owner accept: the status moves, history records who, and the stock is held for C05 and the cart", async () => {
    const { shopId, dal, owner, home } = await stocked();
    await setStock(dal, "3");
    const order = (await ordered(shopId, [{ listingId: dal, count: 2 }], home)).json() as { id: string };
    // Placing holds nothing (ORD-6).
    expect(await left(dal)).toBe("3");
    at("2030-01-01T00:03:00.000Z");
    const accepted = await accept(order.id, owner);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      id: order.id, number: 1001, status: "accepted", placedAt: "2030-01-01T00:00:00.000Z", expiresAt: null, now: "2030-01-01T00:03:00.000Z",
      address: { flat: "Flat 4B" }, lines: [{ name: "Toor Dal", count: 2 }], total: "300.00", rejectReason: null,
    });
    expect(await history(order.id)).toEqual([{ from_status: "placed", to_status: "accepted", actor_role: "owner", reason_code: null }]);
    expect(await left(dal)).toBe("1");
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ status: "accepted" });

    // C05 and the cart see 1 kg left; the other Customer can't add a second.
    const page = (await app.inject({ method: "GET", url: `/v1/shops/${shopId}?${here}`, headers: other })).json() as { groups: Array<{ products: Array<{ packs: Array<{ listingId: string; outOfStock: boolean }> }> }> };
    expect(page.groups.flatMap((group) => group.products.flatMap((item) => item.packs)).find((pack) => pack.listingId === dal)).toMatchObject({ outOfStock: false });
    expect((await save(shopId, 0, [{ listingId: dal, count: 2 }], other)).json()).toMatchObject({ lines: [{ listingId: dal, count: 1, left: 1 }] });
    await accept(((await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string }).id, owner);
    const empty = (await app.inject({ method: "GET", url: `/v1/shops/${shopId}?${here}`, headers: other })).json() as typeof page;
    expect(empty.groups.flatMap((group) => group.products.flatMap((item) => item.packs)).find((pack) => pack.listingId === dal)).toMatchObject({ outOfStock: true });
  });

  it("lets Staff reject with a reason, which C19 shows, and holds no stock", async () => {
    const { shopId, dal, home } = await stocked();
    const staff = await staffOf(shopId);
    const order = (await ordered(shopId, [{ listingId: dal, count: 2 }], home)).json() as { id: string };
    expect((await reject(order.id, staff, "maybe")).statusCode).toBe(400);
    const rejected = await reject(order.id, staff, "cannot_deliver");
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "rejected_by_shop", rejectReason: "cannot_deliver", expiresAt: null });
    expect(await history(order.id)).toEqual([{ from_status: "placed", to_status: "rejected_by_shop", actor_role: "staff", reason_code: "cannot_deliver" }]);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json())
      .toMatchObject({ status: "rejected_by_shop", rejectReason: "cannot_deliver" });
    expect(await left(dal)).toBe("10");
  });

  it("answers only the shop's own Owner or Staff, even once the shop isn't Live", async () => {
    const { shopId, dal, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const elsewhere = await shop("Other Stores", 600);
    const otherStaff = await staffOf(elsewhere, "otherstaff@example.com");
    for (const headers of [customer, other, otherStaff]) {
      expect((await accept(order.id, headers)).statusCode).toBe(404);
      expect((await reject(order.id, headers)).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/v1/me/shop-orders/${order.id}`, headers })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-orders", headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-orders", headers: otherStaff })).json()).toMatchObject({ new: [], accepted: [], doneToday: [] });
    // No longer Live after the order came in: it still gets an answer (owner's answer 13).
    await database.pool.query("UPDATE shops SET state = 'approved' WHERE id = $1", [shopId]);
    expect((await accept(order.id, await staffOf(shopId))).statusCode).toBe(200);
  });

  it("refuses to answer an order that isn't placed any more", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const cancelled = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await cancel(cancelled.id);
    const accepted = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await accept(accepted.id, owner);
    for (const id of [cancelled.id, accepted.id]) {
      expect((await accept(id, owner)).json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
      expect((await reject(id, owner)).json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
    }
    // The Customer can't cancel once it's accepted.
    expect((await cancel(accepted.id)).json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
    expect(await left(dal)).toBe("9");
  });

  it("refuses Accept and Reject from 600 s after placement, in the API itself", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const late = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const inTime = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    at("2030-01-01T00:09:59.999Z");
    expect((await accept(inTime.id, owner)).statusCode).toBe(200);
    at("2030-01-01T00:10:00.000Z");
    const expired = await accept(late.id, owner);
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: { code: "ORDER_EXPIRED" } });
    expect((await reject(late.id, owner)).json()).toEqual({ error: { code: "ORDER_EXPIRED" } });
    expect((await app.inject({ method: "GET", url: `/v1/me/shop-orders/${late.id}`, headers: owner })).json())
      .toMatchObject({ status: "placed", expiresAt: "2030-01-01T00:10:00.000Z", now: "2030-01-01T00:10:00.000Z" });
  });

  it("refuses a line that no longer fits the stock left, naming it, whole packs and parts alike", async () => {
    const { shopId, dal, atta, owner, home } = await stocked();
    const otherHome = await address("other@example.com");
    await setStock(dal, "3");
    await setStock(atta, "2");
    // A whole-pack line, and a part line: the last 2 kg of a 5 kg pack (#377).
    const first = (await ordered(shopId, [{ listingId: dal, count: 2 }], home)).json() as { id: string };
    const second = (await ordered(shopId, [{ listingId: dal, count: 2 }, { listingId: atta, count: 1 }], otherHome, other)).json() as { id: string; lines: unknown[] };
    expect(second.lines).toMatchObject([{ count: 2 }, { part: "2" }]);
    expect((await accept(first.id, owner)).statusCode).toBe(200);
    await setStock(atta, "1.5");
    const short = await accept(second.id, owner);
    expect(short.statusCode).toBe(409);
    expect(short.json()).toEqual({ error: { code: "NOT_ENOUGH_STOCK", shortLines: [
      { name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, available: "1" },
      { name: "Atta", brand: "Aashirvaad", baseUnit: "kg", quantity: "5", count: 1, part: "2", available: "1.5" },
    ] } });
    expect(await history(second.id)).toEqual([]);
    // A listing switched off since placement doesn't block Accept; the shop can still reject the short one.
    await database.pool.query("UPDATE shop_listings SET available = false WHERE id = $1", [dal]);
    await setStock(dal, "4");
    await setStock(atta, "2");
    expect((await accept(second.id, owner)).statusCode).toBe(200);
  });

  it("lets only one of two Accepts racing for the last stock through", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const staff = await staffOf(shopId);
    await setStock(dal, "1");
    const one = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const two = (await ordered(shopId, [{ listingId: dal, count: 1 }], await address("other@example.com"), other)).json() as { id: string };
    const hold = await database.pool.connect();
    try {
      // Holds the listing so both Accepts reach its lock before either checks stock.
      await hold.query("BEGIN");
      await hold.query("SELECT 1 FROM shop_listings WHERE id = $1 FOR UPDATE", [dal]);
      const racing = [accept(one.id, owner), accept(two.id, staff)];
      const waiting = () => database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      for (let tries = 0; ((await waiting()).rows[0]?.n ?? 0) < 2; tries += 1) {
        if (tries > 100) throw new Error("The Accepts never waited on the listing");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await hold.query("COMMIT");
      const answers = await Promise.all(racing);
      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
      expect(answers.find((answer) => answer.statusCode === 409)?.json()).toMatchObject({ error: { code: "NOT_ENOUGH_STOCK", shortLines: [{ available: "0" }] } });
    } finally { hold.release(); }
    expect(await left(dal)).toBe("0");
  });

  it("holds stock only in the five statuses from Accept to the door, so cancel, reject and expiry give it back", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 4 }], home)).json() as { id: string };
    await accept(order.id, owner);
    const held: string[] = [];
    for (const status of OrderStatus.options) {
      await database.pool.query("UPDATE orders SET status = $2, status_changed_at = now() WHERE id = $1", [order.id, status]);
      if (await left(dal) === "6") held.push(status);
      else expect(await left(dal)).toBe("10");
    }
    expect(held).toEqual(["accepted", "preparing", "ready", "out_for_delivery", "arrived"]);
  });

  it("lists S04's New, Accepted and Done today, by the last status change in India time", async () => {
    const { shopId, dal, atta, owner, home } = await stocked();
    // 05:30 IST: placed and never answered, so past its 600 s by the time S04 opens.
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    at("2030-01-01T00:11:00.000Z");
    const yesterday = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await cancel(yesterday.id);
    // Its last change falls at 23:50 IST the day before.
    await database.pool.query("UPDATE orders SET status_changed_at = '2029-12-31T18:20:00Z' WHERE id = $1", [yesterday.id]);
    const cancelled = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await cancel(cancelled.id);
    const accepted = (await ordered(shopId, [{ listingId: dal, count: 1 }, { listingId: atta, count: 1 }], home)).json() as { id: string };
    await accept(accepted.id, owner);
    const waiting = (await ordered(shopId, [{ listingId: dal, count: 3 }], home)).json() as { id: string; number: number };
    at("2030-01-01T00:12:00.000Z");
    const rejected = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await reject(rejected.id, owner);

    at("2030-01-01T00:13:00.000Z");
    const listed = (await app.inject({ method: "GET", url: "/v1/me/shop-orders", headers: owner })).json() as Record<string, Array<{ id: string }>>;
    expect(listed).toMatchObject({ now: "2030-01-01T00:13:00.000Z" });
    expect(listed.new).toEqual([{
      id: waiting.id, number: waiting.number, status: "placed", placedAt: "2030-01-01T00:11:00.000Z", expiresAt: "2030-01-01T00:21:00.000Z",
      itemCount: 1, total: "435.00", address: { flat: "Flat 4B", areaLine: "Kothrud" },
    }]);
    expect(listed.accepted).toMatchObject([{ id: accepted.id, itemCount: 2, expiresAt: null }]);
    expect(listed.doneToday?.map((row) => row.id)).toEqual([rejected.id, cancelled.id]);
  });
});

type StockItem = { listingId: string; quantity: string; held: string };
/** What the shop sees of a listing on Listings, Stock and the Stock sync after `since`. */
async function shopSees(listingId: string, owner: Record<string, string>, since?: string) {
  const listings = (await app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: owner })).json() as {
    items: Array<{ stock: string; held: string; listing: { id: string } | null }> };
  const stock = (await app.inject({ method: "GET", url: "/v1/me/stock", headers: owner })).json() as { items: StockItem[] };
  const sync = (await app.inject({ method: "GET", url: `/v1/sync/changes${since ? `?since=${since}` : ""}`, headers: owner })).json() as {
    cursor: string; changes: Array<{ item: StockItem | null }> };
  const listed = listings.items.find((item) => item.listing?.id === listingId);
  const counted = stock.items.find((item) => item.listingId === listingId);
  return {
    listings: { stock: listed?.stock, held: listed?.held },
    stock: { quantity: counted?.quantity, held: counted?.held },
    sync: sync.changes.flatMap((change) => change.item?.listingId === listingId ? [{ quantity: change.item.quantity, held: change.item.held }] : []),
    cursor: sync.cursor,
  };
}

describe("Shopkeeper sees stock left after accepted orders, with the held amount (#436)", () => {
  it("lowers the shop's figure by what an accepted order holds, the figure Customers get, and holds nothing for rejected or cancelled orders", async () => {
    const { shopId, dal, owner, home } = await stocked();
    await setStock(dal, "3");
    const first = await shopSees(dal, owner);
    expect(first).toMatchObject({ listings: { stock: "3.000", held: "0" }, stock: { quantity: "3.000", held: "0" }, sync: [{ quantity: "3.000", held: "0" }] });

    const kept = (await ordered(shopId, [{ listingId: dal, count: 2 }], home)).json() as { id: string };
    const rejected = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const cancelled = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    expect((await accept(kept.id, owner)).statusCode).toBe(200);
    expect((await reject(rejected.id, owner)).statusCode).toBe(200);
    expect((await cancel(cancelled.id)).statusCode).toBe(200);

    // The next pull resends the item, so the phone's saved Stock picks up the hold.
    expect(await shopSees(dal, owner, first.cursor)).toMatchObject({
      listings: { stock: "1.000", held: "2.000" }, stock: { quantity: "1.000", held: "2.000" }, sync: [{ quantity: "1.000", held: "2.000" }],
    });
    expect(await left(dal)).toBe("1");
    // Opening stock still records what's on hand.
    expect((await database.pool.query("SELECT kind, quantity FROM stock_movements WHERE listing_id = $1", [dal])).rows).toEqual([{ kind: "opening", quantity: "3.000" }]);
  });

  it("gives the stock back when an accepted order leaves the holding statuses", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 4 }], home)).json() as { id: string };
    await accept(order.id, owner);
    const holding = await shopSees(dal, owner);
    expect(holding.listings).toEqual({ stock: "6.000", held: "4.000" });
    // No route moves an accepted order on yet (#55, #56), so set the status as one will.
    await database.pool.query("UPDATE orders SET status = 'cancelled_by_shop' WHERE id = $1", [order.id]);
    expect(await shopSees(dal, owner, holding.cursor)).toMatchObject({
      listings: { stock: "10.000", held: "0" }, stock: { quantity: "10.000", held: "0" }, sync: [{ quantity: "10.000", held: "0" }],
    });
  });

  it("resends a Stock item saved before #436, which has no held amount, on the next pull, then only on a change", async () => {
    const { dal, owner } = await stocked();
    const { cursor } = await shopSees(dal, owner);
    await database.pool.query("UPDATE stock_sync_items SET payload = payload - 'held'");
    const refreshed = await shopSees(dal, owner, cursor);
    expect(refreshed.sync).toEqual([{ quantity: "10.000", held: "0" }]);
    expect((await shopSees(dal, owner, refreshed.cursor)).sync).toEqual([]);
  });
});

describe("Customer's order list (#426, ORD-1)", () => {
  const list = (headers: Record<string, string> = customer) => app.inject({ method: "GET", url: "/v1/orders", headers });
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  const move = (orderId: string, status: OrderStatus) => database.pool.query("UPDATE orders SET status = $2 WHERE id = $1", [orderId, status]);

  it("lists active orders first, those waiting on the Customer on top, then past ones, newest first, and only the Customer's own", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const one = async () => ((await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string; number: number });
    const cancelled = await one();
    await cancel(cancelled.id);
    const accepted = await one();
    await accept(accepted.id, owner);
    const arrived = await one();
    await move(arrived.id, "arrived");
    at("2030-01-01T00:01:00.000Z");
    const rejected = await one();
    await reject(rejected.id, owner);
    const waiting = await one();
    // Placed in the same instant as `waiting`: the higher number comes first.
    const confirm = await one();
    await move(confirm.id, "awaiting_customer_confirm");
    const theirs = (await ordered(shopId, [{ listingId: dal, count: 1 }], await address("other@example.com"), other)).json() as { id: string };

    const listed = await list();
    expect(listed.statusCode).toBe(200);
    const { active, past } = listed.json() as { active: Array<{ id: string }>; past: Array<{ id: string }> };
    expect(ids(active)).toEqual([confirm.id, arrived.id, waiting.id, accepted.id]);
    expect(ids(past)).toEqual([rejected.id, cancelled.id]);
    expect(active[2]).toEqual({
      id: waiting.id, number: waiting.number, status: "placed", placedAt: "2030-01-01T00:01:00.000Z",
      shop: { id: shopId, name: "Sai General Stores", phone: "+919876500001" }, total: "180.00", answerExpired: false,
    });
    expect(ids((await list(other)).json().active)).toEqual([theirs.id]);
  });

  it("moves a placed order past its answer time to past, still placed, and says so on C19 too", async () => {
    const { shopId, dal, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string; answerExpired: boolean };
    expect(order.answerExpired).toBe(false);
    at("2030-01-01T00:09:59.999Z");
    expect(ids((await list()).json().active)).toEqual([order.id]);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ answerExpired: false });

    // The moment Accept starts refusing (ORDER_EXPIRED).
    at("2030-01-01T00:10:00.000Z");
    const listed = (await list()).json() as { active: unknown[]; past: Array<{ id: string; status: string; answerExpired: boolean }> };
    expect(listed.active).toEqual([]);
    expect(listed.past).toMatchObject([{ id: order.id, status: "placed", answerExpired: true }]);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ status: "placed", answerExpired: true });
    // Cancel refuses from the same moment, as C19 hides it, so the order ends as the shop not answering.
    const cancelled = await cancel(order.id);
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json()).toEqual({ error: { code: "ORDER_EXPIRED" } });
    expect((await database.pool.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows).toEqual([{ status: "placed" }]);
  });

  it("refuses a Cancel that waits on the order's lock past the answer time, reading the time after the lock", async () => {
    const { shopId, dal, home } = await stocked();
    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    at("2030-01-01T00:09:59.000Z");
    const hold = await database.pool.connect();
    try {
      // Holds the order row, as an Accept in flight would, so Cancel arrives in time but waits on the lock.
      await hold.query("BEGIN");
      await hold.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [order.id]);
      const cancelling = cancel(order.id);
      const waiting = () => database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      for (let tries = 0; ((await waiting()).rows[0]?.n ?? 0) < 1; tries += 1) {
        if (tries > 100) throw new Error("Cancel never waited on the order");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The deadline passes while Cancel waits.
      at("2030-01-01T00:10:00.000Z");
      await hold.query("COMMIT");
      const cancelled = await cancelling;
      expect(cancelled.statusCode).toBe(409);
      expect(cancelled.json()).toEqual({ error: { code: "ORDER_EXPIRED" } });
    } finally { hold.release(); }
    expect((await database.pool.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows).toEqual([{ status: "placed" }]);
    expect(await history(order.id)).toEqual([]);
  });

  it("shows the newest 50 past orders and every active one, and an empty list for a Customer with none", async () => {
    expect((await list()).json()).toEqual({ active: [], past: [] });
    const { shopId, dal, home } = await stocked();
    const oldest = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await cancel(oldest.id);
    await database.pool.query(
      `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, address_label, address_flat, address_area_line,
         address_pincode, address_point, product_value, delivery_fee, small_cart_fee, total, rate_card_version, quote)
       SELECT account_id, shop_id, 'cancelled_by_customer', placed_at + g * interval '1 second', status_changed_at, address_label, address_flat,
         address_area_line, address_pincode, address_point, product_value, delivery_fee, small_cart_fee, total, rate_card_version, quote
       FROM orders, generate_series(1, 50) AS g WHERE id = $1`, [oldest.id]);
    at("2030-01-01T00:02:00.000Z");
    const waiting = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const listed = (await list()).json() as { active: Array<{ id: string }>; past: Array<{ id: string }> };
    expect(ids(listed.active)).toEqual([waiting.id]);
    expect(listed.past).toHaveLength(50);
    expect(ids(listed.past)).not.toContain(oldest.id);
  });
});

it("refuses placement after a manual flag without changing stock, and permits it once cleared", async () => {
  const { shopId, dal, home } = await stocked();
  const cart = (await save(shopId, 0, [{ listingId: dal, count: 2 }])).json();
  await database.pool.query("UPDATE shop_listings SET out_of_stock = true WHERE id = $1", [dal]);
  const refused = await place(shopId, { revision: 1, total: cart.quote.total, addressId: home });
  expect(refused.json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { placeable: false, lines: [{ state: "outOfStock" }] } } });
  expect(await orderCount()).toBe(0);
  await database.pool.query("UPDATE shop_listings SET out_of_stock = false WHERE id = $1", [dal]);
  expect((await place(shopId, { revision: 1, total: cart.quote.total, addressId: home })).statusCode).toBe(201);
  expect((await database.pool.query("SELECT sum(quantity)::text AS quantity FROM stock_movements WHERE listing_id = $1", [dal])).rows[0]?.quantity).toBe("10.000");
});
