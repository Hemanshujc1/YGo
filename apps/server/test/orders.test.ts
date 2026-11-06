import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import type { DeliveryPhotoStorage } from "../src/adapters/delivery-photos";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { OrderStatus } from "@ygo/contracts";
import { connectDatabase } from "../src/db";
import { stockOf } from "../src/listings";
import { createLocalPushSender, type PushResult, type PushSender, type ReceiptResult } from "../src/adapters/push-sender";
import { checkPushReceipts, sendDuePushes } from "../src/notifications";
import { cleanupDeliveryProofs, cleanupDeliveryUploads, runJob } from "../src/jobs";
import { setOrderTiming } from "../src/order-timing";
import { canMove } from "../src/orders";
import { createTestDatabase } from "./test-database";

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
const deliveryPhotos = {
  createUpload: async () => ({ id: randomUUID(), uploadUrl: "https://upload.example.test/photo" }),
  save: async (orderId: string, _accountId: string, id: string) => { savedProofs.push(id); return `delivery-proofs/${orderId}/${id}.jpg`; },
  deleteUpload: async (_orderId: string, _accountId: string, id: string) => { deletedUploads.push(id); },
  deleteProof: async () => {},
  deleteStagedProof: async () => {},
} as DeliveryPhotoStorage;
const deletedUploads: string[] = [];
const savedProofs: string[] = [];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_orders_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  deletedUploads.length = 0;
  savedProofs.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, deliveryPhotos, deliveryPhotoSaveTimeoutMs: 300 });
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
      handoverCode: null, itemsCheckedAt: null,
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
    await expect(database.pool.query("TRUNCATE ring_attempts, delivery_photo_uploads, order_lines, order_status_history, push_queue, notifications, orders")).rejects.toThrow(/append-only|frozen/);
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
      "placed → expired by system", "placed → cancelled_by_customer by customer",
      "accepted → preparing by owner", "accepted → preparing by staff", "accepted → ready by owner", "accepted → ready by staff",
      "accepted → cancelled_by_shop by owner", "accepted → cancelled_by_shop by staff",
      "preparing → ready by owner", "preparing → ready by staff", "preparing → cancelled_by_shop by owner", "preparing → cancelled_by_shop by staff",
      "ready → out_for_delivery by owner", "ready → out_for_delivery by staff", "ready → picked_up by owner", "ready → picked_up by staff",
      "ready → cancelled_by_shop by owner", "ready → cancelled_by_shop by staff",
      "out_for_delivery → arrived by owner", "out_for_delivery → arrived by staff",
      "arrived → delivered by owner", "arrived → delivered by staff", "arrived → delivery_failed by owner", "arrived → delivery_failed by staff",
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
      delivererId: null,
    }]);
    expect(listed.accepted).toMatchObject([{ id: accepted.id, itemCount: 2, expiresAt: null }]);
    expect(listed.doneToday?.map((row) => row.id)).toEqual([rejected.id, cancelled.id]);
  });
});

describe("Shop delivery (#56, DLV-1 to DLV-7)", () => {
  async function readyAtDoor(shopId: string, dal: string, home: string, owner: Record<string, string>, legacy = false) {
    const placed = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await accept(placed.id, owner);
    if (legacy) await database.pool.query("UPDATE orders SET handover_code_hash = NULL, handover_code_salt = NULL, handover_code_ciphertext = NULL WHERE id = $1", [placed.id]);
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${placed.id}/preparing`, headers: owner });
    const { rows: [member] } = await database.pool.query<{ accountId: string }>("SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    await app.inject({ method: "PUT", url: `/v1/me/shop-orders/${placed.id}/ready`, headers: owner, payload: { accountId: member?.accountId } });
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${placed.id}/out-for-delivery`, headers: owner });
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${placed.id}/arrived`, headers: owner });
    return placed.id;
  }

  async function photo(orderId: string, owner: Record<string, string>) {
    const answer = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivery-photo-upload`, headers: owner,
      payload: { contentType: "image/jpeg", byteLength: 100 } });
    expect(answer.statusCode).toBe(201);
    return answer.json() as { id: string; uploadUrl: string };
  }

  it("confirms the item check, completes handover with a proof photo, and records one stock sale", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const before = await shopSees(dal, owner);
    const orderId = await readyAtDoor(shopId, dal, home, owner, true);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: customer })).json().handoverCode).toBeNull();
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const handoverCode = checked.json().handoverCode as string;
    expect(handoverCode).toMatch(/^\d{4}$/);
    const upload = await photo(orderId, owner);
    const complete = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
      payload: { handoverCode, payment: "cash", photoUploadId: upload.id } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ status: "delivered", deliveryPhotoAvailable: true, deliveryFailureReadyAt: null });
    expect(deletedUploads).toContain(upload.id);
    expect((await database.pool.query("SELECT delivery_photo_expires_at FROM orders WHERE id = $1", [orderId])).rows[0]?.delivery_photo_expires_at)
      .toEqual(new Date("2030-01-31T00:00:00.000Z"));
    expect(await shopSees(dal, owner, before.cursor)).toMatchObject({
      listings: { stock: "9.000", held: "0" }, stock: { quantity: "9.000", held: "0" }, sync: [{ quantity: "9.000", held: "0" }],
    });
    const customerPage = (await app.inject({ method: "GET", url: `/v1/shops/${shopId}?pincode=411038&latitude=18.5&longitude=73.8`, headers: customer })).json() as {
      groups: Array<{ products: Array<{ packs: Array<{ listingId: string; outOfStock: boolean }> }> }> };
    expect(customerPage.groups.flatMap((group) => group.products).flatMap((product) => product.packs)
      .find((pack) => pack.listingId === dal)?.outOfStock).toBe(false);
    const sales = await database.pool.query<{ quantity: string }>("SELECT quantity FROM stock_movements WHERE client_id = $1 AND kind = 'sale'", [orderId]);
    expect(sales.rows).toEqual([{ quantity: "-1.000" }]);
    expect(await left(dal)).toBe("9");
  });

  describe("receipt (#61)", () => {
    async function delivered(payment: "cash" | "upi" = "cash") {
      const { shopId, dal, owner, home } = await stocked();
      const orderId = await readyAtDoor(shopId, dal, home, owner);
      const code = (await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer })).json().handoverCode as string;
      const upload = await photo(orderId, owner);
      const done = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner, payload: { handoverCode: code, payment, photoUploadId: upload.id } });
      expect(done.statusCode).toBe(200);
      return { shopId, orderId };
    }
    const receipt = (orderId: string, headers = customer) => app.inject({ method: "GET", url: `/v1/orders/${orderId}/receipt`, headers });

    it("returns the frozen lines and amounts, the shop as it is, and how it was paid", async () => {
      const { orderId } = await delivered("upi");
      await database.pool.query("UPDATE shops SET address = 'Shop 3, Paud Road', pincode = '411038'");
      const answer = await receipt(orderId);
      expect(answer.statusCode).toBe(200);
      const frozen = (await app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: customer })).json();
      expect(answer.json()).toEqual({
        number: frozen.number, status: "delivered", placedAt: frozen.placedAt, address: { label: frozen.address.label, areaLine: frozen.address.areaLine }, shop: { name: frozen.shop.name, address: "Shop 3, Paud Road", pincode: "411038" },
        lines: frozen.lines, productValue: frozen.productValue, deliveryFee: frozen.deliveryFee, smallCartFee: frozen.smallCartFee, total: frozen.total, payment: "upi",
      });
    });

    it("also serves a picked-up order, and shows no payment method when none was recorded", async () => {
      const { orderId } = await delivered();
      await database.pool.query("UPDATE orders SET status = 'picked_up', delivery_payment = NULL WHERE id = $1", [orderId]);
      const answer = await receipt(orderId);
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({ payment: null, status: "picked_up" });
    });

    it("refuses an order that isn't finished, another Customer's order, a missing order and no sign-in", async () => {
      const { shopId, dal, owner, home } = await stocked();
      const placed = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
      expect((await receipt(placed.id)).json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
      await accept(placed.id, owner);
      expect((await receipt(placed.id)).statusCode).toBe(409);
      await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [placed.id]);
      expect((await receipt(placed.id, other)).statusCode).toBe(404);
      expect((await receipt(randomUUID())).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/v1/orders/${placed.id}/receipt` })).statusCode).toBe(401);
    });
  });

  it("shows the shop the Customer's name from the start, and the phone only to the assigned deliverer (DLV-7)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    await database.pool.query("UPDATE accounts SET name = 'Meera', phone = '+919876500002' WHERE email = 'customer@example.com'");
    const placed = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await accept(placed.id, owner);
    const read = async () => (await app.inject({ method: "GET", url: `/v1/me/shop-orders/${placed.id}`, headers: owner })).json().customer;
    expect(await read()).toEqual({ name: "Meera", phone: null });
    const { rows: [member] } = await database.pool.query<{ accountId: string }>("SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${placed.id}/preparing`, headers: owner });
    await app.inject({ method: "PUT", url: `/v1/me/shop-orders/${placed.id}/ready`, headers: owner, payload: { accountId: member?.accountId } });
    expect(await read()).toEqual({ name: "Meera", phone: "+919876500002" });
  });

  it("assigns an order only to Staff who can deliver, and again after a re-invite (DLV-1, ACC-7)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const staff = await signIn("/v1/auth", "staff@example.com");
    await database.pool.query("UPDATE accounts SET name = 'Ravi', phone = '+919800000001' WHERE email = 'staff@example.com'");
    const staffId = (await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = 'staff@example.com'")).rows[0]?.id ?? "";
    const invite = async (canDeliver: boolean) => {
      const made = await app.inject({ method: "POST", url: "/v1/me/staff-invites", headers: owner, payload: { phone: "+919800000001", canDeliver } });
      return app.inject({ method: "POST", url: "/v1/me/shop-join", headers: staff, payload: { code: made.json().code } });
    };
    expect((await invite(false)).statusCode).toBe(200);
    const placed = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await accept(placed.id, owner);
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${placed.id}/preparing`, headers: owner });
    const assign = (headers: Record<string, string>) => app.inject({ method: "PUT", url: `/v1/me/shop-orders/${placed.id}/ready`, headers, payload: { accountId: staffId } });
    const flag = (headers: Record<string, string>, canDeliver: boolean) =>
      app.inject({ method: "PUT", url: `/v1/me/shop-staff/${staffId}/can-deliver`, headers, payload: { canDeliver } });
    const deliverers = async () => ((await app.inject({ method: "GET", url: "/v1/me/shop-deliverers", headers: owner })).json().deliverers as Array<{ accountId: string }>).map((row) => row.accountId);

    // Without the flag Staff can't be assigned and aren't offered; Staff can't flag themselves.
    expect((await assign(owner)).json().error.code).toBe("DELIVERER_NOT_ELIGIBLE");
    expect(await deliverers()).not.toContain(staffId);
    expect((await flag(staff, true)).statusCode).toBe(404);
    // The Owner flags them; a deactivated person is refused again even though the flag is still set.
    expect((await flag(owner, true)).statusCode).toBe(200);
    expect(await deliverers()).toContain(staffId);
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-staff/${staffId}/deactivate`, headers: owner })).statusCode).toBe(204);
    expect(await deliverers()).not.toContain(staffId);
    expect((await assign(owner)).json().error.code).toBe("DELIVERER_NOT_ELIGIBLE");
    // Re-inviting with the flag restores the same account, who can then be assigned and sees the order.
    expect((await invite(true)).statusCode).toBe(200);
    expect((await assign(owner)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/me/shop-orders/${placed.id}`, headers: staff })).statusCode).toBe(200);
    expect((await database.pool.query("SELECT deliverer_id FROM orders WHERE id = $1", [placed.id])).rows).toEqual([{ deliverer_id: staffId }]);
  });

  it("waits after a call, then closes a failed delivery without recording a sale", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const before = await shopSees(dal, owner);
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const called = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/call-attempt`, headers: owner });
    expect(called.json().deliveryFailureReadyAt).toBe("2030-01-01T00:02:00.000Z");
    const tooSoon = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivery-failed`, headers: owner,
      payload: { reason: "no_one_at_address", photoUploadId: randomUUID() } });
    expect(tooSoon.json()).toMatchObject({ error: { code: "DELIVERY_FAILURE_WAIT" } });
    at("2030-01-01T00:02:00.000Z");
    const upload = await photo(orderId, owner);
    const failed = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivery-failed`, headers: owner,
      payload: { reason: "no_one_at_address", photoUploadId: upload.id } });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ status: "delivery_failed", deliveryPhotoAvailable: true });
    expect(deletedUploads).toContain(upload.id);
    expect((await database.pool.query("SELECT delivery_photo_expires_at FROM orders WHERE id = $1", [orderId])).rows[0]?.delivery_photo_expires_at)
      .toEqual(new Date("2030-01-31T00:02:00.000Z"));
    expect(await shopSees(dal, owner, before.cursor)).toMatchObject({
      listings: { stock: "10.000", held: "0" }, stock: { quantity: "10.000", held: "0" }, sync: [],
    });
    const customerPage = (await app.inject({ method: "GET", url: `/v1/shops/${shopId}?pincode=411038&latitude=18.5&longitude=73.8`, headers: customer })).json() as {
      groups: Array<{ products: Array<{ packs: Array<{ listingId: string; outOfStock: boolean }> }> }> };
    expect(customerPage.groups.flatMap((group) => group.products).flatMap((product) => product.packs)
      .find((pack) => pack.listingId === dal)?.outOfStock).toBe(false);
    expect((await database.pool.query("SELECT 1 FROM stock_movements WHERE client_id = $1 AND kind = 'sale'", [orderId])).rowCount).toBe(0);
    expect(await left(dal)).toBe("10");
  });

  it("closes a failed delivery for a Customer with no phone number once the attempt is recorded without a call (#523)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    await database.pool.query("UPDATE accounts SET phone = NULL WHERE email = 'customer@example.com'");
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const view = (await app.inject({ method: "GET", url: `/v1/me/shop-orders/${orderId}`, headers: owner })).json();
    expect(view.customer.phone).toBeNull();
    const failure = (uploadId: string) => app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivery-failed`, headers: owner,
      payload: { reason: "address_not_found", photoUploadId: uploadId } });
    expect((await failure(randomUUID())).json()).toMatchObject({ error: { code: "DELIVERY_FAILURE_CALL_REQUIRED" } });
    const recorded = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/call-attempt`, headers: owner });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().deliveryFailureReadyAt).toBe("2030-01-01T00:02:00.000Z");
    expect((await failure(randomUUID())).json()).toMatchObject({ error: { code: "DELIVERY_FAILURE_WAIT" } });
    at("2030-01-01T00:02:00.000Z");
    const failed = await failure((await photo(orderId, owner)).id);
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ status: "delivery_failed" });
  });

  it("allows a call attempt only after the deliverer has arrived", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    await database.pool.query("UPDATE orders SET status = 'out_for_delivery' WHERE id = $1", [orderId]);
    const response = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/call-attempt`, headers: owner });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
    expect((await database.pool.query("SELECT delivery_call_attempt_at FROM orders WHERE id = $1", [orderId])).rows[0]?.delivery_call_attempt_at).toBeNull();
  });

  it("lets the customer recover a permanently locked handover code after checking items", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const oldCode = checked.json().handoverCode as string;
    await database.pool.query("UPDATE orders SET handover_code_attempts = 6 WHERE id = $1", [orderId]);
    const recovered = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/handover-code/recover`, headers: customer });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().handoverCode).toMatch(/^\d{4}$/);
    expect(recovered.json().handoverCode).not.toBe(oldCode);
    expect((await database.pool.query("SELECT handover_code_attempts, handover_code_blocked_until FROM orders WHERE id = $1", [orderId])).rows)
      .toEqual([{ handover_code_attempts: 0, handover_code_blocked_until: null }]);
  });

  it("cleans expired delivery uploads and their temporary object", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const { rows: [member] } = await database.pool.query<{ accountId: string }>(
      "SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    const uploadId = randomUUID();
    await database.pool.query(`INSERT INTO delivery_photo_uploads (id, order_id, account_id, byte_length, expires_at)
      VALUES ($1, $2, $3, 100, $4)`, [uploadId, orderId, member?.accountId, new Date(clock.now().getTime() - 1)]);
    const deleted: string[] = [];
    const deletedStaged: string[] = [];
    await cleanupDeliveryUploads(database, clock, { deleteUpload: async (_order, _account, id) => { deleted.push(id); },
      deleteStagedProof: async (order, id) => { deletedStaged.push(`delivery-proofs/${order}/${id}.jpg`); } } as DeliveryPhotoStorage);
    expect(deleted).toEqual([uploadId]);
    expect(deletedStaged).toEqual([`delivery-proofs/${orderId}/${uploadId}.jpg`]);
    expect((await database.pool.query("SELECT id FROM delivery_photo_uploads WHERE id = $1", [uploadId])).rowCount).toBe(0);
  });

  it("leaves an expired upload alone while a delivery holds its row lock (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const { rows: [member] } = await database.pool.query<{ accountId: string }>(
      "SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    const uploadId = randomUUID();
    await database.pool.query(`INSERT INTO delivery_photo_uploads (id, order_id, account_id, byte_length, expires_at)
      VALUES ($1, $2, $3, 100, $4)`, [uploadId, orderId, member?.accountId, new Date(clock.now().getTime() - 1)]);
    const holder = await database.pool.connect();
    const deleted: string[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM delivery_photo_uploads WHERE id = $1 FOR UPDATE", [uploadId]);
      await cleanupDeliveryUploads(database, clock, { deleteUpload: async (_order: string, _account: string, id: string) => { deleted.push(id); },
        deleteStagedProof: async () => undefined } as unknown as DeliveryPhotoStorage);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(deleted).toEqual([]);
    expect((await database.pool.query("SELECT id FROM delivery_photo_uploads WHERE id = $1", [uploadId])).rowCount).toBe(1);
  });

  it("leaves an expired upload alone while a delivery holds its processing lease (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const { rows: [member] } = await database.pool.query<{ accountId: string }>(
      "SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    const uploadId = randomUUID();
    await database.pool.query(`INSERT INTO delivery_photo_uploads (id, order_id, account_id, byte_length, expires_at, processing_until)
      VALUES ($1, $2, $3, 100, $4, $5)`, [uploadId, orderId, member?.accountId, new Date(clock.now().getTime() - 1), new Date(clock.now().getTime() + 60_000)]);
    const deleted: string[] = [];
    const storage = { deleteUpload: async (_order: string, _account: string, id: string) => { deleted.push(id); }, deleteStagedProof: async () => undefined } as unknown as DeliveryPhotoStorage;
    await cleanupDeliveryUploads(database, clock, storage);
    expect(deleted).toEqual([]);
    clock.set(new Date(clock.now().getTime() + 61_000));
    await cleanupDeliveryUploads(database, clock, storage);
    expect(deleted).toEqual([uploadId]);
  });

  it("refuses a delivery whose upload expired while the photo was being saved, and cleanup removes it later (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const upload = await photo(orderId, owner);
    const save = deliveryPhotos.save;
    deliveryPhotos.save = async (...args: Parameters<typeof save>) => { clock.set(new Date(clock.now().getTime() + 16 * 60_000)); return save(...args); };
    try {
      const complete = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
        payload: { handoverCode: checked.json().handoverCode, payment: "cash", photoUploadId: upload.id } });
      expect(complete.statusCode).toBe(400);
      expect(complete.json()).toEqual({ error: { code: "DELIVERY_PHOTO_INVALID" } });
    } finally { deliveryPhotos.save = save; }
    expect((await database.pool.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0]?.status).toBe("arrived");
    expect((await database.pool.query("SELECT 1 FROM delivery_photo_uploads WHERE id = $1", [upload.id])).rowCount).toBe(1);
  });

  it("never saves a photo when the processing lease cannot be taken (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const upload = await photo(orderId, owner);
    // A trigger that swallows the lease update makes it touch zero rows, as if cleanup had removed the upload.
    await database.pool.query(`CREATE FUNCTION skip_lease() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
    await database.pool.query("CREATE TRIGGER skip_lease BEFORE UPDATE ON delivery_photo_uploads FOR EACH ROW EXECUTE FUNCTION skip_lease()");
    savedProofs.length = 0;
    try {
      const complete = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
        payload: { handoverCode: checked.json().handoverCode, payment: "cash", photoUploadId: upload.id } });
      expect(complete.statusCode).toBe(400);
      expect(complete.json()).toEqual({ error: { code: "DELIVERY_PHOTO_INVALID" } });
    } finally {
      await database.pool.query("DROP TRIGGER skip_lease ON delivery_photo_uploads");
      await database.pool.query("DROP FUNCTION skip_lease()");
    }
    expect(savedProofs).toEqual([]);
  });

  it("ends a photo save that outlasts its limit, inside the lease, so cleanup never meets live processing (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const upload = await photo(orderId, owner);
    const save = deliveryPhotos.save;
    let stoppedBySignal = false;
    deliveryPhotos.save = (_o: string, _a: string, _id: string, _n: number, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      const late = setTimeout(() => resolve("late"), 2000);
      signal?.addEventListener("abort", () => { stoppedBySignal = true; clearTimeout(late); reject(signal.reason); });
    });
    try {
      const started = Date.now();
      const complete = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
        payload: { handoverCode: checked.json().handoverCode, payment: "cash", photoUploadId: upload.id } });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(complete.statusCode).toBe(503);
      expect(complete.json()).toEqual({ error: { code: "UNAVAILABLE" } });
      expect(stoppedBySignal).toBe(true);
    } finally { deliveryPhotos.save = save; }
    expect((await database.pool.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0]?.status).toBe("arrived");
    // The upload is still leased, so cleanup leaves it alone even once it has expired.
    await database.pool.query("UPDATE delivery_photo_uploads SET expires_at = $2 WHERE id = $1", [upload.id, new Date(clock.now().getTime() - 1)]);
    const deleted: string[] = [];
    await cleanupDeliveryUploads(database, clock, { deleteUpload: async (_o: string, _a: string, id: string) => { deleted.push(id); }, deleteStagedProof: async () => undefined } as unknown as DeliveryPhotoStorage);
    expect(deleted).toEqual([]);
  });

  it("preserves a staged proof referenced by an order while cleaning the expired upload", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const { rows: [member] } = await database.pool.query<{ accountId: string }>(
      "SELECT account_id AS \"accountId\" FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [shopId]);
    const uploadId = randomUUID();
    const stagedKey = `delivery-proofs/${orderId}/${uploadId}.jpg`;
    await database.pool.query("UPDATE orders SET delivery_photo_key = $2 WHERE id = $1", [orderId, stagedKey]);
    await database.pool.query(`INSERT INTO delivery_photo_uploads (id, order_id, account_id, byte_length, expires_at)
      VALUES ($1, $2, $3, 100, $4)`, [uploadId, orderId, member?.accountId, new Date(clock.now().getTime() - 1)]);
    const deletedProofs: string[] = [];
    const deletedUploads: string[] = [];
    await cleanupDeliveryUploads(database, clock, { deleteStagedProof: async (_order, id) => { deletedProofs.push(id); },
      deleteUpload: async (_order, _account, id) => { deletedUploads.push(id); } } as DeliveryPhotoStorage);
    expect(deletedProofs).toEqual([]);
    expect(deletedUploads).toEqual([uploadId]);
    expect((await database.pool.query("SELECT delivery_photo_key FROM orders WHERE id = $1", [orderId])).rows[0]?.delivery_photo_key).toBe(stagedKey);
  });

  it("retains proof at the boundary, cleans it at expiry, and retries storage failures", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const key = `delivery-proofs/${orderId}/proof.jpg`;
    const expiresAt = new Date(clock.now().getTime() + 1000);
    await database.pool.query("UPDATE orders SET delivery_photo_key = $2, delivery_photo_expires_at = $3 WHERE id = $1", [orderId, key, expiresAt]);
    const deleted: string[] = [];
    let attempts = 0;
    const photos = { deleteProof: async (proof: string) => { attempts += 1; if (attempts === 1) throw new Error("storage down"); deleted.push(proof); } } as DeliveryPhotoStorage;
    const saved = async () => (await database.pool.query("SELECT delivery_photo_key, delivery_photo_expires_at FROM orders WHERE id = $1", [orderId])).rows[0];

    await cleanupDeliveryProofs(database, clock, photos);
    expect(attempts).toBe(0);
    expect((await saved()).delivery_photo_key).toBe(key);

    clock.set(expiresAt);
    await cleanupDeliveryProofs(database, clock, photos);
    expect(attempts).toBe(1);
    expect((await saved()).delivery_photo_key).toBe(key);

    await cleanupDeliveryProofs(database, clock, photos);
    expect(deleted).toEqual([key]);
    expect(await saved()).toEqual({ delivery_photo_key: null, delivery_photo_expires_at: null });
  });

  it("keeps the upload when the delivery transaction fails after permanent save", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    const checked = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const upload = await photo(orderId, owner);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `fail_delivery_${suffix}`;
    await database.pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery commit failed'; END $$`);
    await database.pool.query(`CREATE TRIGGER ${functionName} BEFORE UPDATE ON orders FOR EACH ROW WHEN (NEW.id = '${orderId}'::uuid AND NEW.status = 'delivered') EXECUTE FUNCTION ${functionName}()`);
    try {
      const response = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
        payload: { handoverCode: checked.json().handoverCode, payment: "cash", photoUploadId: upload.id } });
      expect(response.statusCode).toBe(500);
      expect(savedProofs).toContain(upload.id);
      expect(deletedUploads).not.toContain(upload.id);
      expect((await database.pool.query("SELECT id FROM delivery_photo_uploads WHERE id = $1", [upload.id])).rowCount).toBe(1);
    } finally {
      await database.pool.query(`DROP TRIGGER ${functionName} ON orders`);
      await database.pool.query(`DROP FUNCTION ${functionName}()`);
    }
  });

  it("refuses a proof exception until a call attempt is recorded, then allows it with no wait (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    await app.inject({ method: "POST", url: `/v1/orders/${orderId}/items-ok`, headers: customer });
    const upload = await photo(orderId, owner);
    const payload = { reason: "customer_phone_unavailable", payment: "cash", photoUploadId: upload.id };
    const refused = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/proof-exception`, headers: owner, payload });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: { code: "PROOF_EXCEPTION_CALL_REQUIRED" } });
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/call-attempt`, headers: owner })).statusCode).toBe(200);
    const done = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/proof-exception`, headers: owner, payload });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "delivered" });
  });

  it("makes a code for an order accepted before codes existed instead of failing, and counts no attempt (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner, true);
    await database.pool.query("UPDATE orders SET items_checked_at = $2 WHERE id = $1", [orderId, new Date("2030-01-01T00:00:00.000Z")]);
    const upload = await photo(orderId, owner);
    const first = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
      payload: { handoverCode: "0000", payment: "cash", photoUploadId: upload.id } });
    expect(first.statusCode).toBe(400);
    expect(first.json()).toEqual({ error: { code: "HANDOVER_CODE_WRONG" } });
    expect((await database.pool.query("SELECT handover_code_hash IS NOT NULL AS made, handover_code_attempts AS attempts FROM orders WHERE id = $1", [orderId])).rows)
      .toEqual([{ made: true, attempts: 0 }]);
    const code = (await app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: customer })).json().handoverCode as string;
    expect(code).toMatch(/^\d{4}$/);
    const second = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivered`, headers: owner,
      payload: { handoverCode: code, payment: "cash", photoUploadId: upload.id } });
    expect(second.statusCode).toBe(200);
  });

  it("holds at most five unexpired photo uploads per order (#524)", async () => {
    const { shopId, dal, owner, home } = await stocked();
    const orderId = await readyAtDoor(shopId, dal, home, owner);
    for (let count = 0; count < 5; count += 1) await photo(orderId, owner);
    const sixth = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/delivery-photo-upload`, headers: owner,
      payload: { contentType: "image/jpeg", byteLength: 100 } });
    expect(sixth.statusCode).toBe(400);
    expect(sixth.json()).toEqual({ error: { code: "DELIVERY_PHOTO_INVALID" } });
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
    const customerPage = (await app.inject({ method: "GET", url: `/v1/shops/${shopId}?pincode=411038&latitude=18.5&longitude=73.8`, headers: customer })).json() as {
      groups: Array<{ products: Array<{ packs: Array<{ listingId: string; outOfStock: boolean }> }> }> };
    const customerPack = customerPage.groups.flatMap((group) => group.products).flatMap((product) => product.packs)
      .find((pack) => pack.listingId === dal);
    expect(customerPack?.outOfStock).toBe(false);
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
    // No route moves an accepted order on yet (#56), so set the status as one will.
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

describe("Notifications (#505, NOT-1 to NOT-4)", () => {
  /** `headers` as one of the phone apps sends them. */
  const as = (headers: Record<string, string>, appName: "customer" | "shopkeeper") => ({ ...headers, "x-ygo-app-name": appName, "x-ygo-app-version": "1.0.0" });
  const register = (headers: Record<string, string>, token: string) =>
    app.inject({ method: "PUT", url: "/v1/me/push-token", headers, payload: { token } });
  const list = async (headers: Record<string, string>) =>
    (await app.inject({ method: "GET", url: "/v1/me/notifications", headers })).json() as { notifications: Array<Record<string, unknown>>; unread: boolean };
  const push = createLocalPushSender();
  const send = async (sender: PushSender = push) => {
    push.sent.length = 0;
    await sendDuePushes(database.pool, sender, clock.now());
    return push.sent.map(({ to, title, loud }) => ({ to, title, loud }));
  };
  const queued = async () => Number((await database.pool.query<{ count: string }>("SELECT count(*) FROM push_queue")).rows[0]?.count);

  /** A stocked shop with Staff, and a push token on each of the three phones. */
  async function phones() {
    const shop = await stocked();
    const owner = as(shop.owner, "shopkeeper");
    const staff = as(await staffOf(shop.shopId), "shopkeeper");
    const buyer = as(customer, "customer");
    for (const [headers, token] of [[owner, "ExponentPushToken[owner]"], [staff, "ExponentPushToken[staff]"], [buyer, "ExponentPushToken[buyer]"]] as const) {
      expect((await register(headers, token)).statusCode).toBe(204);
    }
    return { ...shop, owner, staff, buyer };
  }

  it("rings the Owner's and the Staff's phones for a new order, again at 120 s, and tells the customer the reason it was rejected", async () => {
    const { shopId, dal, home, owner, staff, buyer } = await phones();
    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };

    const placed = { kind: "order_placed", title: "New order #1001", body: "Accept or reject it within 10 minutes.", orderId: order.id,
      createdAt: "2030-01-01T00:00:00.000Z", read: false, id: expect.any(String) };
    expect(await list(owner)).toEqual({ notifications: [placed], unread: true });
    expect(await list(staff)).toEqual({ notifications: [placed], unread: true });
    expect(await list(buyer)).toEqual({ notifications: [], unread: false });
    // The Owner's account in the Customer app hears nothing of its shop.
    expect(await list(as(owner, "customer"))).toEqual({ notifications: [], unread: false });

    const ring = [{ to: "ExponentPushToken[owner]", title: "New order #1001", loud: true }, { to: "ExponentPushToken[staff]", title: "New order #1001", loud: true }];
    expect(await send()).toEqual(ring);
    expect(push.sent[0]?.data).toEqual({ notificationId: (await list(owner)).notifications[0]?.id, orderId: order.id });
    expect(await send()).toEqual([]);
    clock.advance(119_000);
    expect(await send()).toEqual([]);
    clock.advance(1_000);
    expect(await send()).toEqual(ring);
    expect(await queued()).toBe(0);

    expect((await reject(order.id, staff, "out_of_stock")).statusCode).toBe(200);
    expect(await list(buyer)).toMatchObject({ notifications: [{ kind: "order_rejected", title: "Order #1001 rejected",
      body: "Sai General Stores could not take your order: Items out of stock.", orderId: order.id, read: false }], unread: true });
    expect(await send()).toEqual([{ to: "ExponentPushToken[buyer]", title: "Order #1001 rejected", loud: false }]);
    // Admin is never told (NOT-4).
    expect(Number((await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE a.email = $1", [adminEmail])).rows[0]?.count)).toBe(0);
  });

  it("drops the re-ring once the order is answered or past its time, and tells the customer of an accept and the shop of a cancel", async () => {
    const { shopId, dal, home, owner, staff, buyer } = await phones();
    const accepted = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const cancelled = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const late = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    expect(await accept(accepted.id, owner)).toMatchObject({ statusCode: 200 });
    clock.advance(1_000);
    expect((await cancel(cancelled.id)).statusCode).toBe(200);
    expect((await list(buyer)).notifications).toMatchObject([{ kind: "order_accepted", title: "Order #1001 accepted",
      body: "Sai General Stores is getting your order ready.", orderId: accepted.id }]);
    for (const shopPhone of [owner, staff]) {
      // Three orders placed at one moment list in any order among themselves; the later cancel lists first.
      const rows = (await list(shopPhone)).notifications.map(({ kind, title }) => ({ kind, title }));
      expect([rows[0], ...rows.slice(1).sort((a, b) => String(a.title).localeCompare(String(b.title)))]).toEqual([
        { kind: "order_cancelled_by_customer", title: "Order #1002 cancelled" },
        ...["New order #1001", "New order #1002", "New order #1003"].map((title) => ({ kind: "order_placed", title })),
      ]);
    }
    expect((await send()).map(({ title }) => title).sort()).toEqual([
      "New order #1003", "New order #1003", "Order #1001 accepted", "Order #1002 cancelled", "Order #1002 cancelled",
    ]);
    // Only the unanswered order rings again, and not once it is past its answer time.
    clock.advance(120_000);
    expect((await send()).map(({ title }) => title)).toEqual(["New order #1003", "New order #1003"]);
    await database.pool.query("INSERT INTO push_queue (notification_id, send_after) SELECT id, $2 FROM notifications WHERE order_id = $1", [late.id, clock.now()]);
    clock.advance(480_000);
    expect(await send()).toEqual([]);
    expect(await queued()).toBe(0);
  });

  it("keeps a token with the newest session, forgets it at sign-out, drops a dead one and retries a failed send twice", async () => {
    const { shopId, dal, home, owner } = await phones();
    expect((await register(customer, "ExponentPushToken[x]")).statusCode).toBe(400);
    expect((await register(owner, "not-a-token")).statusCode).toBe(400);
    // The phone is handed to the other account: its token now reaches that one.
    const otherBuyer = as(other, "customer");
    expect((await register(otherBuyer, "ExponentPushToken[buyer]")).statusCode).toBe(204);
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    await app.inject({ method: "POST", url: "/v1/auth/sign-out", headers: owner });
    expect(await send()).toEqual([{ to: "ExponentPushToken[staff]", title: "New order #1001", loud: true }]);

    const order = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    const down: PushSender = { receipts: async () => new Map(), send: async (pushes) => pushes.map(() => "failed" as const) };
    for (const tries of [1, 2]) {
      await expect(send(down)).rejects.toThrow("1 pushes could not be sent");
      expect((await database.pool.query("SELECT tries FROM push_queue ORDER BY send_after LIMIT 1")).rows).toEqual([{ tries }]);
      clock.advance(30_000);
    }
    await expect(send(down)).rejects.toThrow("could not be sent");
    expect((await database.pool.query("SELECT 1 FROM push_queue q JOIN notifications n ON n.id = q.notification_id WHERE n.order_id = $1 AND q.send_after <= $2",
      [order.id, clock.now()])).rowCount).toBe(0);

    const gone: PushSender = { receipts: async () => new Map(), send: async (pushes) => pushes.map(() => "dead" as const) };
    clock.advance(120_000);
    await sendDuePushes(database.pool, gone, clock.now());
    expect((await database.pool.query("SELECT token FROM push_tokens ORDER BY token")).rows).toEqual([{ token: "ExponentPushToken[buyer]" }]);
  });

  it("sends each app's pushes in a request of their own, and stops ringing someone who has left the shop", async () => {
    const { shopId, dal, home, owner, staff } = await phones();
    const first = (await ordered(shopId, [{ listingId: dal, count: 1 }], home)).json() as { id: string };
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    await reject(first.id, owner);
    const requests: string[][] = [];
    const recording: PushSender = { receipts: async () => new Map(), send: async (pushes) => { requests.push(pushes.map((one) => one.to)); return pushes.map(() => "sent" as const); } };
    await sendDuePushes(database.pool, recording, clock.now());
    expect(requests.map((tokens) => [...new Set(tokens)].sort())).toEqual([["ExponentPushToken[owner]", "ExponentPushToken[staff]"], ["ExponentPushToken[buyer]"]]);

    await database.pool.query("DELETE FROM shop_members WHERE role = 'staff'");
    clock.advance(120_000);
    expect(await send()).toEqual([{ to: "ExponentPushToken[owner]", title: "New order #1002", loud: true }]);
    expect((await list(staff)).notifications).toHaveLength(2);
  });

  it("never rings a removed Owner or Staff member, on the first ring or the 120 s one", async () => {
    const { shopId, dal, home, staff } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    await database.pool.query("DELETE FROM shop_members WHERE role = 'owner'");
    expect(await send()).toEqual([{ to: "ExponentPushToken[staff]", title: "New order #1001", loud: true }]);
    await database.pool.query("DELETE FROM shop_members WHERE role = 'staff'");
    clock.advance(120_000);
    expect(await send()).toEqual([]);
    expect(await queued()).toBe(0);
    // The list keeps what was already recorded for them.
    expect((await list(staff)).notifications).toHaveLength(1);
  });

  it("retries only the phone that failed, so a phone already reached never gets the same push twice", async () => {
    const { shopId, dal, home } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    const calls: string[][] = [];
    const ownerOnly: PushSender = { receipts: async () => new Map(), send: async (pushes) => {
      calls.push(pushes.map((one) => one.to));
      return pushes.map((one) => one.to === "ExponentPushToken[owner]" ? "sent" as const : "failed" as const);
    } };
    await expect(sendDuePushes(database.pool, ownerOnly, clock.now())).rejects.toThrow("1 pushes could not be sent");
    // Not before its 30 s wait, and then only to the Staff phone.
    clock.advance(29_000);
    expect(await send()).toEqual([]);
    clock.advance(1_000);
    expect(await send()).toEqual([{ to: "ExponentPushToken[staff]", title: "New order #1001", loud: true }]);
    expect(await send()).toEqual([]);
    // The 120 s re-ring reaches each phone once.
    clock.advance(90_000);
    expect((await send()).map(({ to }) => to)).toEqual(["ExponentPushToken[owner]", "ExponentPushToken[staff]"]);
    expect(await queued()).toBe(0);
    expect(calls).toEqual([["ExponentPushToken[owner]", "ExponentPushToken[staff]"]]);
  });

  it("calls Expo with no transaction or lock open, and a second run meanwhile takes none of the claimed pushes", async () => {
    const { shopId, dal, home } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    const seen: Array<{ open: number; other: number; locked: number }> = [];
    const checking: PushSender = { receipts: async () => new Map(), send: async (pushes) => {
      const { rows: [open] } = await database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'");
      const other = createLocalPushSender();
      await sendDuePushes(database.pool, other, clock.now());
      // Every row can be locked at once without waiting.
      const { rowCount } = await database.pool.query("SELECT id FROM push_queue FOR UPDATE NOWAIT");
      seen.push({ open: open?.count ?? -1, other: other.sent.length, locked: rowCount ?? 0 });
      return pushes.map(() => "sent" as const);
    } };
    await sendDuePushes(database.pool, checking, clock.now());
    // Two claimed phone rows and the two 120 s re-rings not yet fanned out.
    expect(seen).toEqual([{ open: 0, other: 0, locked: 4 }]);
  });

  it("sends a push again once a run's claim has lapsed without an answer", async () => {
    const { shopId, dal, home } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    // A run that claims the pushes and then dies before Expo answers.
    const dies: PushSender = { receipts: async () => new Map(), send: () => new Promise(() => undefined) };
    void sendDuePushes(database.pool, dies, clock.now());
    await expect.poll(async () => Number((await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM push_queue WHERE claimed_until IS NOT NULL")).rows[0]?.count)).toBe(2);
    clock.advance(59_000);
    expect(await send()).toEqual([]);
    clock.advance(1_000);
    expect((await send()).map(({ to }) => to)).toEqual(["ExponentPushToken[owner]", "ExponentPushToken[staff]"]);
  });

  it("lets a run whose claim lapsed record nothing over the run that took its pushes over", async () => {
    const { shopId, dal, home } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    let answer: (results: PushResult[]) => void = () => undefined;
    const slow: PushSender = { receipts: async () => new Map(), send: () => new Promise((resolve) => { answer = resolve; }) };
    const late = sendDuePushes(database.pool, slow, clock.now());
    await expect.poll(async () => (await database.pool.query("SELECT 1 FROM push_queue WHERE claim_id IS NOT NULL")).rowCount).toBe(2);
    clock.advance(60_000);
    expect((await send()).map(({ to }) => to)).toEqual(["ExponentPushToken[owner]", "ExponentPushToken[staff]"]);
    // The first run finally hears back that both failed: the pushes another run sent are not queued again.
    answer(["failed", "failed"]);
    await expect(late).rejects.toThrow("2 pushes could not be sent");
    expect((await database.pool.query("SELECT 1 FROM push_queue WHERE token IS NOT NULL")).rowCount).toBe(0);
  });

  it("drains every due push in one call, a batch at a time", async () => {
    const { shopId, dal, home } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    push.sent.length = 0;
    await sendDuePushes(database.pool, push, clock.now(), 1);
    expect(push.sent).toHaveLength(4);
  });

  describe("push receipts (#509)", () => {
    const tokens = async () => (await database.pool.query<{ token: string }>("SELECT token FROM push_tokens ORDER BY token")).rows.map((row) => row.token);
    const tickets = async () => (await database.pool.query<{ ticketId: string }>("SELECT ticket_id AS \"ticketId\" FROM push_receipts ORDER BY ticket_id")).rows.map((row) => row.ticketId);
    /** Sends with a ticket for each push, then answers receipts as `answers` says (a ticket left out has none yet). */
    const ticketing = (answers: Record<string, ReceiptResult> = {}, asked: string[][] = []): PushSender => ({
      send: async (pushes) => pushes.map(({ to }) => ({ ticketId: `t-${to}` })),
      receipts: async (ids) => { asked.push(ids); return new Map(ids.flatMap((id) => answers[id] ? [[id, answers[id]] as const] : [])); },
    });
    const placed = async () => {
      const shop = await phones();
      // The phones registered before the send: a registration at the very moment of the send is not the same one.
      clock.advance(1_000);
      await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home);
      await sendDuePushes(database.pool, ticketing(), clock.now());
      return shop;
    };

    it("keeps each sent push's ticket, and asks for receipts only 15 minutes later", async () => {
      await placed();
      expect(await queued()).toBe(2);
      expect(await tickets()).toEqual(["t-ExponentPushToken[owner]", "t-ExponentPushToken[staff]"]);
      const asked: string[][] = [];
      clock.advance(899_000);
      await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      expect(asked).toEqual([]);
      clock.advance(1_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[staff]": "ok" }, asked), clock.now());
      expect(asked).toEqual([["t-ExponentPushToken[owner]", "t-ExponentPushToken[staff]"]]);
    });

    it("deletes a token the receipt reports dead, and only that one", async () => {
      await placed();
      clock.advance(900_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "dead", "t-ExponentPushToken[staff]": "ok" }), clock.now());
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[staff]"]);
      expect(await tickets()).toEqual([]);
    });

    it("keeps the token on any other receipt error, and on a token the phone registered again after the send", async () => {
      const { owner } = await placed();
      clock.advance(1_000);
      expect((await register(owner, "ExponentPushToken[owner]")).statusCode).toBe(204);
      clock.advance(900_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "dead", "t-ExponentPushToken[staff]": "other" }), clock.now());
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[owner]", "ExponentPushToken[staff]"]);
      expect(await tickets()).toEqual([]);
    });

    it("keeps a token registered at exactly the moment of the send", async () => {
      const { owner } = await placed();
      expect((await register(owner, "ExponentPushToken[owner]")).statusCode).toBe(204);
      const { rows } = await database.pool.query("SELECT 1 FROM push_tokens t JOIN push_receipts r ON r.token = t.token WHERE t.updated_at = r.sent_at");
      expect(rows).toHaveLength(1);
      clock.advance(900_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "dead", "t-ExponentPushToken[staff]": "dead" }), clock.now());
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[owner]"]);
    });

    it("asks again every 15 minutes for a receipt that is missing, and drops the ticket 24 hours after the send", async () => {
      await placed();
      const asked: string[][] = [];
      for (let i = 0; i < 3; i += 1) {
        clock.advance(900_000);
        await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      }
      expect(asked).toHaveLength(3);
      expect(await tickets()).toHaveLength(2);
      // Late, the receipt arrives: a dead token still goes.
      clock.advance(900_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "dead" }), clock.now());
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[staff]"]);
      clock.advance(24 * 3_600_000);
      await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      expect(await tickets()).toEqual([]);
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[staff]"]);
    });

    it("asks for each app's tickets in a request of its own", async () => {
      await database.pool.query(
        `INSERT INTO push_receipts (ticket_id, token, app, sent_at, check_after) VALUES
         ('c1', 'ExponentPushToken[c]', 'customer', $1, $1), ('s1', 'ExponentPushToken[s]', 'shopkeeper', $1, $1), ('c2', 'ExponentPushToken[c]', 'customer', $1, $1)`, [clock.now()]);
      const asked: string[][] = [];
      await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      expect(asked.map((ids) => [...ids].sort())).toEqual([["c1", "c2"], ["s1"]]);
    });

    it("checks a ticket once with two workers, and ignores the answer of a run whose claim lapsed", async () => {
      await placed();
      clock.advance(900_000);
      let answer: (found: Map<string, ReceiptResult>) => void = () => undefined;
      const slow: PushSender = { send: async () => [], receipts: () => new Promise((resolve) => { answer = resolve; }) };
      const late = checkPushReceipts(database.pool, slow, clock.now());
      await expect.poll(async () => (await database.pool.query("SELECT 1 FROM push_receipts WHERE claim_id IS NOT NULL")).rowCount).toBe(2);
      // A second worker meanwhile finds nothing to ask for.
      const asked: string[][] = [];
      await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      expect(asked).toEqual([]);
      // Its claim lapsed: another run takes the tickets over and ends them as ok.
      clock.advance(60_000);
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "ok", "t-ExponentPushToken[staff]": "ok" }), clock.now());
      answer(new Map([["t-ExponentPushToken[owner]", "dead"]]));
      await late;
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[owner]", "ExponentPushToken[staff]"]);
    });

    it("asks again on the next pass, not 15 minutes later, for tickets of a failed request, and logs no token", async () => {
      await placed();
      clock.advance(900_000);
      const failure = (message: string): PushSender => ({ send: async () => [], receipts: async (ids) => {
        if (message === "throws") throw new Error("down");
        return new Map(ids.map((id) => [id, "failed" as const]));
      } });
      // An HTTP failure or unreadable answer (the adapter's "failed"), then a network failure that throws: each is read at once next time.
      for (const how of ["http", "throws"]) {
        const error = await checkPushReceipts(database.pool, failure(how), clock.now()).catch((thrown: Error) => thrown);
        expect(error).toMatchObject({ message: "2 push receipts could not be read" });
        expect(String((error as Error).message)).not.toContain("ExponentPushToken");
        expect((await database.pool.query("SELECT 1 FROM push_receipts WHERE claim_id IS NOT NULL OR check_after <> $1::timestamptz", [clock.now()])).rowCount).toBe(0);
      }
      // The next pass, no time later, asks for the same two and finishes them.
      const asked: string[][] = [];
      await checkPushReceipts(database.pool, ticketing({ "t-ExponentPushToken[owner]": "dead" }, asked), clock.now());
      expect(asked).toEqual([["t-ExponentPushToken[owner]", "t-ExponentPushToken[staff]"]]);
      expect(await tokens()).toEqual(["ExponentPushToken[buyer]", "ExponentPushToken[staff]"]);
    });

    it("lets only a failed request's tickets go back at once, and a missing receipt waits its 15 minutes", async () => {
      await placed();
      clock.advance(900_000);
      const mixed: PushSender = { send: async () => [], receipts: async () => new Map([["t-ExponentPushToken[owner]", "failed" as const]]) };
      await expect(checkPushReceipts(database.pool, mixed, clock.now())).rejects.toThrow("1 push receipts could not be read");
      const due = async () => (await database.pool.query<{ ticketId: string }>("SELECT ticket_id AS \"ticketId\" FROM push_receipts WHERE check_after <= $1 ORDER BY 1", [clock.now()])).rows.map((row) => row.ticketId);
      expect(await due()).toEqual(["t-ExponentPushToken[owner]"]);
      clock.advance(5_000);
      const asked: string[][] = [];
      await checkPushReceipts(database.pool, ticketing({}, asked), clock.now());
      expect(asked).toEqual([["t-ExponentPushToken[owner]"]]);
    });
  });

  it("reads one notification on a tap and all of them on Mark all as read, each person and app on its own", async () => {
    const { shopId, dal, home, owner, staff } = await phones();
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    clock.advance(1_000);
    await ordered(shopId, [{ listingId: dal, count: 1 }], home);
    const [newest, oldest] = (await list(owner)).notifications;
    const read = (id: unknown, headers: Record<string, string>) => app.inject({ method: "POST", url: `/v1/me/notifications/${String(id)}/read`, headers });
    expect((await read(newest?.id, owner)).statusCode).toBe(204);
    expect((await read(newest?.id, owner)).statusCode).toBe(204);
    expect((await read(newest?.id, as(owner, "customer"))).statusCode).toBe(404);
    expect((await read(newest?.id, as(customer, "customer"))).statusCode).toBe(404);
    expect(await list(owner)).toMatchObject({ notifications: [{ id: newest?.id, read: true }, { id: oldest?.id, read: false }], unread: true });
    expect((await list(staff)).notifications.map((row) => row.read)).toEqual([false, false]);

    expect((await app.inject({ method: "POST", url: "/v1/me/notifications/read-all", headers: owner })).statusCode).toBe(204);
    expect(await list(owner)).toMatchObject({ notifications: [{ read: true }, { read: true }], unread: false });
    expect((await list(staff)).unread).toBe(true);
  });

  describe("Android ring attempts and floor push (#508)", () => {
    const registerAndroid = (headers: Record<string, string>, token: string) =>
      app.inject({ method: "PUT", url: "/v1/me/push-token", headers, payload: { token, platform: "android" } });
    const ack = (headers: Record<string, string>, id: string) =>
      app.inject({ method: "POST", url: `/v1/me/ring-attempts/${id}/ack`, headers });

    it("sends a data-only ring push to Android, cancels floor push on acknowledgement, and re-rings at 120 s", async () => {
      const shop = await stocked();
      const owner = as(shop.owner, "shopkeeper");
      const buyer = as(customer, "customer");
      await registerAndroid(owner, "ExponentPushToken[android-owner]");
      await register(buyer, "ExponentPushToken[buyer]");

      const order = (await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home)).json() as { id: string };

      // Initial ring push at placed_at
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent).toHaveLength(1);
      const ringPush = push.sent[0];
      if (!ringPush) throw new Error("Expected ring push");
      expect(ringPush.to).toBe("ExponentPushToken[android-owner]");
      expect(ringPush.title).toBeUndefined();
      expect(ringPush.body).toBeUndefined();
      expect(ringPush.loud).toBe(true);
      expect(ringPush.tag).toBe(`order-${order.id}`);
      const ringAttemptId = ringPush.data.ringAttemptId as string;
      expect(ringAttemptId).toBeDefined();

      // Acknowledgement success:
      const ackRes = await ack(owner, ringAttemptId);
      expect(ackRes.statusCode).toBe(204);

      // Advance 15 seconds: floor push was cancelled by ack, so nothing sent
      clock.advance(15_000);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent).toHaveLength(0);

      // Advance to 120 s: attempt 2 re-ring arrives with new attempt ID and same tag
      clock.advance(105_000);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent).toHaveLength(1);
      const reringPush = push.sent[0];
      if (!reringPush) throw new Error("Expected rering push");
      expect(reringPush.to).toBe("ExponentPushToken[android-owner]");
      expect(reringPush.title).toBeUndefined();
      expect(reringPush.tag).toBe(`order-${order.id}`);
      const reringAttemptId = reringPush.data.ringAttemptId as string;
      expect(reringAttemptId).toBeDefined();
      expect(reringAttemptId).not.toBe(ringAttemptId);
    });

    it("sends floor push with title and body at 15 s when acknowledgement is lost or delayed", async () => {
      const shop = await stocked();
      const owner = as(shop.owner, "shopkeeper");
      await registerAndroid(owner, "ExponentPushToken[android-lost-ack]");

      const order = (await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home)).json() as { id: string };

      // Initial ring push at placed_at
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent).toHaveLength(1);
      const firstPush = push.sent[0];
      if (!firstPush) throw new Error("Expected ring push");
      const ringAttemptId = firstPush.data.ringAttemptId as string;

      // Lost acknowledgement / app force-stopped: advance to +15s
      clock.advance(15_000);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent).toHaveLength(1);
      const floorPush = push.sent[0];
      if (!floorPush) throw new Error("Expected floor push");
      expect(floorPush.to).toBe("ExponentPushToken[android-lost-ack]");
      expect(floorPush.title).toBe("New order #1001");
      expect(floorPush.body).toBe("Accept or reject it within 10 minutes.");
      expect(floorPush.loud).toBe(true);
      expect(floorPush.tag).toBe(`order-${order.id}`);
      expect(floorPush.data.floor).toBe(true);

      // Delayed acknowledgement arrives after floor push was sent
      clock.advance(5_000);
      const ackRes = await ack(owner, ringAttemptId);
      expect(ackRes.statusCode).toBe(204);
    });

    it("gives each ring its own attempt when both fall due in one pass, and drops the floor once the order is answered", async () => {
      const shop = await stocked();
      const owner = as(shop.owner, "shopkeeper");
      await registerAndroid(owner, "ExponentPushToken[android-late]");
      const order = (await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home)).json() as { id: string };

      // The worker was down: the ring, its floor and the re-ring all fall due in the first pass.
      clock.advance(130_000);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      const rings = push.sent.filter((sent) => sent.title === undefined);
      const floors = push.sent.filter((sent) => sent.title !== undefined);
      expect(rings).toHaveLength(2);
      expect(floors).toHaveLength(1);
      expect(new Set(rings.map((sent) => sent.data.ringAttemptId)).size).toBe(2);
      expect(rings.map((sent) => sent.data.ringAttemptId)).toContain(floors[0]?.data.ringAttemptId);
      const { rows } = await database.pool.query("SELECT attempt FROM ring_attempts WHERE order_id = $1 ORDER BY attempt", [order.id]);
      expect(rows).toEqual([{ attempt: 1 }, { attempt: 2 }]);

      // Answering the order drops the second floor push.
      expect((await accept(order.id, owner)).statusCode).toBe(200);
      clock.advance(20_000);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      expect(push.sent.filter((sent) => sent.data.floor === true)).toHaveLength(0);
    });

    it("lets only a member of the order's shop acknowledge its ring attempt", async () => {
      const shop = await stocked();
      const owner = as(shop.owner, "shopkeeper");
      await registerAndroid(owner, "ExponentPushToken[android-member]");
      await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home);
      push.sent.length = 0;
      await sendDuePushes(database.pool, push, clock.now());
      const id = push.sent[0]?.data.ringAttemptId as string;
      const stranger = as(await signIn("/v1/auth", "stranger-shop@example.test"), "shopkeeper");
      expect((await ack(stranger, id)).statusCode).toBe(404);
      expect((await ack(owner, id)).statusCode).toBe(204);
    });

    it("validates acknowledgement permissions and unknown attempts", async () => {
      const shop = await stocked();
      const owner = as(shop.owner, "shopkeeper");
      const buyer = as(customer, "customer");

      // Non-shopkeeper app gets 403
      expect((await ack(buyer, randomUUID())).statusCode).toBe(403);

      // Unknown attempt ID gets 404
      expect((await ack(owner, randomUUID())).statusCode).toBe(404);
    });
  });
});

describe("Order timers: unanswered orders expire (#57, ORD-2)", () => {
  const as = (headers: Record<string, string>, appName: "customer" | "shopkeeper") => ({ ...headers, "x-ygo-app-name": appName, "x-ygo-app-version": "1.0.0" });
  const expire = () => runJob(database, "expire-orders", clock);
  const statusOf = async (orderId: string) => (await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0]?.status;
  const expiredNotices = async () => (await database.pool.query<{ kind: string; app: string; title: string; body: string; order_id: string }>(
    "SELECT kind, app, title, body, order_id FROM notifications WHERE kind = 'order_expired'")).rows;
  const runs = async () => (await database.pool.query<{ status: string; error_text: string | null }>(
    "SELECT status, error_text FROM job_runs WHERE job_name = 'expire-orders' ORDER BY started_at, finished_at")).rows;
  /** An order placed at `iso`. */
  async function placedAt(shop: Awaited<ReturnType<typeof stocked>>, iso: string) {
    at(iso);
    return ((await ordered(shop.shopId, [{ listingId: shop.dal, count: 1 }], shop.home)).json() as { id: string }).id;
  }

  it("expires an order at 600 s and not at 599 s, and at 601 s too, with its history and one notice for the customer", async () => {
    const shop = await stocked();
    const older = await placedAt(shop, "2029-12-31T23:59:59.000Z");
    const exact = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    const young = await placedAt(shop, "2030-01-01T00:00:01.000Z");
    at("2030-01-01T00:10:00.000Z");
    await expire();
    expect([await statusOf(older), await statusOf(exact), await statusOf(young)]).toEqual(["expired", "expired", "placed"]);
    at("2030-01-01T00:10:00.999Z");
    await expire();
    expect(await statusOf(young)).toBe("placed");
    at("2030-01-01T00:10:01.000Z");
    await expire();
    expect(await statusOf(young)).toBe("expired");
    expect(await history(exact)).toEqual([{ from_status: "placed", to_status: "expired", actor_role: "system", reason_code: "no_answer" }]);
    expect((await database.pool.query("SELECT actor_id, at FROM order_status_history WHERE order_id = $1 AND to_status = 'expired'", [exact])).rows)
      .toEqual([{ actor_id: null, at: new Date("2030-01-01T00:10:00.000Z") }]);
    expect(await expiredNotices()).toHaveLength(3);
    expect((await runs()).map(({ status }) => status)).toEqual(["ok", "ok", "ok"]);
  });

  it("tells only the customer, once, however often the job runs or runs at once, and drops the shop's re-ring", async () => {
    const shop = await stocked();
    const owner = as(shop.owner, "shopkeeper");
    const buyer = as(customer, "customer");
    for (const [headers, token] of [[owner, "ExponentPushToken[owner]"], [buyer, "ExponentPushToken[buyer]"]] as const) {
      expect((await app.inject({ method: "PUT", url: "/v1/me/push-token", headers, payload: { token } })).statusCode).toBe(204);
    }
    const id = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    at("2030-01-01T00:10:00.000Z");
    await Promise.all([expire(), expire(), expire()]);
    await expire();
    expect(await expiredNotices()).toEqual([{ kind: "order_expired", app: "customer", title: "Order #1001 expired",
      body: "Sai General Stores didn't answer in time. You were not charged.", order_id: id }]);
    expect(await history(id)).toHaveLength(1);
    const customerList = (await app.inject({ method: "GET", url: "/v1/me/notifications", headers: buyer })).json() as { notifications: Array<{ kind: string }> };
    expect(customerList.notifications.map(({ kind }) => kind)).toEqual(["order_expired"]);
    const ownerList = (await app.inject({ method: "GET", url: "/v1/me/notifications", headers: owner })).json() as { notifications: Array<{ kind: string }> };
    expect(ownerList.notifications.map(({ kind }) => kind)).toEqual(["order_placed"]);
    const push = createLocalPushSender();
    await sendDuePushes(database.pool, push, clock.now());
    expect(push.sent.map(({ to, title }) => `${to} ${title}`)).toEqual(["ExponentPushToken[buyer] Order #1001 expired"]);
    expect((await database.pool.query<{ count: string }>("SELECT count(*) FROM push_queue")).rows[0]?.count).toBe("0");
  });

  it("leaves answered orders alone, and a shop can no longer answer one that expired", async () => {
    const shop = await stocked();
    const accepted = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    const rejected = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    const cancelled = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    const silent = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    expect((await accept(accepted, shop.owner)).statusCode).toBe(200);
    expect((await reject(rejected, shop.owner)).statusCode).toBe(200);
    expect((await cancel(cancelled)).statusCode).toBe(200);
    at("2030-01-01T00:10:00.000Z");
    await expire();
    expect([await statusOf(accepted), await statusOf(rejected), await statusOf(cancelled), await statusOf(silent)])
      .toEqual(["accepted", "rejected_by_shop", "cancelled_by_customer", "expired"]);
    expect((await accept(silent, shop.owner)).statusCode).toBe(409);
    expect((await cancel(silent)).statusCode).toBe(409);
    expect(await left(shop.dal)).toBe("9");
  });

  it("is a move no request can make: only the system role, which no signed-in request has", async () => {
    const shop = await stocked();
    const id = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    at("2030-01-01T00:10:00.000Z");
    for (const role of ["customer", "owner", "staff"] as const) expect(canMove("placed", "expired", role)).toBe(false);
    for (const url of ["accept", "reject"]) {
      const response = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/${url}`, headers: shop.owner, payload: { reason: "too_busy" } });
      expect(response.statusCode).toBe(409);
    }
    expect(await statusOf(id)).toBe("placed");
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/expire`, headers: shop.owner })).statusCode).toBe(404);
  });

  it("records a failed run durably, rolls the failing order back whole, and still expires the others", async () => {
    const shop = await stocked();
    const bad = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    const good = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    await database.pool.query(`CREATE FUNCTION fail_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status = 'expired' AND OLD.id = '${bad}' THEN RAISE EXCEPTION 'expiry blocked for test'; END IF; RETURN NEW; END $$`);
    await database.pool.query("CREATE TRIGGER fail_expiry BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION fail_expiry()");
    at("2030-01-01T00:10:00.000Z");
    await expect(expire()).rejects.toThrow("Some orders could not be expired");
    expect([await statusOf(bad), await statusOf(good)]).toEqual(["placed", "expired"]);
    expect(await history(bad)).toEqual([]);
    expect((await expiredNotices()).map(({ order_id }) => order_id)).toEqual([good]);
    expect(await runs()).toEqual([{ status: "failed", error_text: "expiry failed" }]);
    await database.pool.query("DROP TRIGGER fail_expiry ON orders");
    at("2030-01-01T00:11:00.000Z");
    await expire();
    expect([await statusOf(bad), await statusOf(good)]).toEqual(["expired", "expired"]);
    expect((await expiredNotices()).map(({ order_id }) => order_id).sort()).toEqual([bad, good].sort());
    expect((await runs()).map(({ status }) => status)).toEqual(["failed", "ok"]);
  });

  it("keeps the status, history and notice of one order together when the notice cannot be written", async () => {
    const shop = await stocked();
    const id = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    await database.pool.query("ALTER TABLE notifications ADD CONSTRAINT block_expired CHECK (kind <> 'order_expired')");
    at("2030-01-01T00:10:00.000Z");
    await expect(expire()).rejects.toThrow("Some orders could not be expired");
    expect(await statusOf(id)).toBe("placed");
    expect(await history(id)).toEqual([]);
    expect(await expiredNotices()).toEqual([]);
    expect(await runs()).toEqual([{ status: "failed", error_text: "expiry failed" }]);
  });

  it("follows ORDER_EXPIRE_SECONDS and ORDER_REALERT_SECONDS", async () => {
    const shop = await stocked();
    const id = await placedAt(shop, "2030-01-01T00:00:00.000Z");
    setOrderTiming({ reRingSeconds: 60, expireSeconds: 300 });
    try {
      at("2030-01-01T00:04:59.000Z");
      await expire();
      expect(await statusOf(id)).toBe("placed");
      at("2030-01-01T00:05:00.000Z");
      await expire();
      expect(await statusOf(id)).toBe("expired");
    } finally {
      setOrderTiming({ reRingSeconds: 120, expireSeconds: 600 });
    }
  });
});
