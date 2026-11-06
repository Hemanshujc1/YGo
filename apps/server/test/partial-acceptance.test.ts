import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { setOrderTiming } from "../src/order-timing";
import { stockOf } from "../src/listings";
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
let owner: { authorization: string };

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

const here = "pincode=411038&latitude=18.5&longitude=73.8";

const card = {
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};

async function publish(scope: object, values: object) {
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope, values, reason: "Card" } });
  expect(response.statusCode).toBe(201);
}

async function shop(shopName: string, northMetres = 300) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, 'live', $2, 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, $3::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2031-03-31', 'asha@upi', 2000, now(), now())`,
    [id, shopName, northMetres]);
  return id;
}

async function category(categoryName: string) {
  const found = await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = $1", [categoryName]);
  const row = found.rows[0] ? found : await database.pool.query<{ id: string }>("INSERT INTO categories (name) VALUES ($1) RETURNING id", [categoryName]);
  return row.rows[0]?.id ?? "";
}

async function product(shopId: string, categoryId: string, productName: string, baseUnit: string, packs: Array<{ quantity: string; price: string; stock: string }>, brand: string | null = null) {
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, brand, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($1, $5, $2, $3, $4, true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`,
    [productName, categoryId, baseUnit, baseUnit === "each" ? "counted" : "measured", brand]);
  const productId = row.rows[0]?.id ?? "";
  const listings: string[] = [];
  for (const pack of packs) {
    const packId = randomUUID();
    const listingId = randomUUID();
    await database.pool.query("INSERT INTO packs (id, product_id, quantity) VALUES ($1, $2, $3)", [packId, productId, pack.quantity]);
    await database.pool.query(
      "INSERT INTO shop_listings (id, shop_id, pack_id, online_price, counter_price, mrp, available) VALUES ($1, $2, $3, $4, $4, $4, true)",
      [listingId, shopId, packId, pack.price]);
    await database.pool.query(
      "INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) VALUES ($1, $2, $3, 'opening', $4)",
      [listingId, randomUUID(), randomUUID(), pack.stock]);
    listings.push(listingId);
  }
  return { productId, listings };
}

async function address(email: string) {
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
     SELECT id, 'home', 'Flat 4B', 'Kothrud', '411038',
       ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 0::float8, 0::float8)::geography, now()
     FROM accounts WHERE email = $1 RETURNING id`, [email]);
  return row?.id ?? "";
}

const left = async (listingId: string) => {
  const { rows } = await database.pool.query<{ stock: string }>(
    `SELECT ${stockOf("listing")} AS stock FROM shop_listings listing WHERE listing.id = $1`, [listingId]);
  return Number(rows[0]?.stock);
};

beforeEach(async () => {
  setOrderTiming({ reRingSeconds: 120, expireSeconds: 600, confirmSeconds: 300 });
  name = `ygo_partial_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signIn("/v1/admin/auth", adminEmail);
  customer = await signIn("/v1/auth", "customer@example.com");
  owner = await signIn("/v1/auth", "owner@example.com");

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

async function setupShopWithOrder() {
  const shopId = await shop("Sai General Stores");
  await publish({ type: "global" }, card);
  const groceries = await category("Groceries");
  const dal = (await product(shopId, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "100", stock: "10" }])).listings[0] as string;
  const atta = (await product(shopId, groceries, "Atta", "kg", [{ quantity: "5", price: "200", stock: "10" }])).listings[0] as string;
  await database.pool.query("UPDATE accounts SET name = 'Asha', phone = '+919876500001' WHERE email = 'owner@example.com'");
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);

  const home = await address("customer@example.com");
  const getRes = await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer });
  const { revision } = getRes.json() as { revision: number };
  const cartRes = await app.inject({
    method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
    payload: { revision, lines: [{ listingId: dal, count: 2 }, { listingId: atta, count: 1 }] },
  });
  const cart = cartRes.json() as { revision: number; quote: { total: string } };

  const placed = await app.inject({
    method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
    payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
  });
  expect(placed.statusCode).toBe(201);
  const orderId = (placed.json() as { id: string }).id;

  return { shopId, dal, atta, orderId, home };
}

/** Another order of `count` dal at the same shop, placed and accepted, so it holds that stock. */
async function acceptedOrder(shopId: string, home: string, dal: string, count: number) {
  const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
  const cart = (await app.inject({
    method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer, payload: { revision, lines: [{ listingId: dal, count }] },
  })).json() as { revision: number; quote: { total: string } };
  const placed = await app.inject({
    method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer, payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
  });
  expect(placed.statusCode).toBe(201);
  const accepted = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${(placed.json() as { id: string }).id}/accept`, headers: owner });
  expect(accepted.statusCode).toBe(200);
}

describe("S05 Accept in part: partial acceptance (#64)", () => {
  it("proposes partial acceptance from placed, reductions only with reason, transitions to awaiting_customer_confirm", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    // Propose: reduce dal from 2 to 1, keep atta at 1
    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      confirmByAt: string;
      proposal: {
        sourceStatus: string;
        productValue: string;
        deliveryFee: string;
        total: string;
        originalProductValue: string;
        originalTotal: string;
        lines: Array<{ listingId: string; count: number; originalCount: number; changeReason: string | null; lineTotal: string }>;
      };
    };
    expect(body.status).toBe("awaiting_customer_confirm");
    expect(body.confirmByAt).toBeTruthy();
    expect(body.proposal).toMatchObject({
      sourceStatus: "placed",
      productValue: "300.00",
      deliveryFee: "30.00",
      total: "330.00",
      originalProductValue: "400.00",
      originalTotal: "430.00",
    });
    expect(body.proposal.lines).toHaveLength(2);
    const dalLine = body.proposal.lines.find((l) => l.listingId === dal);
    expect(dalLine).toMatchObject({ count: 1, originalCount: 2, changeReason: "out_of_stock", lineTotal: "100.00" });
  });

  it("can propose partial acceptance from accepted and preparing status", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    // Accept order first
    const acceptRes = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });
    expect(acceptRes.statusCode).toBe(200);

    // Now partial accept from accepted
    const partialRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "damaged" }] },
    });
    expect(partialRes.statusCode).toBe(200);
    expect(partialRes.json()).toMatchObject({ status: "awaiting_customer_confirm", proposal: { sourceStatus: "accepted" } });
  });

  it("refuses increasing quantity, zero remaining lines, missing reasons, or duplicate proposals", async () => {
    const { orderId, dal, atta } = await setupShopWithOrder();

    // Increase dal from 2 to 3 -> INVALID_PARTIAL_ACCEPT
    const inc = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 3, reason: "quality_issue" }] },
    });
    expect(inc.statusCode).toBe(400);
    expect(inc.json()).toMatchObject({ error: { code: "INVALID_PARTIAL_ACCEPT" } });

    // Missing reason on reduction -> INVALID_PARTIAL_ACCEPT
    const noReason = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1 }] },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ error: { code: "INVALID_PARTIAL_ACCEPT" } });

    // No lines changed -> INVALID_PARTIAL_ACCEPT
    const noChange = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 2 }] },
    });
    expect(noChange.statusCode).toBe(400);

    // Reduce all lines to 0 -> EMPTY_ORDER
    const empty = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 0, reason: "out_of_stock" }, { listingId: atta, count: 0, reason: "out_of_stock" }] },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "EMPTY_ORDER" } });

    // Valid proposal
    const valid = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(valid.statusCode).toBe(200);

    // Attempting a second proposal while one is open -> PROPOSAL_OPEN
    const second = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: atta, count: 0, reason: "damaged" }] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "PROPOSAL_OPEN" } });
  });

  it("refuses a proposal from placed that would hold stock another order took since placement, and allows one that fits", async () => {
    const { shopId, dal, atta, orderId, home } = await setupShopWithOrder();
    // The placed order holds nothing; another order takes 9 of the 10 kg of dal, leaving 1.
    await acceptedOrder(shopId, home, dal, 9);
    expect(await left(dal)).toBe(1);

    // Removing atta but keeping 2 kg of dal would hold 2 kg where 1 is left.
    const short = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: atta, count: 0, reason: "out_of_stock" }] },
    });
    expect(short.statusCode).toBe(409);
    expect(short.json()).toEqual({ error: { code: "NOT_ENOUGH_STOCK", shortLines: [
      { name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, available: "1" },
    ] } });
    const status = await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(status.rows[0]?.status).toBe("placed");
    expect(await left(dal)).toBe(1);

    // Cutting dal to the 1 kg left fits.
    const fits = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }, { listingId: atta, count: 0, reason: "out_of_stock" }] },
    });
    expect(fits.statusCode).toBe(200);
    expect(fits.json()).toMatchObject({ status: "awaiting_customer_confirm" });
    expect(await left(dal)).toBe(0);
  });

  it("lets an accepted order cut its own hold even when other orders took all the stock left", async () => {
    const { shopId, dal, orderId, home } = await setupShopWithOrder();
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner })).statusCode).toBe(200);
    // This order holds 2 kg of dal; another takes the other 8.
    await acceptedOrder(shopId, home, dal, 8);
    expect(await left(dal)).toBe(0);

    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "damaged" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(await left(dal)).toBe(1);
  });

  it("cancels immediately as cancelled_by_shop (actor system, reason negative_contribution) when platform contribution is negative", async () => {
    const { shopId, dal } = await setupShopWithOrder();
    const versionRow = await database.pool.query<{ version: string }>("SELECT version FROM rate_card_versions ORDER BY version DESC LIMIT 1");
    const version = versionRow.rows[0]?.version;
    const customerAccount = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = 'customer@example.com'");
    const customerId = customerAccount.rows[0]?.id;

    const fakeQuote = {
      productValue: "200.00",
      customerTotal: "230.00",
      deliveryFee: { amount: "30.00", platformShare: "-50.00", shopShare: "80.00" },
      smallCartFee: null,
      rateCardVersion: version,
    };

    const now = clock.now();
    const inserted = await database.pool.query<{ id: string }>(
      `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, address_label, address_flat,
         address_pincode, address_point, product_value, delivery_fee, total, rate_card_version, quote)
       VALUES ($1, $2, 'placed', $5, $5, 'Sai General Stores', 'Paud Road', '411045', 'home', '101', '411038',
         ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 200, 30, 230, $3, $4) RETURNING id`,
      [customerId, shopId, version, JSON.stringify(fakeQuote), now]);
    const orderId = inserted.rows[0]?.id as string;

    await database.pool.query(
      `INSERT INTO order_lines (order_id, position, listing_id, name, base_unit, pack_quantity, count, unit_price, line_total, stock_quantity)
       VALUES ($1, 0, $2, 'Toor Dal', 'kg', 1, 2, 100, 200, 2)`,
      [orderId, dal]);

    // Partial accept reduces dal from 2 to 1
    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "NEGATIVE_CONTRIBUTION_CANCELLED" } });

    // Order was cancelled
    const check = await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0]?.status).toBe("cancelled_by_shop");

    // History record shows actor system and reason negative_contribution
    const hist = await database.pool.query<{ actor_role: string; reason_code: string }>(
      "SELECT actor_role, reason_code FROM order_status_history WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1", [orderId]);
    expect(hist.rows[0]).toMatchObject({ actor_role: "system", reason_code: "negative_contribution" });

    // A negative-contribution cancellation is not a below-floor exception
    const adminRes = await app.inject({ method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin });
    expect(adminRes.statusCode).toBe(200);
    expect((adminRes.json().exceptions as Array<{ orderId: string }>).some((e) => e.orderId === orderId)).toBe(false);
  });

  it("records below floor exception (D-5) when contribution is below floor but non-negative, and lists on admin endpoint", async () => {
    const { orderId, dal, atta } = await setupShopWithOrder();

    // Global floor is ₹15.
    // If Dal count reduced to 1 and Atta removed (count = 0):
    // Dal total = ₹100. Commission at 10% = ₹10.
    // Delivery fee = ₹30 (platform share 20% = ₹6).
    // Contribution = ₹10 + ₹6 = ₹16 (above floor ₹15).
    // To make contribution below floor but non-negative:
    // Set global rate card with floor ₹20: contribution ₹16 < floor ₹20.
    await publish({ type: "global" }, { ...card, deliveredContributionFloor: "20" });

    // Partial accept: reduce dal to 1, remove atta (count = 0)
    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }, { listingId: atta, count: 0, reason: "out_of_stock" }] },
    });
    expect(res.statusCode).toBe(200);

    // Verify revision record stored exception
    const rev = await database.pool.query<{ below_floor_exception: boolean; below_floor_shortfall: string | null }>(
      "SELECT below_floor_exception, below_floor_shortfall FROM order_revisions WHERE order_id = $1", [orderId]);
    expect(rev.rows[0]?.below_floor_exception).toBe(false);
    expect(rev.rows[0]?.below_floor_shortfall).toBeNull();
  });

  it("records below floor exception on original rate card floor", async () => {
    const shopId = await shop("High Floor Shop");
    await publish({ type: "global" }, { ...card, deliveredContributionFloor: "25" });
    const groceries = await category("GroceriesHF");
    const item = (await product(shopId, groceries, "Sugar", "kg", [{ quantity: "1", price: "50", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);

    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: item, count: 4 }] },
    })).json() as { revision: number; quote: { total: string } };

    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    const orderId = (placed.json() as { id: string }).id;

    // Reduce sugar count to 2 (subtotal ₹100, commission ₹10 + delivery platform share ₹6 = ₹16 contribution).
    // Floor is ₹25, so shortfall is ₹9.00
    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: item, count: 2, reason: "out_of_stock" }] },
    });
    expect(res.statusCode).toBe(200);

    const rev = await database.pool.query<{ below_floor_exception: boolean; below_floor_shortfall: string }>(
      "SELECT below_floor_exception, below_floor_shortfall FROM order_revisions WHERE order_id = $1", [orderId]);
    expect(rev.rows[0]?.below_floor_exception).toBe(true);
    expect(rev.rows[0]?.below_floor_shortfall).toBe("9.00");

    // Check admin exceptions queue endpoint
    const adminRes = await app.inject({
      method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin,
    });
    expect(adminRes.statusCode).toBe(200);
    const exceptions = adminRes.json().exceptions as Array<{ orderId: string; shortfall: string }>;
    expect(exceptions.some((e) => e.orderId === orderId && e.shortfall === "9.00")).toBe(true);
  });

  it("below-floor proposal that is declined is not shown in admin exceptions queue", async () => {
    const shopId = await shop("BF Declined Shop");
    await publish({ type: "global" }, { ...card, deliveredContributionFloor: "25" });
    const groceries = await category("GroceriesBFD");
    const item = (await product(shopId, groceries, "Rice BFD", "kg", [{ quantity: "1", price: "50", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);
    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: item, count: 4 }] },
    })).json() as { revision: number; quote: { total: string } };
    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    const orderId = (placed.json() as { id: string }).id;

    // Create a below-floor proposal
    const propRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: item, count: 2, reason: "out_of_stock" }] },
    });
    expect(propRes.statusCode).toBe(200);

    // Customer declines the proposal
    const declineRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/decline-total`, headers: customer,
    });
    expect(declineRes.statusCode).toBe(200);
    expect(declineRes.json()).toMatchObject({ status: "cancelled_by_customer" });

    // Declined revision must NOT appear in admin exceptions queue
    const adminRes = await app.inject({
      method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin,
    });
    expect(adminRes.statusCode).toBe(200);
    const exceptions = adminRes.json().exceptions as Array<{ orderId: string }>;
    expect(exceptions.some((e) => e.orderId === orderId)).toBe(false);
  });

  it("below-floor proposal that expires is not shown in admin exceptions queue", async () => {
    const shopId = await shop("BF Expired Shop");
    await publish({ type: "global" }, { ...card, deliveredContributionFloor: "25" });
    const groceries = await category("GroceriesBFE");
    const item = (await product(shopId, groceries, "Lentils BFE", "kg", [{ quantity: "1", price: "50", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);
    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: item, count: 4 }] },
    })).json() as { revision: number; quote: { total: string } };
    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    const orderId = (placed.json() as { id: string }).id;

    // Create a below-floor proposal, then backdate confirm_by_at to simulate expiry
    const propRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: item, count: 2, reason: "out_of_stock" }] },
    });
    expect(propRes.statusCode).toBe(200);

    // Expire the proposal via the expire-confirmations job logic (mark directly as expired + cancel order)
    await database.pool.query(
      `UPDATE order_revisions SET status = 'expired'
       WHERE order_id = $1 AND status = 'proposed'`,
      [orderId],
    );
    await database.pool.query(
      `UPDATE orders SET status = 'cancelled_by_customer' WHERE id = $1`,
      [orderId],
    );

    // Expired revision must NOT appear in admin exceptions queue
    const adminRes = await app.inject({
      method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin,
    });
    expect(adminRes.statusCode).toBe(200);
    const exceptions = adminRes.json().exceptions as Array<{ orderId: string }>;
    expect(exceptions.some((e) => e.orderId === orderId)).toBe(false);
  });

  it("valid pending (proposed) below-floor exception appears in admin queue; confirmed exception also appears", async () => {
    const shopId = await shop("BF Active Shop");
    await publish({ type: "global" }, { ...card, deliveredContributionFloor: "25" });
    const groceries = await category("GroceriesBFA");
    const item = (await product(shopId, groceries, "Oil BFA", "kg", [{ quantity: "1", price: "50", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);
    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: item, count: 4 }] },
    })).json() as { revision: number; quote: { total: string } };
    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    const orderId = (placed.json() as { id: string }).id;

    // Proposal → below-floor (shortfall 9.00), still pending (proposed)
    const propRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: item, count: 2, reason: "out_of_stock" }] },
    });
    expect(propRes.statusCode).toBe(200);

    // Pending proposal must appear
    const adminRes1 = await app.inject({ method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin });
    expect(adminRes1.statusCode).toBe(200);
    const ex1 = adminRes1.json().exceptions as Array<{ orderId: string; shortfall: string }>;
    expect(ex1.some((e) => e.orderId === orderId && e.shortfall === "9.00")).toBe(true);

    // Customer confirms → revision becomes confirmed; must still appear
    const confirmRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(confirmRes.statusCode).toBe(200);

    const adminRes2 = await app.inject({ method: "GET", url: "/v1/admin/orders/below-floor-exceptions", headers: admin });
    expect(adminRes2.statusCode).toBe(200);
    const ex2 = adminRes2.json().exceptions as Array<{ orderId: string; shortfall: string }>;
    expect(ex2.some((e) => e.orderId === orderId && e.shortfall === "9.00")).toBe(true);
  });
});

describe("C10 Customer confirmation and decline (#64)", () => {
  it("customer confirms: order returns to sourceStatus and reflects confirmed revision total", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    // Accept order first (sourceStatus = accepted)
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });

    // Shopkeeper proposes reduction
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Customer confirms total
    const confirmRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(confirmRes.statusCode).toBe(200);
    const order = confirmRes.json() as { status: string; total: string; lines: unknown[]; proposal: unknown };
    expect(order.status).toBe("accepted");
    expect(order.total).toBe("330.00");
    expect(order.proposal).toBeNull();

    // Customer order list C18 reflects confirmed total
    const listRes = await app.inject({ method: "GET", url: "/v1/orders", headers: customer });
    expect(listRes.statusCode).toBe(200);
    const active = listRes.json().active as Array<{ id: string; total: string }>;
    expect(active.find((o) => o.id === orderId)?.total).toBe("330.00");
  });

  it("customer declines: order cancelled as cancelled_by_customer (actor customer, reason declined_total)", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    const declineRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/decline-total`, headers: customer,
    });
    expect(declineRes.statusCode).toBe(200);
    expect(declineRes.json()).toMatchObject({ status: "cancelled_by_customer" });

    // History record
    const hist = await database.pool.query<{ actor_role: string; reason_code: string }>(
      "SELECT actor_role, reason_code FROM order_status_history WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1", [orderId]);
    expect(hist.rows[0]).toMatchObject({ actor_role: "customer", reason_code: "declined_total" });
  });

  it("customer cancels via /v1/orders/:id/cancel during awaiting_customer_confirm: proposal declined, order cancelled with declined_total reason, stock released", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Dal held at 1 during awaiting_customer_confirm (started with 10 on hand, 2 originally ordered, reduced to 1)
    expect(await left(dal)).toBe(9);

    const cancelRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/cancel`, headers: customer,
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toMatchObject({ status: "cancelled_by_customer" });

    // Revision marked declined
    const { rows: [rev] } = await database.pool.query<{ status: string }>(
      "SELECT status FROM order_revisions WHERE order_id = $1 ORDER BY revision DESC LIMIT 1", [orderId]);
    expect(rev?.status).toBe("declined");

    // Order status history records declined_total with actor customer
    const hist = await database.pool.query<{ from_status: string; to_status: string; actor_role: string; reason_code: string }>(
      "SELECT from_status, to_status, actor_role, reason_code FROM order_status_history WHERE order_id = $1 ORDER BY at DESC, id DESC LIMIT 1", [orderId]);
    expect(hist.rows[0]).toMatchObject({
      from_status: "awaiting_customer_confirm",
      to_status: "cancelled_by_customer",
      actor_role: "customer",
      reason_code: "declined_total",
    });

    // Stock completely released: all 10 on hand available again
    expect(await left(dal)).toBe(10);

    // Notification generated with specific declined wording
    const notif = await database.pool.query<{ title: string; body: string }>(
      "SELECT title, body FROM notifications WHERE order_id = $1 AND kind = 'order_cancelled_by_customer'", [orderId]);
    expect(notif.rows[0]?.body).toBe("The customer declined the updated order.");
  });

  it("cancel via /v1/orders/:id/cancel after confirmation deadline returns CONFIRMATION_EXPIRED", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Advance clock past 300 s confirmation window
    clock.set(new Date("2030-01-01T00:05:01.000Z"));

    const cancelRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/cancel`, headers: customer,
    });
    expect(cancelRes.statusCode).toBe(409);
    expect(cancelRes.json()).toMatchObject({ error: { code: "CONFIRMATION_EXPIRED" } });
  });

  it("confirmation after expiry deadline is refused with CONFIRMATION_EXPIRED", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Advance clock past 300 s confirmation window
    clock.set(new Date("2030-01-01T00:05:01.000Z"));

    const confirmRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(confirmRes.statusCode).toBe(409);
    expect(confirmRes.json()).toMatchObject({ error: { code: "CONFIRMATION_EXPIRED" } });
  });

  it("confirmation at exact deadline (now == confirmByAt) is refused with CONFIRMATION_EXPIRED, but succeeds 1ms before", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    const propRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    const confirmByAt = new Date((propRes.json() as { confirmByAt: string }).confirmByAt);

    // 1 ms before deadline succeeds
    clock.set(new Date(confirmByAt.getTime() - 1));
    const beforeRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(beforeRes.statusCode).toBe(200);

    // Reopen another proposal to test exact deadline
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 0, reason: "out_of_stock" }] },
    });
    const { rows: [p2] } = await database.pool.query<{ confirm_by_at: Date }>(
      "SELECT confirm_by_at FROM order_revisions WHERE order_id = $1 AND status = 'proposed'", [orderId]);
    const deadline = p2?.confirm_by_at as Date;

    // Exact deadline (now == confirmByAt) is refused
    clock.set(deadline);
    const atDeadlineRes = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(atDeadlineRes.statusCode).toBe(409);
    expect(atDeadlineRes.json()).toMatchObject({ error: { code: "CONFIRMATION_EXPIRED" } });
  });
});

describe("Stock holds during partial acceptance (#64)", () => {
  it("holds stock at reduced quantities during awaiting_customer_confirm, releases on decline", async () => {
    const { orderId, dal } = await setupShopWithOrder();
    // Accept the order first so it holds stock (accepted orders hold stock)
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });

    // Dal started with 10 stock. Placed order held 2. Available stock was 8.
    const checkStockBefore = async () => {
      const { rows } = await database.pool.query<{ stock: string }>(
        `SELECT ${stockOf("listing")} AS stock FROM shop_listings listing WHERE listing.id = $1`, [dal]);
      return Number(rows[0]?.stock);
    };
    expect(await checkStockBefore()).toBe(8);

    // Partial accept reduces dal from 2 to 1
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Dal now holds only 1, so 9 is available to sell
    expect(await checkStockBefore()).toBe(9);

    // Decline releases all holds
    await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/decline-total`, headers: customer,
    });

    // Dal hold is 0, so 10 is available to sell
    expect(await checkStockBefore()).toBe(10);
  });

  it("never restores original stock quantities when revisions exist but no active revision is found", async () => {
    const { orderId, dal } = await setupShopWithOrder();
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });

    const checkDalStock = async () => {
      const { rows } = await database.pool.query<{ stock: string }>(
        `SELECT ${stockOf("listing")} AS stock FROM shop_listings listing WHERE listing.id = $1`, [dal]);
      return Number(rows[0]?.stock);
    };

    // Initially order holds 2 dal, so 8 is available to sell
    expect(await checkDalStock()).toBe(8);

    // Propose partial accept (holds 1 dal, 9 available)
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(await checkDalStock()).toBe(9);

    // If revision becomes declined (terminal), order has revisions but no active revision
    await database.pool.query("UPDATE order_revisions SET status = 'declined' WHERE order_id = $1", [orderId]);
    // With revisions existing but no active revision found, heldOf produces 0 (does NOT restore original 2)
    expect(await checkDalStock()).toBe(10);
  });
});

describe("Partial quantity handling (#64, #377)", () => {
  it("handles orders with measured part lines: count 0 removes and releases stock, count 1 preserves part", async () => {
    const shopId = await shop("Measured Shop");
    await publish({ type: "global" }, card);
    const groceries = await category("GroceriesMeasured");
    // Listing 1: counted dal (stock 10)
    const dal = (await product(shopId, groceries, "Moong Dal", "kg", [{ quantity: "1", price: "100", stock: "10" }])).listings[0] as string;
    // Listing 2: measured wheat pack 10 kg, stock 5 kg left (cart sells it as a part line of 5 kg, #377)
    const wheat = (await product(shopId, groceries, "Gehun", "kg", [{ quantity: "10", price: "60", stock: "5" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);

    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: dal, count: 2 }, { listingId: wheat, count: 1 }] },
    })).json() as { revision: number; quote: { total: string } };

    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    expect(placed.statusCode).toBe(201);
    const orderId = (placed.json() as { id: string }).id;

    // Accept order so it holds stock
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });

    const checkWheatStock = async () => {
      const { rows } = await database.pool.query<{ stock: string }>(
        `SELECT ${stockOf("listing")} AS stock FROM shop_listings listing WHERE listing.id = $1`, [wheat]);
      return Number(rows[0]?.stock);
    };
    // Wheat has 5 on hand and order holds 5, so 0 is available
    expect(await checkWheatStock()).toBe(0);

    // Attempting count: 2 on a part line is rejected
    const badCount = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: wheat, count: 2, reason: "out_of_stock" }] },
    });
    expect(badCount.statusCode).toBe(400);

    // Attempting to send partQuantity field is rejected by strict schema validation
    const unsupported = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: wheat, count: 1, partQuantity: "3.000", reason: "out_of_stock" }] },
    });
    expect(unsupported.statusCode).toBe(400);

    // Partial accept: keep wheat at count 1, reduce dal from 2 to 1
    const keepPartRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(keepPartRes.statusCode).toBe(200);
    const keepBody = keepPartRes.json() as { proposal: { lines: Array<{ listingId: string; count: number; originalPart: string | null; part: string | null }> } };
    const wheatLine = keepBody.proposal.lines.find((l) => l.listingId === wheat);
    expect(wheatLine?.originalPart).toBe("5");
    expect(wheatLine?.part).toBe("5");
    expect(wheatLine?.count).toBe(1);

    // Customer confirms proposal 1
    await app.inject({ method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer });

    // Partial accept 2: remove wheat part line (count: 0)
    const removePartRes = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: wheat, count: 0, reason: "out_of_stock" }] },
    });
    expect(removePartRes.statusCode).toBe(200);
    const removeBody = removePartRes.json() as { proposal: { lines: Array<{ listingId: string; count: number; originalPart: string | null; part: string | null }> } };
    const removedWheat = removeBody.proposal.lines.find((l) => l.listingId === wheat);
    expect(removedWheat?.originalPart).toBe("5");
    expect(removedWheat?.part).toBeNull();
    expect(removedWheat?.count).toBe(0);

    // Stock hold for wheat is now released (5 available)
    expect(await checkWheatStock()).toBe(5);
  });
});

describe("Validation and duplicate listing IDs (#64)", () => {
  it("rejects duplicate listing IDs in partial-accept body with 409 INVALID_PARTIAL_ACCEPT", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    const res = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }, { listingId: dal, count: 0, reason: "out_of_stock" }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_PARTIAL_ACCEPT" } });
  });
});

describe("Strengthened revision trigger and lifecycle consistency (#64)", () => {
  it("trigger only permits proposed -> confirmed, declined, expired; rejects modifying terminal revisions", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    const { rows: [rev] } = await database.pool.query<{ id: string }>(
      "SELECT id FROM order_revisions WHERE order_id = $1 AND status = 'proposed'", [orderId]);
    const revId = rev?.id as string;

    // Transitioning to confirmed without confirmed_at is refused
    await expect(database.pool.query(
      "UPDATE order_revisions SET status = 'confirmed' WHERE id = $1", [revId]
    )).rejects.toThrow(/append-only.*refused/);

    // Transitioning to declined with confirmed_at is refused
    await expect(database.pool.query(
      "UPDATE order_revisions SET status = 'declined', confirmed_at = now() WHERE id = $1", [revId]
    )).rejects.toThrow(/append-only.*refused/);

    // Modifying other columns during status transition is refused
    await expect(database.pool.query(
      "UPDATE order_revisions SET status = 'declined', product_value = 100 WHERE id = $1", [revId]
    )).rejects.toThrow(/append-only.*refused/);

    // Valid decline transition succeeds
    await database.pool.query("UPDATE order_revisions SET status = 'declined' WHERE id = $1", [revId]);

    // Modifying terminal revision (declined -> confirmed) is refused
    await expect(database.pool.query(
      "UPDATE order_revisions SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [revId]
    )).rejects.toThrow(/append-only.*refused/);
  });

  it("prevents order from leaving awaiting_customer_confirm while a proposed revision exists", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Attempting to move order status away from awaiting_customer_confirm while proposal is still proposed is refused
    await expect(database.pool.query(
      "UPDATE orders SET status = 'placed', status_changed_at = now() WHERE id = $1", [orderId]
    )).rejects.toThrow(/cannot leave awaiting_customer_confirm with an open proposal/);
  });

  it("enforces database constraints for revision number, timestamps, below floor, and line reduction reason", async () => {
    const { orderId, dal } = await setupShopWithOrder();

    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    const { rows: [rev] } = await database.pool.query<{ id: string }>(
      "SELECT id FROM order_revisions WHERE order_id = $1 AND status = 'proposed'", [orderId]);
    const revId = rev?.id as string;

    // Revision number must be positive (>= 1)
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, confirm_by_at, created_at
       ) VALUES ($1, 0, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, now() + interval '5 min', now())`,
      [orderId]
    )).rejects.toThrow(/order_revisions_revision_positive/);

    // confirm_by_at must be >= created_at
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, confirm_by_at, created_at
       ) VALUES ($1, 99, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, now() - interval '1 hour', now())`,
      [orderId]
    )).rejects.toThrow(/order_revisions_confirm_by_at_valid/);

    // confirmed revision must have confirmed_at >= created_at (cannot have confirmed_at < created_at)
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, confirm_by_at, created_at, confirmed_at
       ) VALUES ($1, 99, 'confirmed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, now() + interval '5 min', now(), now() - interval '1 hour')`,
      [orderId]
    )).rejects.toThrow(/order_revisions_confirmed_at_valid/);

    // proposed revision cannot have confirmed_at set
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, confirm_by_at, created_at, confirmed_at
       ) VALUES ($1, 99, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, now() + interval '5 min', now(), now())`,
      [orderId]
    )).rejects.toThrow(/order_revisions_confirmed_at_valid/);

    // below_floor_exception = true requires shortfall > 0
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at
       ) VALUES ($1, 99, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, true, NULL, now() + interval '5 min', now())`,
      [orderId]
    )).rejects.toThrow(/order_revisions_below_floor_valid/);

    // below_floor_exception = false cannot have shortfall
    await expect(database.pool.query(
      `INSERT INTO order_revisions (
         order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
         platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at
       ) VALUES ($1, 99, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, 15.00, now() + interval '5 min', now())`,
      [orderId]
    )).rejects.toThrow(/order_revisions_below_floor_valid/);

    // order_revision_lines requires change_reason when count < original_count
    await expect(database.pool.query(
      `INSERT INTO order_revision_lines (
         revision_id, position, listing_id, name, base_unit, pack_quantity, original_count, count, unit_price, line_total, commission, stock_quantity, change_reason
       ) VALUES ($1, 99, $2, 'Toor Dal', 'kg', 1, 2, 1, 100, 100, 10, 1, NULL)`,
      [revId, dal]
    )).rejects.toThrow(/order_revision_lines_reduction_reason/);

    // Trigger rejects confirming revision if order is NOT awaiting_customer_confirm
    const { rows: [placedOrder] } = await database.pool.query<{ id: string }>(
      "SELECT id FROM orders WHERE status = 'placed' LIMIT 1");
    if (placedOrder) {
      const { rows: [dummyRev] } = await database.pool.query<{ id: string }>(
        `INSERT INTO order_revisions (
           order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission,
           platform_contribution, quote, below_floor_exception, confirm_by_at, created_at
         ) VALUES ($1, 999, 'proposed', 'placed', 'owner', 100, 30, 130, 10, 20, '{}'::jsonb, false, now() + interval '5 min', now()) RETURNING id`,
        [placedOrder.id]
      );
      if (!dummyRev) throw new Error("dummyRev not found");
      await expect(database.pool.query(
        "UPDATE order_revisions SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [dummyRev.id]
      )).rejects.toThrow(/Cannot confirm revision.*order is not awaiting_customer_confirm/);
    }
  });
});

describe("Successive revisions (#64)", () => {
  it("corrects original totals in proposals and admin exceptions for successive revisions", async () => {
    const { orderId, dal, atta } = await setupShopWithOrder();
    // Order started: 2 dal (₹200) + 1 atta (₹200) = ₹400 subtotal, ₹30 delivery = ₹430 total.
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/accept`, headers: owner });

    // Revision 1: reduce dal from 2 to 1.
    // Product value becomes ₹300, total ₹330.
    const res1 = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });
    expect(res1.statusCode).toBe(200);

    // Customer confirms revision 1
    const confirm1 = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(confirm1.statusCode).toBe(200);
    expect((confirm1.json() as { total: string }).total).toBe("330.00");

    // Revision 2: remove atta (reduce atta from 1 to 0).
    // Now originalProductValue should be ₹300 and originalTotal should be ₹330 (from revision 1, not ₹430).
    const res2 = await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: atta, count: 0, reason: "damaged" }] },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as {
      proposal: {
        revision: number;
        originalProductValue: string;
        originalTotal: string;
        productValue: string;
        total: string;
        lines: Array<{ listingId: string; originalCount: number; count: number }>;
      };
    };
    expect(body2.proposal.revision).toBe(2);
    expect(body2.proposal.originalProductValue).toBe("300.00");
    expect(body2.proposal.originalTotal).toBe("330.00");
    expect(body2.proposal.productValue).toBe("100.00");
    expect(body2.proposal.total).toBe("130.00");

    const dalLine = body2.proposal.lines.find((l) => l.listingId === dal);
    expect(dalLine?.originalCount).toBe(1);
    expect(dalLine?.count).toBe(1);

    const attaLine = body2.proposal.lines.find((l) => l.listingId === atta);
    expect(attaLine?.originalCount).toBe(1);
    expect(attaLine?.count).toBe(0);

    // Customer confirms revision 2
    const confirm2 = await app.inject({
      method: "POST", url: `/v1/orders/${orderId}/confirm-total`, headers: customer,
    });
    expect(confirm2.statusCode).toBe(200);
    expect((confirm2.json() as { total: string }).total).toBe("130.00");
  });
});

describe("Concurrent stock consumption (#64)", () => {
  it("reduced hold allows another customer to order remaining stock; subsequent over-consumption is refused", async () => {
    const shopId = await shop("Concurrency Shop");
    await publish({ type: "global" }, card);
    const groceries = await category("GroceriesConcurrency");
    // Dal has stock 10
    const dal = (await product(shopId, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "100", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);

    const homeA = await address("customer@example.com");
    // Customer A places order for 4 dal (holds 4, 6 available)
    const { revision: revA } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cartA = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision: revA, lines: [{ listingId: dal, count: 4 }] },
    })).json() as { revision: number; quote: { total: string } };
    const placedA = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cartA.revision, total: cartA.quote.total, addressId: homeA },
    });
    const orderIdA = (placedA.json() as { id: string }).id;
    await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderIdA}/accept`, headers: owner });

    // Shopkeeper proposes partial accept on order A: reduce dal from 4 to 2 (now holds 2, 8 available)
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderIdA}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 2, reason: "out_of_stock" }] },
    });

    // Customer B signs in and tries to order 8 dal (succeeds because 8 is available)
    // Customer B signs in and tries to order 8 dal (succeeds because 8 is available)
    const customerB = await signIn("/v1/auth", "customer2@example.com");
    const homeB = await address("customer2@example.com");
    const { revision: revB } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customerB })).json() as { revision: number };
    const cartB = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customerB,
      payload: { revision: revB, lines: [{ listingId: dal, count: 8 }] },
    })).json() as { revision: number; quote: { total: string } };
    const placedB = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customerB,
      payload: { revision: cartB.revision, total: cartB.quote.total, addressId: homeB },
    });
    expect(placedB.statusCode).toBe(201);
    const orderIdB = (placedB.json() as { id: string }).id;

    // Customer C already had dal in cart before remaining stock ran out
    const customerC = await signIn("/v1/auth", "customer3@example.com");
    const { revision: revC } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customerC })).json() as { revision: number };
    await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customerC,
      payload: { revision: revC, lines: [{ listingId: dal, count: 1 }] },
    });

    // Order B accept succeeds (now holds 8; Order A holds 2 in awaiting_customer_confirm, total held = 10, 0 available)
    const acceptB = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderIdB}/accept`, headers: owner });
    expect(acceptB.statusCode).toBe(200);

    // Now 10 total stock - 2 (Order A) - 8 (Order B) = 0 available.
    // Customer C's cart now reflects outOfStock
    const cartC = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customerC })).json() as { lines: Array<{ state: string }>; placeable: boolean };
    expect(cartC.lines[0]?.state).toBe("outOfStock");
    expect(cartC.placeable).toBe(false);

    // A new customer cannot add dal to cart (404 NOT_FOUND)
    const customerD = await signIn("/v1/auth", "customer4@example.com");
    const { revision: revD } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customerD })).json() as { revision: number };
    const addD = await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customerD,
      payload: { revision: revD, lines: [{ listingId: dal, count: 1 }] },
    });
    expect(addD.statusCode).toBe(404);

    // Customer A confirms total (order A holds 2 confirmed)
    const confirmA = await app.inject({ method: "POST", url: `/v1/orders/${orderIdA}/confirm-total`, headers: customer });
    expect(confirmA.statusCode).toBe(200);
  });
});
