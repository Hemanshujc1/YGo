import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
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
let otherCustomer: { authorization: string };
let customerAccountId: string;
let otherAccountId: string;

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_ratings_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signIn("/v1/admin/auth", adminEmail);
  customer = await signIn("/v1/auth", "customer@example.com");
  otherCustomer = await signIn("/v1/auth", "other@example.com");

  const custAcc = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = 'customer@example.com'");
  customerAccountId = custAcc.rows[0]?.id ?? "";
  const otherAcc = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = 'other@example.com'");
  otherAccountId = otherAcc.rows[0]?.id ?? "";

  const area = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Kothrud') RETURNING id");
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1)", [area.rows[0]?.id]);
  const shopArea = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Paud Road') RETURNING id");
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1)", [shopArea.rows[0]?.id]);

  await publishCard();
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function shop(shopName: string, northMetres = 500) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, 'live', $2, 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, $3::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2031-03-31', 'asha@upi', 2000, now(), now())`,
    [id, shopName, northMetres]);
  return id;
}

async function publishCard() {
  const card = {
    commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
    deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
    deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
  };
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope: { type: "global" }, values: card, reason: "Pilot card" } });
  expect(response.statusCode).toBe(201);
}

async function listing(shopId: string) {
  const existing = await database.pool.query<{ id: string }>(
    `SELECT l.id FROM shop_listings l WHERE l.shop_id = $1 LIMIT 1`, [shopId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const cat = await database.pool.query<{ id: string }>("SELECT id FROM categories LIMIT 1");
  let catId = cat.rows[0]?.id;
  if (!catId) {
    const insertedCat = await database.pool.query<{ id: string }>("INSERT INTO categories (name) VALUES ('General') RETURNING id");
    catId = insertedCat.rows[0]?.id ?? "";
  }
  const prod = await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($2, $1, 'each', 'counted', true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [catId, `Test Milk ${randomUUID()}`]);
  const prodId = prod.rows[0]?.id ?? "";
  const pack = await database.pool.query<{ id: string }>(
    `INSERT INTO packs (product_id, quantity) VALUES ($1, 1) RETURNING id`, [prodId]);
  const packId = pack.rows[0]?.id ?? "";
  const l = await database.pool.query<{ id: string }>(
    `INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, available)
     VALUES ($1, $2, 100, 100, 100, true) RETURNING id`, [shopId, packId]);
  return l.rows[0]?.id ?? "";
}

/** Inserts a completed order directly in the database for rating tests. */
async function insertOrder(shopId: string, accountId: string, status: string, options: { placedAt?: Date; fulfilment?: "delivery" | "pickup" } = {}) {
  const id = randomUUID();
  const placedAt = options.placedAt ?? clock.now();
  const cardRow = await database.pool.query<{ version: string }>("SELECT version FROM rate_card_versions ORDER BY version DESC LIMIT 1");
  const rateCardVersion = cardRow.rows[0]?.version ?? "1";
  const isPickup = options.fulfilment === "pickup";
  if (isPickup) {
    await database.pool.query(
      `INSERT INTO orders (id, account_id, shop_id, status, placed_at, status_changed_at,
         shop_name, shop_address, shop_pincode, fulfilment, product_value, delivery_fee, pickup_fee, total,
         rate_card_version, quote)
       VALUES ($1, $2, $3, $4, $5, $5,
         'Asha Shop', 'Paud Road', '411045', 'pickup', 100, 0, 5, 105,
         $6, '{}'::jsonb)`,
      [id, accountId, shopId, status, placedAt, rateCardVersion]);
  } else {
    await database.pool.query(
      `INSERT INTO orders (id, account_id, shop_id, status, placed_at, status_changed_at,
         shop_name, shop_address, shop_pincode, fulfilment,
         address_label, address_flat, address_area_line, address_pincode, address_point,
         product_value, delivery_fee, total,
         rate_card_version, quote)
       VALUES ($1, $2, $3, $4, $5, $5,
         'Asha Shop', 'Paud Road', '411045', 'delivery',
         'home', 'Flat 101', 'Kothrud', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
         100, 30, 130,
         $6, '{}'::jsonb)`,
      [id, accountId, shopId, status, placedAt, rateCardVersion]);
  }
  const listingId = await listing(shopId);
  await database.pool.query(
    `INSERT INTO order_lines (order_id, position, listing_id, name, base_unit, pack_quantity, count, unit_price, line_total, stock_quantity)
     VALUES ($1, 0, $2, 'Test Milk', 'each', 1, 1, 100, 100, 1)`,
    [id, listingId]);
  return id;
}

describe("Order ratings (TRU-1, DSC-2, #82)", () => {
  it("rates a delivered order and updates orderView rating", async () => {
    const shopId = await shop("Rating Dairy");
    const orderId = await insertOrder(shopId, customerAccountId, "delivered");

    // Before rating, orderView returns rating: null
    const beforeView = await app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: customer });
    expect(beforeView.statusCode).toBe(200);
    expect(beforeView.json().rating).toBeNull();

    // Rates 5 stars
    const rateRes = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      headers: customer,
      payload: { stars: 5 },
    });
    expect(rateRes.statusCode).toBe(200);
    expect(rateRes.json()).toEqual({ stars: 5 });

    // After rating, orderView returns rating: 5
    const afterView = await app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: customer });
    expect(afterView.statusCode).toBe(200);
    expect(afterView.json().rating).toBe(5);
  });

  it("rates a picked_up order", async () => {
    const shopId = await shop("Pickup Mart");
    const orderId = await insertOrder(shopId, customerAccountId, "picked_up", { fulfilment: "pickup" });

    const rateRes = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      headers: customer,
      payload: { stars: 4 },
    });
    expect(rateRes.statusCode).toBe(200);
    expect(rateRes.json()).toEqual({ stars: 4 });
  });

  it("refuses duplicate rating on the same order with 409 RATING_ALREADY_GIVEN", async () => {
    const shopId = await shop("Duplicate Rating Mart");
    const orderId = await insertOrder(shopId, customerAccountId, "delivered");

    const first = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      headers: customer,
      payload: { stars: 5 },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      headers: customer,
      payload: { stars: 3 },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: { code: "RATING_ALREADY_GIVEN" } });
  });

  it("refuses rating an order that is not delivered or picked up (409 ORDER_STATUS_CHANGED)", async () => {
    const shopId = await shop("In-Progress Shop");
    for (const status of ["placed", "accepted", "preparing", "out_for_delivery", "cancelled_by_customer"]) {
      const orderId = await insertOrder(shopId, customerAccountId, status);
      const res = await app.inject({
        method: "POST",
        url: `/v1/orders/${orderId}/rating`,
        headers: customer,
        payload: { stars: 5 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: { code: "ORDER_STATUS_CHANGED" } });
    }
  });

  it("refuses rating another Customer's order or missing order with 404 NOT_FOUND", async () => {
    const shopId = await shop("Other's Order Mart");
    const orderId = await insertOrder(shopId, otherAccountId, "delivered");

    // Attempted by customer (not order owner)
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      headers: customer,
      payload: { stars: 5 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND" } });

    // Missing order
    const missingRes = await app.inject({
      method: "POST",
      url: `/v1/orders/${randomUUID()}/rating`,
      headers: customer,
      payload: { stars: 5 },
    });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.json()).toEqual({ error: { code: "NOT_FOUND" } });
  });

  it("validates star range 1-5 and integers only (400 VALIDATION_FAILED)", async () => {
    const shopId = await shop("Validation Mart");
    const orderId = await insertOrder(shopId, customerAccountId, "delivered");

    for (const stars of [0, 6, -1, 3.5]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/orders/${orderId}/rating`,
        headers: customer,
        payload: { stars },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("requires authentication", async () => {
    const shopId = await shop("Auth Mart");
    const orderId = await insertOrder(shopId, customerAccountId, "delivered");

    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/rating`,
      payload: { stars: 5 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Feed rating calculations & configurable settings (TRU-1, DSC-2, #82)", () => {
  it("shows rating on feed and shop page only once 3 ratings exist in rolling 90 days", async () => {
    const shopId = await shop("Rated Dairy", 300);

    const feedUrl = "/v1/feed?pincode=411038&latitude=18.5&longitude=73.8";
    const shopUrl = `/v1/shops/${shopId}?pincode=411038&latitude=18.5&longitude=73.8`;

    // 0 ratings: rating is null
    const feed0 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed0.json().shops[0].rating).toBeNull();
    const page0 = await app.inject({ method: "GET", url: shopUrl, headers: customer });
    expect(page0.json().shop.rating).toBeNull();

    // 1st rating: 5 stars
    const o1 = await insertOrder(shopId, customerAccountId, "delivered");
    await app.inject({ method: "POST", url: `/v1/orders/${o1}/rating`, headers: customer, payload: { stars: 5 } });
    const feed1 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed1.json().shops[0].rating).toBeNull();

    // 2nd rating: 4 stars
    const o2 = await insertOrder(shopId, otherAccountId, "delivered");
    await app.inject({ method: "POST", url: `/v1/orders/${o2}/rating`, headers: otherCustomer, payload: { stars: 4 } });
    const feed2 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed2.json().shops[0].rating).toBeNull();

    // 3rd rating: 4 stars. Average is (5 + 4 + 4) / 3 = 4.333... rounded to 1 decimal: 4.3
    const o3 = await insertOrder(shopId, customerAccountId, "picked_up", { fulfilment: "pickup" });
    await app.inject({ method: "POST", url: `/v1/orders/${o3}/rating`, headers: customer, payload: { stars: 4 } });

    const feed3 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed3.json().shops[0].rating).toBe(4.3);
    const page3 = await app.inject({ method: "GET", url: shopUrl, headers: customer });
    expect(page3.json().shop.rating).toBe(4.3);

    // 4th rating: 1 star. Average is (5 + 4 + 4 + 1) / 4 = 3.5
    const o4 = await insertOrder(shopId, otherAccountId, "delivered");
    await app.inject({ method: "POST", url: `/v1/orders/${o4}/rating`, headers: otherCustomer, payload: { stars: 1 } });
    const feed4 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed4.json().shops[0].rating).toBe(3.5);

    // If one of the ratings is older than 90 days (e.g. backdated to 91 days ago):
    // o1 created 91 days before clock.now()
    const ninetyOneDaysAgo = new Date(clock.now().getTime() - 91 * 86400 * 1000);
    await database.pool.query("UPDATE ratings SET created_at = $1 WHERE order_id = $2", [ninetyOneDaysAgo, o1]);

    // Now remaining ratings within 90 days are 3 ratings (o2: 4, o3: 4, o4: 1).
    // Average is (4 + 4 + 1) / 3 = 3.0
    const feed90 = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feed90.json().shops[0].rating).toBe(3);

    // If o2 is also backdated to 91 days ago, only 2 ratings remain in 90 days (count < 3):
    await database.pool.query("UPDATE ratings SET created_at = $1 WHERE order_id = $2", [ninetyOneDaysAgo, o2]);
    const feedUnder = await app.inject({ method: "GET", url: feedUrl, headers: customer });
    expect(feedUnder.json().shops[0].rating).toBeNull();
  });

  it("respects custom ratingsMinCount and ratingsWindowDays settings", async () => {
    // Custom app with minCount = 2 and windowDays = 30
    const customApp = buildApp({
      checkDatabase: database.ping,
      database,
      mailer,
      clock,
      authTokenSecret: secret,
      ratingsMinCount: 2,
      ratingsWindowDays: 30,
    });

    try {
      const shopId = await shop("Custom Settings Shop", 300);

      const feedUrl = "/v1/feed?pincode=411038&latitude=18.5&longitude=73.8";

      // 1 rating: null
      const o1 = await insertOrder(shopId, customerAccountId, "delivered");
      await customApp.inject({ method: "POST", url: `/v1/orders/${o1}/rating`, headers: customer, payload: { stars: 5 } });
      const f1 = await customApp.inject({ method: "GET", url: feedUrl, headers: customer });
      expect(f1.json().shops[0].rating).toBeNull();

      // 2nd rating: minCount = 2 is met! Average (5 + 3) / 2 = 4
      const o2 = await insertOrder(shopId, otherAccountId, "delivered");
      await customApp.inject({ method: "POST", url: `/v1/orders/${o2}/rating`, headers: otherCustomer, payload: { stars: 3 } });
      const f2 = await customApp.inject({ method: "GET", url: feedUrl, headers: customer });
      expect(f2.json().shops[0].rating).toBe(4);

      // Backdate o1 to 35 days ago (outside 30-day window):
      const thirtyFiveDaysAgo = new Date(clock.now().getTime() - 35 * 86400 * 1000);
      await database.pool.query("UPDATE ratings SET created_at = $1 WHERE order_id = $2", [thirtyFiveDaysAgo, o1]);

      // Only 1 rating left in 30-day window -> count < 2 -> rating is null
      const fWindow = await customApp.inject({ method: "GET", url: feedUrl, headers: customer });
      expect(fWindow.json().shops[0].rating).toBeNull();
    } finally {
      await customApp.close();
    }
  });
});
