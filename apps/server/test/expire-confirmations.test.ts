import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { runJob } from "../src/jobs";
import { stockOf } from "../src/listings";
import { setOrderTiming } from "../src/order-timing";
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

async function product(shopId: string, categoryId: string, productName: string, baseUnit: string, packs: Array<{ quantity: string; price: string; stock: string }>) {
  const row = await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, brand, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($1, null, $2, $3, $4, true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`,
    [productName, categoryId, baseUnit, baseUnit === "each" ? "counted" : "measured"]);
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

beforeEach(async () => {
  setOrderTiming({ reRingSeconds: 120, expireSeconds: 600, confirmSeconds: 300 });
  name = `ygo_expconf_${randomUUID().replaceAll("-", "")}`;
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

describe("Timed job: expire-confirmations (#64)", () => {
  const expireConfirmations = () => runJob(database, "expire-confirmations", clock);

  it("expires unconfirmed proposals past confirmByAt (300 s) and cancels order as cancelled_by_customer", async () => {
    const shopId = await shop("Sai General Stores");
    await publish({ type: "global" }, card);
    const groceries = await category("Groceries");
    const dal = (await product(shopId, groceries, "Toor Dal", "kg", [{ quantity: "1", price: "100", stock: "10" }])).listings[0] as string;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'owner@example.com'", [shopId]);

    const home = await address("customer@example.com");
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: customer })).json() as { revision: number };
    const cart = (await app.inject({
      method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: customer,
      payload: { revision, lines: [{ listingId: dal, count: 2 }] },
    })).json() as { revision: number; quote: { total: string } };

    // Placed at 00:00:00
    clock.set(new Date("2030-01-01T00:00:00.000Z"));
    const placed = await app.inject({
      method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: cart.quote.total, addressId: home },
    });
    const orderId = (placed.json() as { id: string }).id;

    // Proposed at 00:01:00 (confirmByAt = 00:06:00, 300 s later)
    clock.set(new Date("2030-01-01T00:01:00.000Z"));
    await app.inject({
      method: "POST", url: `/v1/me/shop-orders/${orderId}/partial-accept`, headers: owner,
      payload: { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] },
    });

    // Boundary: at 299 s (00:05:59.000Z), job runs but does not expire
    clock.set(new Date("2030-01-01T00:05:59.000Z"));
    await expireConfirmations();
    const orderAt299 = await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(orderAt299.rows[0]?.status).toBe("awaiting_customer_confirm");

    // At 300 s (00:06:00.000Z), job expires the proposal
    clock.set(new Date("2030-01-01T00:06:00.000Z"));
    await expireConfirmations();

    const orderAt300 = await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(orderAt300.rows[0]?.status).toBe("cancelled_by_customer");

    // Proposal marked expired
    const rev = await database.pool.query<{ status: string }>("SELECT status FROM order_revisions WHERE order_id = $1", [orderId]);
    expect(rev.rows[0]?.status).toBe("expired");

    // History record
    const hist = await database.pool.query<{ actor_role: string; reason_code: string }>(
      "SELECT actor_role, reason_code FROM order_status_history WHERE order_id = $1 ORDER BY at DESC LIMIT 1", [orderId]);
    expect(hist.rows[0]).toMatchObject({ actor_role: "system", reason_code: "no_confirmation" });

    // Job run recorded in job_runs
    const runs = await database.pool.query<{ job_name: string; status: string }>(
      "SELECT job_name, status FROM job_runs WHERE job_name = 'expire-confirmations'");
    expect(runs.rows.length).toBeGreaterThan(0);
    expect(runs.rows.every((r) => r.status === "ok")).toBe(true);

    // Stock hold is released (dal had 10, now all 10 available)
    const { rows: stockRows } = await database.pool.query<{ stock: string }>(
      `SELECT ${stockOf("listing")} AS stock FROM shop_listings listing WHERE listing.id = $1`, [dal]);
    expect(Number(stockRows[0]?.stock)).toBe(10);
  });
});
