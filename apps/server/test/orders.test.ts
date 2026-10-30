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
  const cart = (await save(shopId, 0, lines, headers)).json() as { revision: number; quote: { total: string } };
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
      productValue: "469.99", deliveryFee: "30.00", smallCartFee: null, total: "499.99",
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

  it("refuses stock gone since the cart was saved, a closed or paused shop, and a cart that can't be ordered", async () => {
    const { shopId, dal, home } = await stocked();
    const cart = (await save(shopId, 0, [{ listingId: dal, count: 1 }])).json() as { quote: { total: string } };
    await setStock(dal, "0");
    expect((await place(shopId, { revision: 1, total: cart.quote.total, addressId: home })).json())
      .toMatchObject({ error: { code: "CART_CHANGED", cart: { placeable: false, reasons: [{ code: "LINE_UNAVAILABLE" }] } } });
    await setStock(dal, "10");
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
    expect(allowed).toEqual(["placed → cancelled_by_customer by customer"]);
  });
});
