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
  name = `ygo_cancel_${randomUUID().replaceAll("-", "")}`;
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

const post = (url: string, headers: Record<string, string>, payload?: object) => app.inject({ method: "POST", url, headers, payload });
const shopAction = (orderId: string, action: string, payload?: object) => post(`/v1/me/shop-orders/${orderId}/${action}`, owner, payload);
const askToCancel = (orderId: string) => post(`/v1/orders/${orderId}/cancel-request`, customer);
const statusOf = async (orderId: string) => (await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0]?.status;
const requestOf = async (orderId: string) => (await database.pool.query<{ status: string }>("SELECT status FROM order_cancel_requests WHERE order_id = $1", [orderId])).rows[0]?.status;
const history = async (orderId: string) => (await database.pool.query(
  "SELECT from_status, to_status, actor_role, reason_code FROM order_status_history WHERE order_id = $1 AND from_status IS NOT NULL ORDER BY id", [orderId])).rows;
const heard = async (orderId: string, kind: string) => (await database.pool.query<{ app: string; loud: boolean; body: string }>(
  "SELECT app, loud, body FROM notifications WHERE order_id = $1 AND kind = $2", [orderId, kind])).rows;

/** The order at the shop, accepted; its two lines hold 2 of the dal. */
async function accepted() {
  const set = await setupShopWithOrder();
  expect((await shopAction(set.orderId, "accept")).statusCode).toBe(200);
  return set;
}

async function makeReady(orderId: string) {
  expect((await shopAction(orderId, "preparing")).statusCode).toBe(200);
  const { rows: [member] } = await database.pool.query<{ accountId: string }>("SELECT account_id AS \"accountId\" FROM shop_members WHERE role = 'owner'");
  const ready = await app.inject({ method: "PUT", url: `/v1/me/shop-orders/${orderId}/ready`, headers: owner, payload: { accountId: member?.accountId } });
  expect(ready.statusCode).toBe(200);
}

describe("Cancelling after acceptance: the ask (ORD-5, #59)", () => {
  it("records the Customer's ask, keeps the status, and tells the shop quietly, once even on a retry", async () => {
    const { orderId } = await accepted();
    const asked = await askToCancel(orderId);
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ status: "accepted", cancelRequest: { status: "asked" } });
    expect(await requestOf(orderId)).toBe("asked");
    const retry = await askToCancel(orderId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ cancelRequest: { status: "asked" } });
    expect(await heard(orderId, "order_cancel_requested")).toEqual([{ app: "shopkeeper", loud: false, body: expect.stringContaining("Agree or keep") }]);
    const list = (await app.inject({ method: "GET", url: "/v1/me/shop-orders", headers: owner })).json() as { accepted: Array<{ id: string; cancelAsked: boolean }> };
    expect(list.accepted).toMatchObject([{ id: orderId, cancelAsked: true }]);
    expect((await app.inject({ method: "GET", url: `/v1/me/shop-orders/${orderId}`, headers: owner })).json()).toMatchObject({ cancelRequest: { status: "asked" } });
  });

  it("also lets the Customer ask while preparing", async () => {
    const { orderId } = await accepted();
    await shopAction(orderId, "preparing");
    expect((await askToCancel(orderId)).statusCode).toBe(200);
  });

  it("refuses an ask before acceptance and once ready, and never cancels an accepted order for the Customer directly", async () => {
    const { orderId } = await setupShopWithOrder();
    expect((await askToCancel(orderId)).json()).toMatchObject({ error: { code: "ORDER_STATUS_CHANGED" } });
    await shopAction(orderId, "accept");
    const direct = await post(`/v1/orders/${orderId}/cancel`, customer);
    expect(direct.statusCode).toBe(409);
    expect(await statusOf(orderId)).toBe("accepted");
    await makeReady(orderId);
    const late = await askToCancel(orderId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: "ORDER_STATUS_CHANGED" } });
    expect(await requestOf(orderId)).toBeUndefined();
  });

  it("answers 404 to another Customer", async () => {
    const { orderId } = await accepted();
    const stranger = await signIn("/v1/auth", "stranger@example.com");
    expect((await post(`/v1/orders/${orderId}/cancel-request`, stranger)).statusCode).toBe(404);
  });
});

describe("Cancelling after acceptance: the shop's answer (ORD-5, #59)", () => {
  it("cancels on Agree in one step, releases the stock, and tells the Customer and no one else", async () => {
    const { orderId, dal } = await accepted();
    expect(await left(dal)).toBe(8);
    await askToCancel(orderId);
    const agreed = await shopAction(orderId, "cancel-request/agree");
    expect(agreed.statusCode).toBe(200);
    expect(agreed.json()).toMatchObject({ status: "cancelled_by_customer", cancelRequest: { status: "agreed" } });
    expect(await history(orderId)).toEqual([
      { from_status: "placed", to_status: "accepted", actor_role: "owner", reason_code: null },
      { from_status: "accepted", to_status: "cancelled_by_customer", actor_role: "owner", reason_code: "agreed_cancel" },
    ]);
    expect(await left(dal)).toBe(10);
    expect(await heard(orderId, "order_cancel_agreed")).toMatchObject([{ app: "customer", loud: false }]);
    expect(await heard(orderId, "order_cancelled_by_customer")).toEqual([]);
    const retry = await shopAction(orderId, "cancel-request/agree");
    expect(retry.statusCode).toBe(200);
    expect(await heard(orderId, "order_cancel_agreed")).toHaveLength(1);
    expect((await shopAction(orderId, "cancel-request/keep")).json()).toMatchObject({ error: { code: "CANCEL_REQUEST_CLOSED" } });
  });

  it("lets the shop Keep: the order goes on, the Customer is told, and cannot ask again", async () => {
    const { orderId } = await accepted();
    await askToCancel(orderId);
    const kept = await shopAction(orderId, "cancel-request/keep");
    expect(kept.json()).toMatchObject({ status: "accepted", cancelRequest: { status: "kept" } });
    expect(await heard(orderId, "order_cancel_kept")).toMatchObject([{ app: "customer", loud: false, body: expect.stringContaining("call the shop") }]);
    expect((await shopAction(orderId, "cancel-request/keep")).statusCode).toBe(200);
    expect(await heard(orderId, "order_cancel_kept")).toHaveLength(1);
    const again = await askToCancel(orderId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "CANCEL_REQUEST_CLOSED" } });
    expect((await shopAction(orderId, "cancel-request/agree")).json()).toMatchObject({ error: { code: "CANCEL_REQUEST_CLOSED" } });
    expect(await statusOf(orderId)).toBe("accepted");
  });

  it("refuses to Agree or Keep when no ask was made, and to another shop's Owner", async () => {
    const { orderId } = await accepted();
    expect((await shopAction(orderId, "cancel-request/agree")).json()).toMatchObject({ error: { code: "ORDER_STATUS_CHANGED" } });
    await askToCancel(orderId);
    const rival = await signIn("/v1/auth", "rival@example.com");
    const rivalShop = await shop("Other Stores", 500);
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = 'rival@example.com'", [rivalShop]);
    expect((await post(`/v1/me/shop-orders/${orderId}/cancel-request/agree`, rival)).statusCode).toBe(404);
    expect(await statusOf(orderId)).toBe("accepted");
  });

  it("lets Staff answer, and hears of an ask", async () => {
    const { orderId, shopId } = await accepted();
    const staff = await signIn("/v1/auth", "staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'staff' FROM accounts WHERE email = 'staff@example.com'", [shopId]);
    await askToCancel(orderId);
    const { rows } = await database.pool.query<{ email: string }>(
      "SELECT a.email FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE n.order_id = $1 AND n.kind = 'order_cancel_requested' ORDER BY a.email", [orderId]);
    expect(rows.map((row) => row.email)).toEqual(["owner@example.com", "staff@example.com"]);
    const agreed = await post(`/v1/me/shop-orders/${orderId}/cancel-request/agree`, staff);
    expect(agreed.statusCode).toBe(200);
    expect((await history(orderId)).at(-1)).toMatchObject({ actor_role: "staff", reason_code: "agreed_cancel" });
  });
});

describe("Cancelling after acceptance: an ask the order outruns (ORD-5, #59)", () => {
  it("keeps an ask waiting when the order goes from accepted to preparing, and the shop can still answer it", async () => {
    const { orderId } = await accepted();
    await askToCancel(orderId);
    expect((await shopAction(orderId, "preparing")).statusCode).toBe(200);
    expect(await requestOf(orderId)).toBe("asked");
    const agreed = await shopAction(orderId, "cancel-request/agree");
    expect(agreed.json()).toMatchObject({ status: "cancelled_by_customer", cancelRequest: { status: "agreed" } });
  });

  it("closes an unanswered ask when the order is ready, and the shop can no longer agree", async () => {
    const { orderId } = await accepted();
    await askToCancel(orderId);
    await makeReady(orderId);
    expect(await requestOf(orderId)).toBe("closed_unanswered");
    expect((await shopAction(orderId, "cancel-request/agree")).json()).toMatchObject({ error: { code: "CANCEL_REQUEST_CLOSED" } });
    expect(await statusOf(orderId)).toBe("ready");
  });

  it("closes an unanswered ask at a partial acceptance, and the Customer cannot ask again after confirming", async () => {
    const { orderId, dal } = await accepted();
    await askToCancel(orderId);
    const partial = await shopAction(orderId, "partial-accept", { lines: [{ listingId: dal, count: 1, reason: "out_of_stock" }] });
    expect(partial.statusCode).toBe(200);
    expect(await requestOf(orderId)).toBe("closed_unanswered");
    expect((await post(`/v1/orders/${orderId}/confirm-total`, customer)).statusCode).toBe(200);
    expect(await statusOf(orderId)).toBe("accepted");
    expect((await askToCancel(orderId)).json()).toMatchObject({ error: { code: "CANCEL_REQUEST_CLOSED" } });
  });

  it("leaves one winner when Agree and ready race: cancelled and agreed, or ready and closed", async () => {
    const { orderId } = await accepted();
    await askToCancel(orderId);
    const { rows: [member] } = await database.pool.query<{ accountId: string }>("SELECT account_id AS \"accountId\" FROM shop_members WHERE role = 'owner'");
    const [agree, ready] = await Promise.all([
      shopAction(orderId, "cancel-request/agree"),
      app.inject({ method: "PUT", url: `/v1/me/shop-orders/${orderId}/ready`, headers: owner, payload: { accountId: member?.accountId } }),
    ]);
    const outcome = `${await statusOf(orderId)}/${await requestOf(orderId)}`;
    expect(["cancelled_by_customer/agreed", "ready/closed_unanswered"]).toContain(outcome);
    expect([agree.statusCode, ready.statusCode].sort()).toEqual([200, 409]);
    expect(await heard(orderId, "order_cancel_agreed")).toHaveLength(outcome === "cancelled_by_customer/agreed" ? 1 : 0);
  });
});

describe("Cancelling after acceptance: simultaneous requests (ORD-5, #59)", () => {
  it("makes one ask and one notification when the Customer asks twice at once", async () => {
    const { orderId } = await accepted();
    const both = await Promise.all([askToCancel(orderId), askToCancel(orderId)]);
    expect(both.map((response) => response.statusCode)).toEqual([200, 200]);
    expect((await database.pool.query("SELECT 1 FROM order_cancel_requests WHERE order_id = $1", [orderId])).rowCount).toBe(1);
    expect(await heard(orderId, "order_cancel_requested")).toHaveLength(1);
  });

  it("leaves one winner when Agree and the shop's own cancel race, with the Customer told once", async () => {
    const { orderId } = await accepted();
    await askToCancel(orderId);
    const [agree, cancel] = await Promise.all([
      shopAction(orderId, "cancel-request/agree"),
      shopAction(orderId, "cancel", { reason: "too_busy" }),
    ]);
    expect([agree.statusCode, cancel.statusCode].sort()).toEqual([200, 409]);
    const outcome = `${await statusOf(orderId)}/${await requestOf(orderId)}`;
    expect(["cancelled_by_customer/agreed", "cancelled_by_shop/closed_unanswered"]).toContain(outcome);
    const agreed = outcome === "cancelled_by_customer/agreed";
    expect(await heard(orderId, "order_cancel_agreed")).toHaveLength(agreed ? 1 : 0);
    expect(await heard(orderId, "order_cancelled_by_shop")).toHaveLength(agreed ? 0 : 1);
    expect(await history(orderId)).toHaveLength(2);
  });
});

describe("Cancelling after acceptance: the shop's own cancel (ORD-5, #59)", () => {
  it("cancels an accepted order with a reason, releases the stock, and tells the Customer why", async () => {
    const { orderId, dal } = await accepted();
    const cancelled = await shopAction(orderId, "cancel", { reason: "out_of_stock" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "cancelled_by_shop" });
    expect((await history(orderId)).at(-1)).toEqual({ from_status: "accepted", to_status: "cancelled_by_shop", actor_role: "owner", reason_code: "out_of_stock" });
    expect(await left(dal)).toBe(10);
    expect(await heard(orderId, "order_cancelled_by_shop")).toMatchObject([{ app: "customer", loud: false, body: expect.stringContaining("Items out of stock") }]);
    expect((await shopAction(orderId, "cancel", { reason: "too_busy" })).json()).toMatchObject({ error: { code: "ORDER_STATUS_CHANGED" } });
    expect(await heard(orderId, "order_cancelled_by_shop")).toHaveLength(1);
  });

  it("cancels while preparing, and closes an open ask", async () => {
    const { orderId } = await accepted();
    await shopAction(orderId, "preparing");
    await askToCancel(orderId);
    expect((await shopAction(orderId, "cancel", { reason: "too_busy" })).statusCode).toBe(200);
    expect(await requestOf(orderId)).toBe("closed_unanswered");
  });

  it("cancels from ready, the last status the shop may cancel from", async () => {
    const { orderId } = await accepted();
    await makeReady(orderId);
    expect((await shopAction(orderId, "cancel", { reason: "closing_soon" })).json()).toMatchObject({ status: "cancelled_by_shop" });
  });

  it("is not Reject: it refuses a placed order, a missing reason and a Customer", async () => {
    const { orderId } = await setupShopWithOrder();
    expect((await shopAction(orderId, "cancel", { reason: "too_busy" })).json()).toMatchObject({ error: { code: "ORDER_STATUS_CHANGED" } });
    await shopAction(orderId, "accept");
    expect((await shopAction(orderId, "cancel", {})).statusCode).toBe(400);
    expect((await post(`/v1/me/shop-orders/${orderId}/cancel`, customer, { reason: "too_busy" })).statusCode).toBe(404);
    expect(await statusOf(orderId)).toBe("accepted");
  });
});
