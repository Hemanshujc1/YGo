import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { runJob } from "../src/jobs";
import { expireUncollectedPickups } from "../src/pickup-expiry";
import { liveCheck } from "../src/live-check";
import { stockOf } from "../src/listings";
import { setOrderTiming } from "../src/order-timing";
import { createTestDatabase } from "./test-database";

// Self-pickup and the fulfilment switches (#65, FUL-1, FUL-7, MNY-1, MNY-2, MNY-4).
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

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_pickup_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  setOrderTiming({ collectSeconds: 3 * 60 * 60 });
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, shopDiscountsAvailable: true });
  admin = await signIn("/v1/admin/auth", adminEmail);
  customer = await signIn("/v1/auth", "customer@example.com");
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

const card = {
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};
const pickupRule = (rule: Record<string, unknown> = {}) => ({ pickup: { enabled: true, customerFee: "5", shopFee: "2.50", cap: null, contributionFloor: "7.50", ...rule } });

async function publish(values: object) {
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope: { type: "global" }, values, reason: "Pilot card" } });
  expect(response.statusCode).toBe(201);
}

/** A Live shop 300 m north of the Customer with an Owner, Staff and one product of two listings: Toor Dal (₹135, 10 left) and Atta (₹199.99, 20 left). */
let stockedCalls = 0;
async function stocked(values: object = { ...card, ...pickupRule() }) {
  stockedCalls += 1;
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, 'live', 'Sai General Stores', 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 300::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2031-03-31', 'asha@upi', 2000, now(), now())`, [shopId]);
  await publish(values);
  const found = await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Groceries' AND parent_id IS NULL");
  const groceries = found.rows[0]?.id ?? (await database.pool.query<{ id: string }>("INSERT INTO categories (name) VALUES ('Groceries') RETURNING id")).rows[0]?.id ?? "";
  const listing = async (productName: string, quantity: string, price: string, stock: string) => {
    const { rows: [product] } = await database.pool.query<{ id: string }>(
      `INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
       VALUES ($1, $2, 'kg', 'measured', true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [productName, groceries]);
    const { rows: [pack] } = await database.pool.query<{ id: string }>("INSERT INTO packs (product_id, quantity) VALUES ($1, $2) RETURNING id", [product?.id, quantity]);
    const { rows: [row] } = await database.pool.query<{ id: string }>(
      "INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, available) VALUES ($1, $2, $3, $3, $3, true) RETURNING id", [shopId, pack?.id, price]);
    await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) VALUES ($1, $2, $3, 'opening', $4)", [row?.id, randomUUID(), randomUUID(), stock]);
    return row?.id ?? "";
  };
  const dal = await listing(`Toor Dal ${stockedCalls}`, "1", "135", "10");
  const atta = await listing(`Atta ${stockedCalls}`, "5", "199.99", "20");
  const ownerEmail = `owner${stockedCalls}@example.com`;
  const staffEmail = `staff${stockedCalls}@example.com`;
  const owner = await signIn("/v1/auth", ownerEmail);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'owner' FROM accounts WHERE email = $2", [shopId, ownerEmail]);
  const staff = await signIn("/v1/auth", staffEmail);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) SELECT id, $1, 'staff' FROM accounts WHERE email = $2", [shopId, staffEmail]);
  const { rows: [home] } = await database.pool.query<{ id: string }>(
    `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
     SELECT id, 'home', 'Flat 4B', 'Kothrud', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, now() FROM accounts WHERE email = 'customer@example.com'
     ON CONFLICT DO NOTHING RETURNING id`);
  return { shopId, dal, atta, owner, staff, home: home?.id ?? (await database.pool.query<{ id: string }>("SELECT id FROM saved_addresses LIMIT 1")).rows[0]?.id ?? "" };
}

const here = { pincode: "411038", latitude: 18.5, longitude: 73.8 };
const query = "pincode=411038&latitude=18.5&longitude=73.8";
type Cart = { revision: number; quote: { total: string } | null; placeable: boolean; reasons: Array<{ code: string }>; pickup: null | { productValue: string; pickupFee: string; total: string; placeable: boolean; reasons: Array<{ code: string }>; shopDiscount: unknown } };
const save = async (shopId: string, lines: Array<{ listingId: string; count: number }>, headers = customer) => {
  const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${query}`, headers })).json() as { revision: number };
  return (await app.inject({ method: "PUT", url: `/v1/carts/${shopId}?${query}`, headers, payload: { revision, lines } })).json() as Cart;
};
const placePickup = (shopId: string, revision: number, total: string, headers = customer) =>
  app.inject({ method: "POST", url: `/v1/carts/${shopId}/order`, headers, payload: { revision, total, fulfilment: "pickup", ...here } });
const placeDelivery = (shopId: string, revision: number, total: string, addressId: string) =>
  app.inject({ method: "POST", url: `/v1/carts/${shopId}/order`, headers: customer, payload: { revision, total, addressId } });
/** Switches pickup on for the shop, as its Owner does, and places a pickup order of two Toor Dal. */
async function pickupOrder(world: Awaited<ReturnType<typeof stocked>>, lines = [{ listingId: world.dal, count: 2 }]) {
  expect((await switchMode(world.owner, "pickup", true)).statusCode).toBe(200);
  const cart = await save(world.shopId, lines);
  const placed = await placePickup(world.shopId, cart.revision, cart.pickup?.total ?? "0");
  expect(placed.statusCode).toBe(201);
  return placed.json() as { id: string; status: string; total: string; handoverCode: string | null };
}
const switchMode = (headers: { authorization: string }, mode: string, on: boolean) => app.inject({ method: "PUT", url: `/v1/me/fulfilment-modes/${mode}`, headers, payload: { on } });
const force = (shopId: string, mode: string, forcedOff: boolean) => app.inject({ method: "PUT", url: `/v1/admin/shops/${shopId}/fulfilment-modes/${mode}`, headers: admin, payload: { forcedOff } });
const shopPost = (orderId: string, path: string, headers: { authorization: string }, payload?: object) =>
  app.inject({ method: "POST", url: `/v1/me/shop-orders/${orderId}/${path}`, headers, payload });
const left = async (listingId: string) =>
  (await database.pool.query<{ left: string }>(`SELECT trim_scale(${stockOf("l")})::text AS left FROM shop_listings l WHERE l.id = $1`, [listingId])).rows[0]?.left;
const at = (iso: string) => clock.set(new Date(iso));
const row = async (orderId: string) => (await database.pool.query("SELECT status, fulfilment, delivery_payment, pickup_fee::text, address_flat, quote FROM orders WHERE id = $1", [orderId])).rows[0];

describe("The fulfilment switches (FUL-1)", () => {
  it("starts with both delivery modes on and pickup off, and offers no pickup until the shop switches it on", async () => {
    const world = await stocked();
    const modes = await app.inject({ method: "GET", url: "/v1/me/fulfilment-modes", headers: world.owner });
    expect(modes.json()).toEqual({ modes: [
      { mode: "instant", shopOn: true, adminForcedOff: false, open: true },
      { mode: "scheduled", shopOn: true, adminForcedOff: false, open: true },
      { mode: "pickup", shopOn: false, adminForcedOff: false, open: false },
    ] });
    expect((await save(world.shopId, [{ listingId: world.dal, count: 2 }])).pickup).toBeNull();
    // Without the shop's switch a pickup cannot be placed either.
    const refused = await placePickup(world.shopId, 1, "270.00");
    expect(refused.statusCode).toBe(409);
  });

  it("lets only the Owner switch a mode, and refuses pickup until the rate card has a pickup rule with its floor", async () => {
    const world = await stocked();
    expect((await switchMode(world.staff, "pickup", true)).statusCode).toBe(403);
    expect((await switchMode(customer, "pickup", true)).statusCode).toBe(404);
    expect((await switchMode(world.owner, "pickup", true)).json()).toMatchObject({ modes: expect.arrayContaining([{ mode: "pickup", shopOn: true, adminForcedOff: false, open: true }]) });
    expect((await switchMode(world.owner, "pickup", false)).json().modes).toContainEqual({ mode: "pickup", shopOn: false, adminForcedOff: false, open: false });

    const bare = await stocked({ ...card });
    const noRule = await switchMode(bare.owner, "pickup", true);
    expect(noRule.statusCode).toBe(409);
    expect(noRule.json()).toEqual({ error: { code: "PICKUP_NOT_CONFIGURED" } });
    // Switching off never needs the rule.
    expect((await switchMode(bare.owner, "pickup", false)).statusCode).toBe(200);
  });

  it("lets Admin force a mode off and lift it, and leaves an order already placed alone", async () => {
    const world = await stocked();
    const order = await pickupOrder(world);
    expect((await force(world.shopId, "pickup", true)).json().modes).toContainEqual({ mode: "pickup", shopOn: true, adminForcedOff: true, open: false });
    expect((await app.inject({ method: "GET", url: `/v1/admin/shops/${world.shopId}/fulfilment-modes`, headers: admin })).statusCode).toBe(200);
    // New pickups are refused, but the placed one carries on.
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 1 }]);
    expect(cart.pickup).toBeNull();
    expect((await placePickup(world.shopId, cart.revision, "135.00")).statusCode).toBe(409);
    expect((await shopPost(order.id, "accept", world.owner)).statusCode).toBe(200);
    expect((await force(world.shopId, "pickup", false)).statusCode).toBe(200);
    expect((await save(world.shopId, [{ listingId: world.dal, count: 1 }])).pickup).not.toBeNull();
    // Only an Admin may force.
    expect((await app.inject({ method: "PUT", url: `/v1/admin/shops/${world.shopId}/fulfilment-modes/pickup`, headers: world.owner, payload: { forcedOff: true } })).statusCode).toBe(403);
  });

  it("refuses the Admin routes to an Owner, Staff and a Customer, and the Owner routes to Admin and another shop's Customer", async () => {
    const world = await stocked();
    for (const headers of [world.owner, world.staff, customer]) {
      expect([401, 403]).toContain((await app.inject({ method: "GET", url: `/v1/admin/shops/${world.shopId}/fulfilment-modes`, headers })).statusCode);
      expect([401, 403]).toContain((await app.inject({ method: "PUT", url: `/v1/admin/shops/${world.shopId}/fulfilment-modes/pickup`, headers, payload: { forcedOff: true } })).statusCode);
    }
    expect([401, 403, 404]).toContain((await switchMode(admin, "pickup", true)).statusCode);
    expect([403, 404]).toContain((await switchMode(customer, "pickup", true)).statusCode);
    expect((await app.inject({ method: "GET", url: `/v1/admin/shops/${randomUUID()}/fulfilment-modes`, headers: admin })).statusCode).toBe(404);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM shop_fulfilment_modes")).rows[0]).toEqual({ count: 0 });
  });

  it("never switches pickup on for the Owner when Admin forces it off and lifts it", async () => {
    const world = await stocked();
    expect((await force(world.shopId, "pickup", true)).json().modes).toContainEqual({ mode: "pickup", shopOn: false, adminForcedOff: true, open: false });
    expect((await force(world.shopId, "pickup", false)).json().modes).toContainEqual({ mode: "pickup", shopOn: false, adminForcedOff: false, open: false });
    expect((await save(world.shopId, [{ listingId: world.dal, count: 2 }])).pickup).toBeNull();
    // An Owner switching instant off leaves Admin's side at not forced.
    expect((await switchMode(world.owner, "instant", false)).json().modes).toContainEqual({ mode: "instant", shopOn: false, adminForcedOff: false, open: false });
  });

  it("closes delivery while instant is off or forced off, and leaves pickup priced", async () => {
    const world = await stocked();
    await switchMode(world.owner, "pickup", true);
    await switchMode(world.owner, "instant", false);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 2 }]);
    expect(cart.quote).toBeNull();
    expect(cart.placeable).toBe(false);
    expect(cart.reasons).toContainEqual({ code: "NOT_DELIVERING" });
    expect(cart.pickup?.placeable).toBe(true);
    expect((await placeDelivery(world.shopId, cart.revision, "300.00", world.home)).statusCode).toBe(409);
    await switchMode(world.owner, "instant", true);
    await force(world.shopId, "instant", true);
    expect((await save(world.shopId, [{ listingId: world.dal, count: 2 }])).quote).toBeNull();
  });

  it("counts a shop's pickup switch when it checks the rate card for Live", async () => {
    const world = await stocked({ ...card });
    expect((await liveCheck(database.pool, world.shopId, new Date())).rateCardMissing).not.toContain("pickup");
    await database.pool.query("INSERT INTO shop_fulfilment_modes (shop_id, mode, shop_on) VALUES ($1, 'pickup', true)", [world.shopId]);
    expect((await liveCheck(database.pool, world.shopId, new Date())).rateCardMissing).toContain("pickup");
  });
});

describe("Pickup pricing and placement (FUL-7, MNY-2, MNY-4)", () => {
  it("prices a pickup with no delivery fee and no commission, the booking fee a named line, and keeps the delivery quote", async () => {
    const world = await stocked();
    await switchMode(world.owner, "pickup", true);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 2 }]);
    expect(cart.quote?.total).toBe("300.00");
    expect(cart.pickup).toEqual({ productValue: "270.00", shopDiscount: null, pickupFee: "5.00", total: "275.00", placeable: true, reasons: [] });
  });

  it("is not held to the minimum cart or the delivered floor, only the pickup floor (MNY-4)", async () => {
    const world = await stocked({ ...card, deliveredContributionFloor: "500", ...pickupRule({ contributionFloor: "5", shopFee: null }) });
    await switchMode(world.owner, "pickup", true);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 1 }]);
    // ₹135 is over the minimum cart of ₹100 but the delivered floor of ₹500 fails; the pickup is placeable on its own floor of ₹5.
    expect(cart.placeable).toBe(false);
    expect(cart.pickup).toMatchObject({ placeable: true, total: "140.00" });
    const placed = await placePickup(world.shopId, cart.revision, "140.00");
    expect(placed.statusCode).toBe(201);
  });

  it("is not placeable below the pickup floor, naming no figure", async () => {
    const world = await stocked({ ...card, ...pickupRule({ contributionFloor: "8", shopFee: null }) });
    await switchMode(world.owner, "pickup", true);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 2 }]);
    expect(cart.pickup).toMatchObject({ placeable: false, reasons: [{ code: "BELOW_CONTRIBUTION_FLOOR" }] });
    const refused = await placePickup(world.shopId, cart.revision, "275.00");
    expect(refused.statusCode).toBe(409);
    expect((await database.pool.query("SELECT count(*) FROM orders")).rows[0].count).toBe("0");
  });

  it("freezes a pickup with no address, no delivery fee, no commission, and the booking fees in its quote", async () => {
    const world = await stocked();
    const order = await pickupOrder(world);
    expect(order).toMatchObject({ status: "placed", handoverCode: null });
    const view = (await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json();
    expect(view).toMatchObject({ fulfilment: "pickup", address: null, productValue: "270.00", deliveryFee: "0.00", smallCartFee: null, pickupFee: "5.00", total: "275.00" });
    const stored = await row(order.id);
    expect(stored).toMatchObject({ fulfilment: "pickup", address_flat: null, pickup_fee: "5.00" });
    expect(stored.quote).toMatchObject({
      commission: "0.00", customerTotal: "275.00", platformContribution: "7.50", shopKeeps: "267.50",
      deliveryFee: { amount: "0.00" }, pickup: { customerFee: "5.00", shopFee: "2.50", contributionFloor: "7.5" },
    });
    expect(stored.quote.lines.every((line: { commission: string }) => line.commission === "0.00")).toBe(true);
    // The cart is emptied, and a stale total is refused with the cart as it is.
    expect((await app.inject({ method: "GET", url: `/v1/carts/${world.shopId}?${query}`, headers: customer })).json()).toMatchObject({ lines: [], revision: 2 });
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 1 }]);
    const stale = await placePickup(world.shopId, cart.revision, "999.00");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "CART_CHANGED", cart: { pickup: { total: "140.00" } } } });
  });

  it("refuses to place for pickup in a place the shop does not serve", async () => {
    const world = await stocked();
    await switchMode(world.owner, "pickup", true);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 2 }]);
    const far = await app.inject({ method: "POST", url: `/v1/carts/${world.shopId}/order`, headers: customer,
      payload: { revision: cart.revision, total: "275.00", fulfilment: "pickup", pincode: "411038", latitude: 18.7, longitude: 73.8 } });
    expect(far.statusCode).toBe(409);
  });

  it("applies the shop-wide discount to a pickup before the booking fee", async () => {
    const world = await stocked();
    await switchMode(world.owner, "pickup", true);
    const rule = await app.inject({ method: "PUT", url: "/v1/me/shop-discount", headers: world.owner, payload: { form: "percentage", percentage: "10", cap: null, active: true } });
    expect(rule.statusCode).toBe(200);
    const cart = await save(world.shopId, [{ listingId: world.dal, count: 2 }]);
    expect(cart.pickup).toMatchObject({ productValue: "270.00", shopDiscount: { amount: "27.00" }, pickupFee: "5.00", total: "248.00", placeable: true });
    const placed = await placePickup(world.shopId, cart.revision, "248.00");
    expect(placed.statusCode).toBe(201);
    expect(placed.json()).toMatchObject({ productValue: "270.00", shopDiscount: { amount: "27.00" }, pickupFee: "5.00", total: "248.00" });
  });
});

describe("A pickup at the counter (FUL-7, MNY-1)", () => {
  const ready = async (world: Awaited<ReturnType<typeof stocked>>) => {
    const order = await pickupOrder(world);
    at("2030-01-01T00:01:00.000Z");
    expect((await shopPost(order.id, "accept", world.owner)).statusCode).toBe(200);
    expect(await left(world.dal)).toBe("8");
    expect((await shopPost(order.id, "preparing", world.owner)).statusCode).toBe(200);
    at("2030-01-01T00:10:00.000Z");
    const made = await shopPost(order.id, "ready-for-pickup", world.staff);
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ status: "ready", fulfilment: "pickup", address: null, pickupFee: "5.00", total: "275.00", delivererId: null });
    return order;
  };

  it("shows the Customer the code from Ready and completes at the counter with the code, no photo, and the payment recorded", async () => {
    const world = await stocked();
    const order = await ready(world);
    const code = (await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json().handoverCode as string;
    expect(code).toMatch(/^\d{4}$/);

    const wrong = await shopPost(order.id, "picked-up", world.staff, { handoverCode: code === "0000" ? "1111" : "0000", payment: "cash" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: { code: "HANDOVER_CODE_WRONG" } });
    expect((await row(order.id)).status).toBe("ready");

    const done = await shopPost(order.id, "picked-up", world.staff, { handoverCode: code, payment: "upi" });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "picked_up", deliveryPhotoAvailable: false });
    expect(await row(order.id)).toMatchObject({ status: "picked_up", delivery_payment: "upi" });
    // The reserved stock became one sale movement per line, and a second completion is refused.
    expect(await left(world.dal)).toBe("8");
    expect((await database.pool.query("SELECT kind, quantity::text FROM stock_movements WHERE kind = 'sale'")).rows).toEqual([{ kind: "sale", quantity: "-2.000" }]);
    expect((await shopPost(order.id, "picked-up", world.staff, { handoverCode: code, payment: "upi" })).statusCode).toBe(409);
    expect((await database.pool.query("SELECT from_status, to_status, actor_role FROM order_status_history WHERE order_id = $1 ORDER BY at, to_status", [order.id])).rows.map((r) => r.to_status))
      .toEqual(expect.arrayContaining(["accepted", "preparing", "ready", "picked_up"]));
    // The receipt has no address and names the booking fee.
    const receipt = await app.inject({ method: "GET", url: `/v1/orders/${order.id}/receipt`, headers: customer });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ status: "picked_up", address: null, pickupFee: "5.00", deliveryFee: "0.00", total: "275.00", payment: "upi" });
  });

  it("locks the code after three misses, as at the door", async () => {
    const world = await stocked();
    const order = await ready(world);
    const code = (await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json().handoverCode as string;
    const miss = code === "0000" ? "1111" : "0000";
    expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: miss, payment: "cash" })).statusCode).toBe(400);
    expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: miss, payment: "cash" })).statusCode).toBe(400);
    const locked = await shopPost(order.id, "picked-up", world.owner, { handoverCode: miss, payment: "cash" });
    expect(locked.statusCode).toBe(429);
    expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: code, payment: "cash" })).statusCode).toBe(429);
    at("2030-01-01T00:13:00.000Z");
    expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: code, payment: "cash" })).statusCode).toBe(200);
  });

  it("keeps the code to its Customer until Ready, and lets only the order's own shop complete it", async () => {
    const world = await stocked();
    const order = await pickupOrder(world);
    const stranger = await signIn("/v1/auth", "stranger@example.com");
    const view = (headers: { authorization: string }) => app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
    await shopPost(order.id, "accept", world.owner);
    await shopPost(order.id, "preparing", world.owner);
    // Not before Ready, and never to anyone but the Customer who placed it.
    expect((await view(customer)).json().handoverCode).toBeNull();
    at("2030-01-01T00:10:00.000Z");
    expect((await shopPost(order.id, "ready-for-pickup", world.owner)).statusCode).toBe(200);
    const code = (await view(customer)).json().handoverCode as string;
    expect(code).toMatch(/^\d{4}$/);
    expect((await view(stranger)).statusCode).toBe(404);
    // The code is on no shop's own view of the order.
    expect(JSON.stringify((await app.inject({ method: "GET", url: `/v1/me/shop-orders/${order.id}`, headers: world.owner })).json())).not.toContain(code);

    // Another shop's Owner, and the Customer, cannot complete it or spend its attempts; the payment must be cash or UPI.
    const other = await stocked();
    for (const headers of [other.owner, customer, stranger]) {
      expect((await shopPost(order.id, "picked-up", headers, { handoverCode: code, payment: "cash" })).statusCode).toBe(404);
      expect((await shopPost(order.id, "ready-for-pickup", headers)).statusCode).toBe(404);
    }
    expect((await database.pool.query("SELECT handover_code_attempts AS attempts FROM orders WHERE id = $1", [order.id])).rows[0]).toEqual({ attempts: 0 });
    expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: code, payment: "card" })).statusCode).toBe(400);
    expect((await row(order.id)).status).toBe("ready");
  });

  it("keeps the delivery steps and the pickup steps apart", async () => {
    const world = await stocked();
    const pickup = await pickupOrder(world);
    await shopPost(pickup.id, "accept", world.owner);
    // A pickup has no deliverer, and cannot be completed before Ready.
    expect((await app.inject({ method: "PUT", url: `/v1/me/shop-orders/${pickup.id}/ready`, headers: world.owner, payload: { accountId: randomUUID() } })).json()).toEqual({ error: { code: "ORDER_IS_PICKUP" } });
    expect((await shopPost(pickup.id, "picked-up", world.owner, { handoverCode: "1234", payment: "cash" })).statusCode).toBe(409);
    expect((await shopPost(pickup.id, "out-for-delivery", world.owner)).statusCode).toBe(403);

    const cart = await save(world.shopId, [{ listingId: world.atta, count: 1 }]);
    const delivery = (await placeDelivery(world.shopId, cart.revision, cart.quote?.total ?? "", world.home)).json() as { id: string };
    await shopPost(delivery.id, "accept", world.owner);
    expect((await shopPost(delivery.id, "ready-for-pickup", world.owner)).statusCode).toBe(409);
    expect((await shopPost(delivery.id, "picked-up", world.owner, { handoverCode: "1234", payment: "cash" })).statusCode).toBe(409);
    expect(await row(delivery.id)).toMatchObject({ status: "accepted", fulfilment: "delivery" });
  });

  it("hands the Customer's refusal of a part-accepted pickup the same total the shop proposed, booking fee standing, with no commission", async () => {
    const world = await stocked();
    const order = await pickupOrder(world, [{ listingId: world.dal, count: 2 }, { listingId: world.atta, count: 1 }]);
    expect(order.total).toBe("474.99");
    const proposal = await shopPost(order.id, "partial-accept", world.owner, { lines: [{ listingId: world.atta, count: 0, reason: "out_of_stock" }] });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json()).toMatchObject({ status: "awaiting_customer_confirm", proposal: { productValue: "270.00", deliveryFee: "0.00", pickupFee: "5.00", total: "275.00" } });
    const { rows: [revision] } = await database.pool.query("SELECT product_value::text, pickup_fee::text, total::text, commission::text, platform_contribution::text, below_floor_exception FROM order_revisions WHERE order_id = $1", [order.id]);
    expect(revision).toEqual({ product_value: "270.00", pickup_fee: "5.00", total: "275.00", commission: "0.00", platform_contribution: "7.50", below_floor_exception: false });
    const confirmed = await app.inject({ method: "POST", url: `/v1/orders/${order.id}/confirm-total`, headers: customer });
    expect(confirmed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ pickupFee: "5.00", productValue: "270.00", total: "275.00" });
  });

  it("tests a requoted pickup against the pickup floor, recording the shortfall as an exception", async () => {
    const world = await stocked({ ...card, deliveredContributionFloor: "0", ...pickupRule({ customerFee: "5", shopFee: null, contributionFloor: "5" }) });
    const order = await pickupOrder(world);
    // The floor is raised in the order's own frozen quote; a pickup's requote reads that, never the delivered floor.
    await database.pool.query("ALTER TABLE orders DISABLE TRIGGER orders_frozen");
    await database.pool.query("UPDATE orders SET quote = jsonb_set(quote, '{pickup,contributionFloor}', '\"9\"') WHERE id = $1", [order.id]);
    await database.pool.query("ALTER TABLE orders ENABLE TRIGGER orders_frozen");
    const proposal = await shopPost(order.id, "partial-accept", world.owner, { lines: [{ listingId: world.dal, count: 1, reason: "out_of_stock" }] });
    expect(proposal.statusCode).toBe(200);
    const { rows: [revision] } = await database.pool.query("SELECT below_floor_exception, below_floor_shortfall::text FROM order_revisions WHERE order_id = $1", [order.id]);
    expect(revision).toEqual({ below_floor_exception: true, below_floor_shortfall: "4.00" });
  });
});

describe("An uncollected pickup (FUL-7, expire-pickups)", () => {
  // Access tokens last 15 minutes, so the cutoff is five minutes here.
  beforeEach(() => setOrderTiming({ collectSeconds: 300 }));
  const readyAt = async (world: Awaited<ReturnType<typeof stocked>>, readyMinute: number) => {
    const order = await pickupOrder(world);
    at("2030-01-01T00:01:00.000Z");
    await shopPost(order.id, "accept", world.owner);
    at(`2030-01-01T00:0${readyMinute}:00.000Z`);
    expect((await shopPost(order.id, "ready-for-pickup", world.owner)).statusCode).toBe(200);
    return order;
  };

  it("closes a Ready pickup as not collected at the cutoff, counted from Ready, charging nobody and releasing the stock", async () => {
    const world = await stocked();
    const order = await readyAt(world, 2);
    expect(await left(world.dal)).toBe("8");
    at("2030-01-01T00:06:59.000Z");
    await runJob(database, "expire-pickups", clock);
    expect((await row(order.id)).status).toBe("ready");

    at("2030-01-01T00:07:00.000Z");
    await runJob(database, "expire-pickups", clock);
    expect(await row(order.id)).toMatchObject({ status: "not_collected", delivery_payment: null });
    expect((await database.pool.query("SELECT to_status, actor_role, reason_code FROM order_status_history WHERE order_id = $1 AND to_status = 'not_collected'", [order.id])).rows)
      .toEqual([{ to_status: "not_collected", actor_role: "system", reason_code: "not_collected" }]);
    // Nothing was sold: the reservation ended with the status.
    expect(await left(world.dal)).toBe("10");
    expect((await database.pool.query("SELECT count(*) FROM stock_movements WHERE kind = 'sale'")).rows[0].count).toBe("0");
    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json()).toMatchObject({ status: "not_collected", total: "275.00" });
    // A second run changes nothing, and each run is recorded.
    await runJob(database, "expire-pickups", clock);
    expect((await database.pool.query("SELECT count(*) FROM order_status_history WHERE order_id = $1 AND to_status = 'not_collected'", [order.id])).rows[0].count).toBe("1");
    expect((await database.pool.query("SELECT status FROM job_runs WHERE job_name = 'expire-pickups' ORDER BY started_at")).rows.every((run) => run.status === "ok")).toBe(true);
  });

  it("closes every due pickup across batches, and passes over one another job holds locked without reading it again (#601)", async () => {
    const world = await stocked();
    const first = await readyAt(world, 2), second = await readyAt(world, 2), third = await readyAt(world, 3);
    at("2030-01-01T00:09:00.000Z");
    // A second connection holds the first order, as a concurrent completion would.
    const other = await database.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [first.id]);
      expect(await expireUncollectedPickups(database.pool, clock, 1)).toBe(2);
      await other.query("ROLLBACK");
    } finally { other.release(); }
    expect([(await row(first.id)).status, (await row(second.id)).status, (await row(third.id)).status]).toEqual(["ready", "not_collected", "not_collected"]);
    expect(await expireUncollectedPickups(database.pool, clock, 1)).toBe(1);
    expect((await row(first.id)).status).toBe("not_collected");
  });

  it("leaves an unready pickup and a completed pickup alone, and refuses completion once closed", async () => {
    const world = await stocked();
    const waiting = await pickupOrder(world);
    await shopPost(waiting.id, "accept", world.owner);
    const done = await readyAt(world, 2);
    const code = (await app.inject({ method: "GET", url: `/v1/orders/${done.id}`, headers: customer })).json().handoverCode as string;
    expect((await shopPost(done.id, "picked-up", world.owner, { handoverCode: code, payment: "cash" })).statusCode).toBe(200);
    const late = await readyAt(world, 3);
    at("2030-01-01T00:09:00.000Z");
    await runJob(database, "expire-pickups", clock);
    expect((await row(waiting.id)).status).toBe("accepted");
    expect((await row(done.id)).status).toBe("picked_up");
    expect((await row(late.id)).status).toBe("not_collected");
    expect((await shopPost(late.id, "picked-up", world.owner, { handoverCode: "0000", payment: "cash" })).statusCode).toBe(409);
  });
});

describe("Pickup follow-ups (#597)", () => {
  const kinds = async (orderId: string) =>
    (await database.pool.query<{ kind: string; app: string; email: string }>(
      `SELECT n.kind, n.app, a.email FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE n.order_id = $1 AND n.kind LIKE 'pickup_%' ORDER BY n.created_at, n.kind`, [orderId])).rows;
  const feedShops = async () => (await app.inject({ method: "GET", url: `/v1/feed?${query}`, headers: customer })).json().shops as Array<{ id: string; delivers: boolean; pickup: boolean }>;
  const found = async () => (await app.inject({ method: "GET", url: `/v1/search?${query}&q=toor`, headers: customer })).json().shops as Array<{ id: string; delivers: boolean; pickup: boolean }>;
  const page = (shopId: string) => app.inject({ method: "GET", url: `/v1/shops/${shopId}?${query}`, headers: customer });
  const addressesFor = async (shopId: string) => (await app.inject({ method: "GET", url: `/v1/me/addresses?shopId=${shopId}`, headers: customer })).json().addresses as unknown[];

  it("tells the Customer when a pickup is ready and when it was not collected, and tells nobody of a delivery being ready", async () => {
    setOrderTiming({ collectSeconds: 300 });
    const world = await stocked();
    const order = await pickupOrder(world);
    at("2030-01-01T00:01:00.000Z");
    await shopPost(order.id, "accept", world.owner);
    expect(await kinds(order.id)).toEqual([]);
    at("2030-01-01T00:02:00.000Z");
    expect((await shopPost(order.id, "ready-for-pickup", world.owner)).statusCode).toBe(200);
    expect(await kinds(order.id)).toEqual([{ kind: "pickup_ready", app: "customer", email: "customer@example.com" }]);
    const listed = (await app.inject({ method: "GET", url: "/v1/me/notifications", headers: { ...customer, "x-ygo-app-name": "customer", "x-ygo-app-version": "99.0.0" } })).json().notifications as Array<{ kind: string; title: string; body: string; orderId: string }>;
    expect(listed.find((note) => note.kind === "pickup_ready")).toMatchObject({ orderId: order.id, title: expect.stringContaining("ready"), body: expect.stringContaining("Sai General Stores") });
    expect((await database.pool.query("SELECT count(*) FROM push_queue p JOIN notifications n ON n.id = p.notification_id WHERE n.kind = 'pickup_ready'")).rows[0].count).toBe("1");

    at("2030-01-01T00:07:00.000Z");
    await runJob(database, "expire-pickups", clock);
    expect((await kinds(order.id)).map((note) => note.kind)).toEqual(["pickup_ready", "pickup_not_collected"]);
    expect((await kinds(order.id)).every((note) => note.email === "customer@example.com")).toBe(true);

    // A delivery that is ready, and one that was never collected, send neither.
    const cart = await save(world.shopId, [{ listingId: world.atta, count: 1 }]);
    const delivery = (await placeDelivery(world.shopId, cart.revision, cart.quote?.total ?? "", world.home)).json() as { id: string };
    await shopPost(delivery.id, "accept", world.owner);
    await shopPost(delivery.id, "preparing", world.owner);
    const ownerId = (await database.pool.query<{ id: string }>("SELECT account_id AS id FROM shop_members WHERE shop_id = $1 AND role = 'owner'", [world.shopId])).rows[0]?.id;
    expect((await app.inject({ method: "PUT", url: `/v1/me/shop-orders/${delivery.id}/ready`, headers: world.owner, payload: { accountId: ownerId } })).statusCode).toBe(200);
    expect(await row(delivery.id)).toMatchObject({ status: "ready", fulfilment: "delivery" });
    expect(await kinds(delivery.id)).toEqual([]);
  });

  it("shows a shop as delivering only while instant is on and not forced off, and as pickup only otherwise", async () => {
    const world = await stocked();
    expect(await feedShops()).toMatchObject([{ id: world.shopId, delivers: true, pickup: false }]);
    await switchMode(world.owner, "pickup", true);
    expect(await feedShops()).toMatchObject([{ id: world.shopId, delivers: true, pickup: true }]);
    await switchMode(world.owner, "instant", false);
    expect(await feedShops()).toMatchObject([{ id: world.shopId, delivers: false, pickup: true }]);
    expect(await found()).toMatchObject([{ id: world.shopId, delivers: false, pickup: true }]);
    expect((await page(world.shopId)).json().shop).toMatchObject({ delivers: false, pickup: true });
    // Its address no longer counts as one it delivers to.
    expect(await addressesFor(world.shopId)).toEqual([]);
    await switchMode(world.owner, "instant", true);
    expect(await addressesFor(world.shopId)).toHaveLength(1);
    await force(world.shopId, "instant", true);
    expect(await feedShops()).toMatchObject([{ delivers: false, pickup: true }]);
    // Admin's force-off of pickup too, with the shop's own switch still on.
    await force(world.shopId, "pickup", true);
    expect(await feedShops()).toEqual([]);
    expect(await found()).toEqual([]);
    const shut = await page(world.shopId);
    expect(shut.statusCode).toBe(200);
    expect(shut.json().shop).toMatchObject({ delivers: false, pickup: false });
  });

  it("does not offer pickup for a shop whose rate card lost its pickup rule", async () => {
    const world = await stocked();
    await switchMode(world.owner, "pickup", true);
    await publish(card);
    expect(await feedShops()).toMatchObject([{ id: world.shopId, delivers: true, pickup: false }]);
  });

  describe("a locked code", () => {
    const lockedPickup = async (world: Awaited<ReturnType<typeof stocked>>) => {
      const order = await pickupOrder(world);
      at("2030-01-01T00:01:00.000Z");
      await shopPost(order.id, "accept", world.owner);
      expect((await shopPost(order.id, "ready-for-pickup", world.owner)).statusCode).toBe(200);
      const read = async () => (await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: customer })).json() as { handoverCode: string; handoverLocked: boolean };
      return { order, read, recover: (headers = customer) => app.inject({ method: "POST", url: `/v1/orders/${order.id}/handover-code/recover`, headers }) };
    };

    it("lets the Customer rotate it, which opens it again, and never the shop", async () => {
      const world = await stocked();
      const { order, read, recover } = await lockedPickup(world);
      const before = await read();
      expect(before.handoverLocked).toBe(false);
      // Not locked yet: nothing to recover.
      expect((await recover()).statusCode).toBe(409);
      // Six wrong tries, the cooldown waited out after the third.
      const miss = before.handoverCode === "0000" ? "1111" : "0000";
      for (let tries = 0; tries < 3; tries += 1) await shopPost(order.id, "picked-up", world.owner, { handoverCode: miss, payment: "cash" });
      at("2030-01-01T00:04:00.000Z");
      for (let tries = 0; tries < 3; tries += 1) await shopPost(order.id, "picked-up", world.owner, { handoverCode: miss, payment: "cash" });
      expect((await read()).handoverLocked).toBe(true);
      expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: before.handoverCode, payment: "cash" })).statusCode).toBe(429);
      at("2030-01-01T00:08:00.000Z");
      expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: before.handoverCode, payment: "cash" })).statusCode).toBe(429);

      // Only the order's own Customer can ask; an Owner, Staff or another Customer is told there is no such order.
      expect((await recover(world.owner)).statusCode).toBe(404);
      expect((await recover(world.staff)).statusCode).toBe(404);
      expect((await recover(await signIn("/v1/auth", "other@example.com"))).statusCode).toBe(404);

      const recovered = await recover();
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ status: "ready", handoverLocked: false });
      const fresh = await read();
      expect(fresh.handoverLocked).toBe(false);
      expect((await database.pool.query("SELECT handover_code_attempts AS attempts, handover_code_blocked_until AS blocked FROM orders WHERE id = $1", [order.id])).rows[0]).toEqual({ attempts: 0, blocked: null });
      // The old code no longer opens it, the new one does, and the payment is recorded.
      if (fresh.handoverCode !== before.handoverCode) {
        expect((await shopPost(order.id, "picked-up", world.owner, { handoverCode: before.handoverCode, payment: "cash" })).statusCode).toBe(400);
      }
      const done = await shopPost(order.id, "picked-up", world.owner, { handoverCode: fresh.handoverCode, payment: "cash" });
      expect(done.statusCode).toBe(200);
      expect(await row(order.id)).toMatchObject({ status: "picked_up", delivery_payment: "cash" });
      // A pickup that is collected has nothing left to recover.
      expect((await recover()).statusCode).toBe(409);
    });

    it("refuses once the pickup is no longer Ready, and for a delivery before its items check", async () => {
      setOrderTiming({ collectSeconds: 300 });
      const world = await stocked();
      const { order, recover } = await lockedPickup(world);
      await database.pool.query("UPDATE orders SET handover_code_attempts = 6 WHERE id = $1", [order.id]);
      at("2030-01-01T00:07:00.000Z");
      await runJob(database, "expire-pickups", clock);
      expect((await row(order.id)).status).toBe("not_collected");
      expect((await recover()).statusCode).toBe(409);

      const cart = await save(world.shopId, [{ listingId: world.atta, count: 1 }]);
      const delivery = (await placeDelivery(world.shopId, cart.revision, cart.quote?.total ?? "", world.home)).json() as { id: string };
      await database.pool.query("UPDATE orders SET handover_code_attempts = 6 WHERE id = $1", [delivery.id]);
      expect((await app.inject({ method: "POST", url: `/v1/orders/${delivery.id}/handover-code/recover`, headers: customer })).statusCode).toBe(409);
    });
  });
});
