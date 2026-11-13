import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { couponByCode, couponRefusal } from "../src/coupons";
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

beforeEach(async () => {
  name = `ygo_coupon_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, shopDiscountsAvailable: true });
  await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: adminEmail } });
  const code = mailer.sent.findLast((sent) => sent.to === adminEmail)?.text.match(/code is (\d{6})/)?.[1];
  const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: adminEmail, code } });
  admin = { authorization: `Bearer ${signed.json().accessToken as string}` };
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function signIn(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

/** A Live shop 300 m north of the Customer, in its own Area, with its Owner signed in. */
async function shop(state = "live", email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 300::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', 2000, now(), now())`, [shopId, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  return { ...owner, shopId };
}

async function staffOf(shopId: string) {
  const staff = await signIn("staff@example.com");
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
  return staff;
}

const publish = (scope: object, values: object) =>
  app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope, values, reason: "Pilot card" } });
const card = {
  // The configured default base (CONTEXT.md, Pricing engine): commission after the shop-funded discount.
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "after_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};
const here = "pincode=411038&latitude=18.5&longitude=73.8";
type Who = { id: string; headers: Record<string, string>; home: string };
let paudArea = "";

/** A Customer at home in Kothrud; the shop's Area is made once. */
async function customer(email = "customer@example.com"): Promise<Who> {
  const who = await signIn(email);
  await database.pool.query("INSERT INTO areas (name) VALUES ('Kothrud') ON CONFLICT DO NOTHING");
  const kothrud = (await database.pool.query<{ id: string }>("SELECT id FROM areas WHERE name = 'Kothrud'")).rows[0]?.id;
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1) ON CONFLICT DO NOTHING", [kothrud]);
  await database.pool.query("INSERT INTO areas (name) VALUES ('Paud Road') ON CONFLICT DO NOTHING");
  paudArea = (await database.pool.query<{ id: string }>("SELECT id FROM areas WHERE name = 'Paud Road'")).rows[0]?.id ?? "";
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1) ON CONFLICT DO NOTHING", [paudArea]);
  const { rows: [home] } = await database.pool.query<{ id: string }>(
    `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
     VALUES ($1, 'home', 'Flat 4B', 'Kothrud', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, now()) RETURNING id`, [who.id]);
  return { ...who, home: home?.id ?? "" };
}
async function listing(shopId: string, price: string, categoryName?: string) {
  const category = categoryName
    ? (await database.pool.query<{ id: string }>("INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [categoryName])).rows[0]?.id
      ?? (await database.pool.query<{ id: string }>("SELECT id FROM categories WHERE name = $1", [categoryName])).rows[0]?.id
    : (await database.pool.query<{ id: string }>("SELECT id FROM categories ORDER BY name LIMIT 1")).rows[0]?.id;
  const product = (await database.pool.query<{ id: string }>(
    `INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
     VALUES ($1, $2, 'each', 'counted', true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [`Item ${randomUUID()}`, category])).rows[0]?.id;
  const pack = (await database.pool.query<{ id: string }>("INSERT INTO packs (product_id, quantity) VALUES ($1, '1') RETURNING id", [product])).rows[0]?.id;
  const id = (await database.pool.query<{ id: string }>(
    "INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) VALUES ($1, $2, $3, $3, $3) RETURNING id", [shopId, pack, price])).rows[0]?.id ?? "";
  await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) VALUES ($1, $2, $3, 'opening', '50')", [id, randomUUID(), randomUUID()]);
  return id;
}

type Cart = { revision: number; quote: { total: string; shopDiscount: unknown; coupon?: { code: string; applied: boolean; amount: string; reason: string | null } | null } | null };
const cartUrl = (shopId: string) => `/v1/carts/${shopId}?${here}`;
const couponUrl = (shopId: string) => `/v1/carts/${shopId}/coupon?${here}`;
/** A cart of `lines`, with `code` on it when given; `place` orders it at the quoted total. `put` answers the coupon request itself. */
async function cartOf(shopId: string, who: Who, lines: Array<{ listingId: string; count: number }>, code?: string) {
  const { revision } = (await app.inject({ method: "GET", url: cartUrl(shopId), headers: who.headers })).json() as { revision: number };
  let cart = (await app.inject({ method: "PUT", url: cartUrl(shopId), headers: who.headers, payload: { revision, lines } })).json() as Cart;
  let put;
  if (code) {
    put = await app.inject({ method: "PUT", url: couponUrl(shopId), headers: who.headers, payload: { code } });
    if (put.statusCode === 200) cart = put.json() as Cart;
  }
  return { cart, put, place: () => app.inject({ method: "POST", url: `/v1/carts/${shopId}/order`, headers: who.headers, payload: { revision: cart.revision, total: cart.quote?.total, addressId: who.home } }) };
}

const terms = (over: object = {}) => ({
  code: "SAVE10", form: "percentage", percentage: "10", cap: null, minimumOrder: null, startsAt: null, expiresAt: "2031-01-01T00:00:00.000Z",
  usageLimit: null, perCustomerLimit: 1, firstOrderOnly: false, areaIds: [], categoryIds: [], active: true, ...over,
});
const adminSave = (body: object, id?: string) => app.inject({ method: id ? "PUT" : "POST", url: id ? `/v1/admin/coupons/${id}` : "/v1/admin/coupons", headers: admin, payload: body });
/** A flat coupon's terms: no percentage and no cap. */
const flatTerms = (over: object = {}) => Object.fromEntries(Object.entries(terms({ form: "flat", amount: "10", ...over })).filter(([key]) => key !== "percentage" && key !== "cap"));
const platform = (over: object = {}) => adminSave({ ...("form" in over && over.form === "flat" ? flatTerms(over) : terms(over)), funding: "platform" });
const shopFunded = (shopId: string, over: object = {}) => adminSave({ ...("form" in over && over.form === "flat" ? flatTerms(over) : terms(over)), funding: "shop", shopId });
const created = async (response: Awaited<ReturnType<typeof platform>>) => { expect(response.statusCode).toBe(201); return response.json().coupon as { id: string; code: string; version: number; status: string }; };
const discount = (headers: Record<string, string>, body: object) => app.inject({ method: "PUT", url: "/v1/me/shop-discount", headers, payload: body });
const simulate = async (body: object) => (await app.inject({ method: "POST", url: "/v1/admin/price-simulator", headers: admin, payload: body })).json();
const orderRow = async (id: string) => (await database.pool.query(
  `SELECT shop_discount::text AS "shopDiscount", shop_coupon::text AS "shopCoupon", platform_coupon::text AS "platformCoupon", coupon_id AS "couponId", coupon_version AS "couponVersion",
      total::text AS total, quote FROM orders WHERE id = $1`, [id])).rows[0];
const uses = async (couponId?: string) => (await database.pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM coupon_uses u JOIN orders o ON o.id = u.order_id WHERE ($1::uuid IS NULL OR u.coupon_id = $1) AND o.status NOT IN ('cancelled_by_customer', 'cancelled_by_shop', 'rejected_by_shop', 'expired')", [couponId ?? null])).rows[0]?.n;

/** A shop with a ₹200 item, the global card, and a Customer. At ₹200 the order earns 20 commission and 6 of the 30 delivery: 26 against the 15 floor, a surplus of 11. */
async function setup() {
  const owner = await shop();
  await publish({ type: "global" }, card);
  const who = await customer();
  const item = await listing(owner.shopId, "200");
  return { owner, who, item, lines: [{ listingId: item, count: 1 }] };
}

describe("Saving coupons (CRT-3, ADM-5, #70)", () => {
  it("saves a platform-funded and a shop-funded coupon, keeps every version and does not bump an unchanged save", async () => {
    const { owner } = await setup();
    const a = await created(await platform());
    const b = await created(await shopFunded(owner.shopId, { code: "SHOP5", percentage: "5" }));
    expect((await adminSave({ ...terms(), funding: "platform" }, a.id)).json().coupon.version).toBe(1);
    expect((await adminSave({ ...terms({ percentage: "12" }), funding: "platform" }, a.id)).json().coupon).toMatchObject({ version: 2, percentage: "12", funding: "platform", shopId: null });
    expect((await adminSave({ ...terms({ code: "SHOP5", percentage: "5", active: false }), funding: "shop", shopId: owner.shopId }, b.id)).json().coupon).toMatchObject({ version: 2, status: "off", funding: "shop", shopId: owner.shopId });
    expect((await app.inject({ method: "GET", url: "/v1/admin/coupons", headers: admin })).json().coupons).toHaveLength(2);
    expect((await database.pool.query("SELECT coupon_id, version FROM coupon_versions ORDER BY coupon_id, version")).rowCount).toBe(4);
    for (const sql of ["UPDATE coupon_versions SET code = 'X'", "DELETE FROM coupon_versions", "TRUNCATE coupon_versions CASCADE"]) await expect(database.pool.query(sql), sql).rejects.toThrow(/append-only/);
  });

  it("records every Admin save in admin_actions, and an Owner's save is no Admin action (ADM-10)", async () => {
    const { owner } = await setup();
    const a = await created(await platform());
    await adminSave({ ...terms({ percentage: "12" }), funding: "platform" }, a.id);
    const record = async () => (await database.pool.query<{ action: string; target_id: string; target_type: string }>("SELECT action, target_id, target_type FROM admin_actions WHERE action LIKE 'coupon.%' ORDER BY created_at")).rows;
    expect(await record()).toEqual([{ action: "coupon.create", target_id: a.id, target_type: "coupon" }, { action: "coupon.update", target_id: a.id, target_type: "coupon" }]);
    // A refused save leaves no record; an Owner's own coupon is not an Admin action.
    expect((await adminSave({ ...terms({ code: "SAVE10" }), funding: "platform" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/me/coupons", headers: owner.headers, payload: terms({ code: "OWN5", percentage: "5" }) })).statusCode).toBe(201);
    expect(await record()).toHaveLength(2);
  });

  it("keeps a code unique whatever its case, in the database too", async () => {
    await setup();
    await created(await platform({ code: "Save10" }));
    const again = await platform({ code: "SAVE10" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: "COUPON_CODE_TAKEN" } });
    await expect(database.pool.query(
      `INSERT INTO coupons (version, code, funding, form, percentage, status, expires_at, per_customer_limit, updated_at) VALUES (1, 'sAVE10', 'platform', 'percentage', 5, 'off', now(), 1, now())`),
    ).rejects.toThrow(/coupons_code_lower_idx/);
  });

  it("refuses a shop-funded coupon over the shop's maximum on each form's worst case, and a platform one has no such maximum", async () => {
    const { owner } = await setup();
    const over = await shopFunded(owner.shopId, { percentage: "25" });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: { code: "COUPON_ABOVE_MAXIMUM", maximumPercentage: "20" } });
    // ₹200 off at ₹500 is 40%; at ₹1,000 it is exactly the 20% maximum.
    expect((await shopFunded(owner.shopId, { code: "FLAT200", form: "flat", amount: "200", minimumOrder: "500" })).statusCode).toBe(400);
    expect((await shopFunded(owner.shopId, { code: "FLAT200", form: "flat", amount: "200", minimumOrder: "1000" })).statusCode).toBe(201);
    expect((await platform({ code: "BIG50", percentage: "50" })).statusCode).toBe(201);
    // A shop-funded flat coupon with no minimum order has no worst case to hold, so it is not valid at all.
    expect((await shopFunded(owner.shopId, { code: "NOMIN", form: "flat", amount: "10", minimumOrder: null })).statusCode).toBe(400);
    expect((await platform({ code: "AREA1", areaIds: [randomUUID()] })).json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["areaIds"] } });
  });

  it("lets an Owner manage only their own shop's coupons, always shop-funded, and never Staff", async () => {
    const one = await shop("live", "one@example.com");
    const two = await shop("live", "two@example.com");
    const staff = await staffOf(one.shopId);
    const mine = await app.inject({ method: "POST", url: "/v1/me/coupons", headers: one.headers, payload: terms({ code: "MINE10" }) });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().coupon).toMatchObject({ funding: "shop", shopId: one.shopId });
    const theirs = await created(await shopFunded(two.shopId, { code: "THEIRS" }));
    const everyone = await created(await platform({ code: "EVERYONE" }));
    expect((await app.inject({ method: "GET", url: "/v1/me/coupons", headers: one.headers })).json()).toMatchObject({ coupons: [{ code: "MINE10" }], maximumPercentage: "20" });
    for (const id of [theirs.id, everyone.id]) {
      expect((await app.inject({ method: "PUT", url: `/v1/me/coupons/${id}`, headers: one.headers, payload: terms({ code: "HIJACK" }) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "PUT", url: `/v1/me/coupons/${mine.json().coupon.id}`, headers: one.headers, payload: terms({ code: "MINE10", percentage: "8" }) })).json().coupon).toMatchObject({ version: 2, percentage: "8" });
    expect((await app.inject({ method: "GET", url: "/v1/me/coupons", headers: staff.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/me/coupons", headers: staff.headers, payload: terms({ code: "STAFF" }) })).statusCode).toBe(403);
    // A body that names a shop or a funding is not an Owner's to send.
    expect((await app.inject({ method: "POST", url: "/v1/me/coupons", headers: one.headers, payload: { ...terms({ code: "OTHER" }), funding: "platform" } })).statusCode).toBe(400);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM coupons WHERE code = 'HIJACK'")).rows[0]).toEqual({ n: 0 });
  });
});

describe("Placing an order with a coupon (CRT-3, MNY-6, #70)", () => {
  it("takes a platform-funded percentage coupon off at most the surplus above the floor, recorded apart from the shop's amounts", async () => {
    const { owner, who, lines } = await setup();
    const c = await created(await platform());
    const { cart, place } = await cartOf(owner.shopId, who, lines, "save10");
    // 10% of 200 is 20, but the order earns 11 above the floor: 200 - 11 + 30.
    expect(cart.quote).toMatchObject({ total: "219.00", shopDiscount: null, coupon: { code: "SAVE10", applied: true, amount: "11.00", reason: null } });
    const placed = await place();
    expect(placed.statusCode).toBe(201);
    const row = await orderRow(placed.json().id);
    expect(row).toMatchObject({ shopDiscount: "0.00", shopCoupon: "0.00", platformCoupon: "11.00", couponId: c.id, couponVersion: 1, total: "219.00" });
    // The commission is on the base before the coupon; the platform keeps 15 (the floor) and the shop keeps what it did not owe.
    expect(row.quote).toMatchObject({ commission: "20.00", platformContribution: "15.00", shopKeeps: "204.00", coupon: { funding: "platform", platformFunded: "11.00", shopFunded: "0.00" } });
    expect(await uses(c.id)).toBe(1);
    // The cart has dropped the coupon with its lines.
    expect((await app.inject({ method: "GET", url: cartUrl(owner.shopId), headers: who.headers })).json().quote).toBeNull();
  });

  it("refuses a flat platform coupon the order cannot pay in full, with the reason, and takes a smaller one", async () => {
    const { owner, who, lines } = await setup();
    await created(await platform({ code: "FLAT50", form: "flat", amount: "50" }));
    await created(await platform({ code: "FLAT10", form: "flat", amount: "10" }));
    const big = await cartOf(owner.shopId, who, lines, "FLAT50");
    expect(big.put?.statusCode).toBe(409);
    expect(big.put?.json()).toEqual({ error: { code: "COUPON_NOT_ELIGIBLE", couponReason: "NO_ROOM" } });
    expect((await cartOf(owner.shopId, who, lines, "FLAT10")).cart.quote).toMatchObject({ total: "220.00", coupon: { applied: true, amount: "10.00" } });
  });

  it("takes a shop-funded coupon off the commission base, in parts on the lines that add up to its amount", async () => {
    const { owner, who, lines } = await setup();
    const c = await created(await shopFunded(owner.shopId));
    const { cart, place } = await cartOf(owner.shopId, who, lines, "SAVE10");
    expect(cart.quote).toMatchObject({ total: "210.00", coupon: { applied: true, amount: "20.00" } });
    const id = (await place()).json().id as string;
    const row = await orderRow(id);
    expect(row).toMatchObject({ shopDiscount: "0.00", shopCoupon: "20.00", platformCoupon: "0.00", couponId: c.id, total: "210.00" });
    // 10% of the 180 the line keeps.
    expect(row.quote).toMatchObject({ commission: "18.00", coupon: { funding: "shop", shopFunded: "20.00", platformFunded: "0.00" } });
    expect((await database.pool.query("SELECT sum(shop_discount)::text AS parts FROM order_lines WHERE order_id = $1", [id])).rows[0]).toEqual({ parts: "20.00" });
  });

  it("applies the better of a coupon and the shop-wide discount, the shop-wide on a tie, and counts only the one that applied", async () => {
    const { owner, who, lines } = await setup();
    const c = await created(await platform());
    // The coupon gives 11 (trimmed); a 5% discount gives 10, so the coupon applies and no discount does.
    await discount(owner.headers, { form: "percentage", percentage: "5", cap: null, active: true });
    const better = await cartOf(owner.shopId, who, lines, "SAVE10");
    expect(better.cart.quote).toMatchObject({ total: "219.00", shopDiscount: null, coupon: { applied: true, amount: "11.00" } });
    const placed = await better.place();
    expect(await orderRow(placed.json().id)).toMatchObject({ shopDiscount: "0.00", platformCoupon: "11.00" });
    expect(await uses(c.id)).toBe(1);

    // With a 10% discount (20) the discount takes more: the coupon stays on the cart, not applied, and is not counted.
    const other = await customer("other@example.com");
    await discount(owner.headers, { form: "percentage", percentage: "10", cap: null, active: true });
    const worse = await cartOf(owner.shopId, other, lines, "SAVE10");
    expect(worse.put?.statusCode).toBe(200);
    expect(worse.cart.quote).toMatchObject({ total: "210.00", shopDiscount: { amount: "20.00" }, coupon: { code: "SAVE10", applied: false, amount: "0.00", reason: "BETTER_OFFER" } });
    const second = await worse.place();
    expect(await orderRow(second.json().id)).toMatchObject({ shopDiscount: "20.00", shopCoupon: "0.00", platformCoupon: "0.00", couponId: null });
    expect(await uses(c.id)).toBe(1);
  });

  it("gives the shop-wide discount a tie against a shop-funded coupon", async () => {
    const { owner, who, lines } = await setup();
    await created(await shopFunded(owner.shopId));
    await discount(owner.headers, { form: "percentage", percentage: "10", cap: null, active: true });
    const { cart, place } = await cartOf(owner.shopId, who, lines, "SAVE10");
    expect(cart.quote).toMatchObject({ total: "210.00", shopDiscount: { amount: "20.00" }, coupon: { applied: false, reason: "BETTER_OFFER" } });
    expect(await orderRow((await place()).json().id)).toMatchObject({ shopDiscount: "20.00", shopCoupon: "0.00", couponId: null });
  });

  it("never lets an order hold a coupon beside a shop-wide discount, whatever wrote it", async () => {
    const { owner, who, lines } = await setup();
    await created(await shopFunded(owner.shopId));
    const id = (await (await cartOf(owner.shopId, who, lines, "SAVE10")).place()).json().id as string;
    await database.pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
    try {
      await expect(database.pool.query("UPDATE orders SET shop_discount = 5 WHERE id = $1", [id])).rejects.toThrow(/orders_coupon_valid|orders_shop_discount_valid/);
    } finally { await database.pool.query("ALTER TABLE orders ENABLE TRIGGER USER"); }
  });

  it("tells a Customer why a coupon cannot go on the cart: dates, area, categories, minimum, first order and own limit", async () => {
    const { owner, who, lines } = await setup();
    const reason = async (code: string) => (await cartOf(owner.shopId, who, lines, code)).put?.json().error?.couponReason;
    await created(await platform({ code: "FUTURE", startsAt: "2030-06-01T00:00:00.000Z" }));
    await created(await platform({ code: "OLD", startsAt: "2029-01-01T00:00:00.000Z", expiresAt: "2029-12-31T00:00:00.000Z" }));
    await created(await platform({ code: "OFF", active: false }));
    await created(await platform({ code: "ELSEWHERE", areaIds: [(await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Other') RETURNING id")).rows[0]?.id] }));
    await created(await platform({ code: "HERE", areaIds: [paudArea] }));
    const other = (await database.pool.query<{ id: string }>("INSERT INTO categories (name) VALUES ('Soap') RETURNING id")).rows[0]?.id;
    await created(await platform({ code: "SOAPONLY", categoryIds: [other] }));
    await created(await platform({ code: "BIGCART", minimumOrder: "500" }));
    await created(await platform({ code: "FIRST", firstOrderOnly: true }));
    expect(await reason("NOSUCH")).toBe("NOT_AVAILABLE");
    expect(await reason("future")).toBe("NOT_STARTED");
    expect(await reason("OLD")).toBe("EXPIRED");
    expect(await reason("OFF")).toBe("NOT_AVAILABLE");
    expect(await reason("ELSEWHERE")).toBe("NOT_AVAILABLE");
    expect(await reason("SOAPONLY")).toBe("NOTHING_ELIGIBLE");
    expect(await reason("BIGCART")).toBe("BELOW_MINIMUM");
    expect((await cartOf(owner.shopId, who, lines, "HERE")).put?.statusCode).toBe(200);
    // Once ordered, the first-order-only coupon and the Customer's own limit refuse.
    expect((await (await cartOf(owner.shopId, who, lines)).place()).statusCode).toBe(201);
    expect(await reason("FIRST")).toBe("FIRST_ORDER_ONLY");
    const used = await (await cartOf(owner.shopId, who, lines, "HERE")).place();
    expect(used.statusCode).toBe(201);
    expect(await reason("HERE")).toBe("ALREADY_USED");
  });

  it("targets an Area by the shop's Area, never the Customer's, who belongs to none", async () => {
    const { owner, who, lines } = await setup();
    // The Customer is at home in Kothrud and the shop is in Paud Road.
    const kothrud = (await database.pool.query<{ id: string }>("SELECT id FROM areas WHERE name = 'Kothrud'")).rows[0]?.id;
    await created(await platform({ code: "MYAREA", areaIds: [kothrud] }));
    await created(await platform({ code: "SHOPAREA", areaIds: [paudArea] }));
    expect((await cartOf(owner.shopId, who, lines, "MYAREA")).put?.json().error?.couponReason).toBe("NOT_AVAILABLE");
    expect((await cartOf(owner.shopId, who, lines, "SHOPAREA")).put?.statusCode).toBe(200);
  });

  it("offers a cart only the coupons it can take, with what each takes off", async () => {
    const { owner, who, lines } = await setup();
    await created(await platform({ code: "TEN" }));
    await created(await platform({ code: "BIGCART", minimumOrder: "500" }));
    await created(await platform({ code: "OLD", startsAt: "2029-01-01T00:00:00.000Z", expiresAt: "2029-12-31T00:00:00.000Z" }));
    await cartOf(owner.shopId, who, lines);
    const listed = await app.inject({ method: "GET", url: `/v1/carts/${owner.shopId}/coupons?${here}`, headers: who.headers });
    expect(listed.json()).toEqual({ coupons: [{ id: expect.any(String), code: "TEN", amount: "11.00" }] });
  });

  it("clears the coupon from the cart on request", async () => {
    const { owner, who, lines } = await setup();
    await created(await platform());
    expect((await cartOf(owner.shopId, who, lines, "SAVE10")).cart.quote?.coupon).toMatchObject({ applied: true });
    const cleared = await app.inject({ method: "DELETE", url: couponUrl(owner.shopId), headers: who.headers });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().quote).toMatchObject({ total: "230.00" });
    expect(cleared.json().quote).not.toHaveProperty("coupon");
  });

  it("refuses a coupon on an order with a bargained line, naming what to remove (BRG-5)", async () => {
    const { owner, who } = await setup();
    const c = await created(await platform());
    const row = await couponByCode(database.pool, c.code);
    if (!row) throw new Error("coupon missing");
    const ctx = { accountId: who.id, shopId: owner.shopId, now: clock.now() };
    expect(await couponRefusal(database.pool, row, { ...ctx, bargained: false })).toBeNull();
    expect(await couponRefusal(database.pool, row, { ...ctx, bargained: true })).toBe("WITH_BARGAIN");
  });
});

describe("A coupon's usage limits (CRT-3, #70)", () => {
  it("lets only one of two Customers racing for the last use order, and tells the other the coupon is used up", async () => {
    const { owner, lines, who } = await setup();
    const c = await created(await platform({ usageLimit: 1 }));
    const two = await customer("two@example.com");
    const [a, b] = await Promise.all([cartOf(owner.shopId, who, lines, "SAVE10"), cartOf(owner.shopId, two, lines, "SAVE10")]);
    expect([a.put?.statusCode, b.put?.statusCode]).toEqual([200, 200]);
    const placed = await Promise.all([a.place(), b.place()]);
    expect(placed.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const lost = placed.find((response) => response.statusCode === 409)?.json();
    expect(lost.error).toMatchObject({ code: "CART_CHANGED", cart: { quote: { coupon: { applied: false, reason: "LIMIT_REACHED" } } } });
    expect(await uses(c.id)).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0]).toEqual({ n: 1 });
  });

  it("never counts one order twice, however often its placement is retried at once", async () => {
    const { owner, lines, who } = await setup();
    const c = await created(await platform({ usageLimit: 5, perCustomerLimit: 5 }));
    const { place } = await cartOf(owner.shopId, who, lines, "SAVE10");
    const placed = await Promise.all([place(), place(), place()]);
    expect(placed.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(await uses(c.id)).toBe(1);
    // The use is the order's own, keyed by it: a second insert for the same order is a no-op.
    const order = (await database.pool.query<{ id: string }>("SELECT id FROM orders")).rows[0]?.id;
    await database.pool.query("INSERT INTO coupon_uses (order_id, coupon_id, account_id, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (order_id) DO NOTHING", [order, c.id, who.id]);
    expect(await uses(c.id)).toBe(1);
  });

  it("gives a use back when its order is rejected, cancelled or expires, and keeps it once the order goes on", async () => {
    const { owner, lines, who } = await setup();
    const c = await created(await platform({ usageLimit: 1, perCustomerLimit: 5 }));
    const two = await customer("two@example.com");
    const order = async (by: Who) => { const response = await (await cartOf(owner.shopId, by, lines, "SAVE10")).place(); expect(response.statusCode).toBe(201); return response.json().id as string; };
    const refused = async (by: Who) => (await cartOf(owner.shopId, by, lines, "SAVE10")).put?.json().error?.couponReason;

    const first = await order(who);
    expect(await refused(two)).toBe("LIMIT_REACHED");
    // The shop rejects it: the use is back.
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${first}/reject`, headers: owner.headers, payload: { reason: "too_busy" } })).statusCode).toBe(200);
    expect(await uses(c.id)).toBe(0);
    const second = await order(two);
    expect(await refused(who)).toBe("LIMIT_REACHED");
    // The Customer cancels it before it is answered.
    expect((await app.inject({ method: "POST", url: `/v1/orders/${second}/cancel`, headers: two.headers })).statusCode).toBe(200);
    expect(await uses(c.id)).toBe(0);
    const third = await order(who);
    expect(await refused(two)).toBe("LIMIT_REACHED");
    // Nobody answers in time.
    await database.pool.query("UPDATE orders SET status = 'expired' WHERE id = $1", [third]);
    expect(await uses(c.id)).toBe(0);
    const fourth = await order(two);
    // Accepted, it stays counted.
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${fourth}/accept`, headers: owner.headers })).statusCode).toBe(200);
    expect(await uses(c.id)).toBe(1);
    expect(await refused(who)).toBe("LIMIT_REACHED");
  });
});

describe("A lower maximum pauses the shop-funded coupons it breaks (D-12, NOT-6, #70)", () => {
  it("pauses a coupon over the new maximum, never reducing it, tells its Owner once, and stops it applying", async () => {
    const { owner, who, lines } = await setup();
    const saved = await app.inject({ method: "POST", url: "/v1/me/coupons", headers: owner.headers, payload: terms({ code: "OWN18", percentage: "18" }) });
    expect(saved.statusCode).toBe(201);
    const under = await created(await shopFunded(owner.shopId, { code: "UNDER", percentage: "10" }));
    const platformOne = await created(await platform({ code: "PLAT", percentage: "50" }));
    expect((await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "15" })).statusCode).toBe(201);
    const list = (await app.inject({ method: "GET", url: "/v1/me/coupons", headers: owner.headers })).json();
    expect(list.coupons.find((coupon: { code: string }) => coupon.code === "OWN18")).toMatchObject({ status: "paused", percentage: "18", version: 2 });
    expect(list.coupons.find((coupon: { id: string }) => coupon.id === under.id)).toMatchObject({ status: "active", version: 1 });
    expect((await database.pool.query("SELECT status FROM coupons WHERE id = $1", [platformOne.id])).rows[0]).toEqual({ status: "active" });
    expect((await database.pool.query("SELECT actor_id FROM coupon_versions WHERE version = 2")).rows).toEqual([{ actor_id: null }]);
    const told = (await database.pool.query("SELECT account_id, title, body FROM notifications WHERE kind = 'coupon_paused'")).rows;
    expect(told).toEqual([{ account_id: owner.id, title: "Your coupon OWN18 is paused", body: expect.stringContaining("15%") }]);
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "15" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'coupon_paused'")).rows[0]).toEqual({ n: 1 });
    // A paused coupon is refused, and the Owner turns it on by saving it under the maximum.
    expect((await cartOf(owner.shopId, who, lines, "OWN18")).put?.json().error.couponReason).toBe("NOT_AVAILABLE");
    const id = saved.json().coupon.id as string;
    expect((await app.inject({ method: "PUT", url: `/v1/me/coupons/${id}`, headers: owner.headers, payload: terms({ code: "OWN18", percentage: "18" }) })).json()).toEqual({ error: { code: "COUPON_ABOVE_MAXIMUM", maximumPercentage: "15" } });
    expect((await app.inject({ method: "PUT", url: `/v1/me/coupons/${id}`, headers: owner.headers, payload: terms({ code: "OWN18", percentage: "15" }) })).json().coupon).toMatchObject({ status: "active", version: 3 });
  });
});

describe("The price simulator tries a coupon (ADM-5, MNY-10, #70)", () => {
  it("shows an eligible coupon, an ineligible one, a platform one trimmed to the surplus, a used-up one, and one over a draft's lower maximum", async () => {
    const { owner, who, item } = await setup();
    const lines = [{ listingId: item, count: 1 }];
    await created(await shopFunded(owner.shopId, { code: "SHOP10" }));
    await created(await shopFunded(owner.shopId, { code: "BIG", minimumOrder: "500" }));
    await created(await platform({ code: "PLAT10" }));
    await created(await platform({ code: "ONCE", usageLimit: 1, perCustomerLimit: 5 }));

    const eligible = await simulate({ shopId: owner.shopId, lines, couponCode: "shop10" });
    expect(eligible.now).toMatchObject({ customerTotal: "210.00", shopKeeps: "186.00", coupon: { applied: true, reason: null, funding: "shop", shopFunded: "20.00", platformFunded: "0.00" } });
    expect(eligible.draft).toBeNull();

    expect((await simulate({ shopId: owner.shopId, lines, couponCode: "BIG" })).now).toMatchObject({ customerTotal: "230.00", coupon: { applied: false, reason: "BELOW_MINIMUM", shopFunded: "0.00" } });

    // 10% of 200 is 20; the order earns 11 above the floor, so the platform pays 11 and keeps the 15 floor.
    expect((await simulate({ shopId: owner.shopId, lines, couponCode: "PLAT10" })).now).toMatchObject({
      customerTotal: "219.00", platformContribution: "15.00", shopKeeps: "204.00", coupon: { applied: true, funding: "platform", platformFunded: "11.00", shopFunded: "0.00" },
    });

    // The only use goes to an order, so the next quote says it is used up.
    expect((await (await cartOf(owner.shopId, who, lines, "ONCE")).place()).statusCode).toBe(201);
    expect((await simulate({ shopId: owner.shopId, lines, couponCode: "ONCE" })).now).toMatchObject({ customerTotal: "230.00", coupon: { applied: false, reason: "LIMIT_REACHED" } });

    // A draft that lowers the maximum to 5% leaves the saved card's quote alone and shows the shop-funded coupon not applying.
    const tried = await simulate({ shopId: owner.shopId, lines, couponCode: "SHOP10", draft: { scope: { type: "global" }, values: { ...card, maximumShopDiscountPercentage: "5" } } });
    expect(tried.now.coupon).toMatchObject({ applied: true });
    expect(tried.draft).toMatchObject({ customerTotal: "230.00", coupon: { applied: false, reason: "NOT_AVAILABLE" } });
    expect((await simulate({ shopId: owner.shopId, lines, couponCode: "NOSUCH" })).error.code).toBe("NOT_FOUND");
  });
});

describe("Accepting an order with a coupon in part (ORD-3, MNY-6, #70)", () => {
  async function accepted(coupon: "shop" | "platform", over: object = {}) {
    const owner = await shop();
    await publish({ type: "global" }, card);
    const who = await customer();
    const keep = await listing(owner.shopId, "200");
    const drop = await listing(owner.shopId, "100");
    const c = coupon === "shop" ? await created(await shopFunded(owner.shopId, over)) : await created(await platform(over));
    const { place, cart } = await cartOf(owner.shopId, who, [{ listingId: keep, count: 1 }, { listingId: drop, count: 1 }], "SAVE10");
    const id = (await place()).json().id as string;
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/accept`, headers: owner.headers })).statusCode).toBe(200);
    return { owner, who, id, drop, c, cart };
  }
  const revision = async (id: string) => (await database.pool.query(
    `SELECT shop_discount::text AS "shopDiscount", shop_coupon::text AS "shopCoupon", platform_coupon::text AS "platformCoupon", coupon_id AS "couponId", total::text AS total, commission::text AS commission, quote->'coupon' AS "nested",
        (SELECT COALESCE(sum(l.shop_discount), 0)::text FROM order_revision_lines l WHERE l.revision_id = r.id) AS parts
       FROM order_revisions r WHERE r.order_id = $1 ORDER BY revision DESC LIMIT 1`, [id])).rows[0];
  const dropLine = (owner: { headers: Record<string, string> }, id: string, listingId: string) =>
    app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/partial-accept`, headers: owner.headers, payload: { lines: [{ listingId, count: 0, reason: "out_of_stock" }] } });

  it("re-applies a shop-funded coupon from its frozen version on the revised lines", async () => {
    const { owner, who, id, drop, c, cart } = await accepted("shop");
    // 10% of 300 is 30 off, and 30 delivery.
    expect(cart.quote?.total).toBe("300.00");
    expect((await dropLine(owner, id, drop)).statusCode).toBe(200);
    expect(await revision(id)).toMatchObject({ shopDiscount: "0.00", shopCoupon: "20.00", platformCoupon: "0.00", couponId: c.id, total: "210.00", commission: "18.00", parts: "20.00" });
    expect((await app.inject({ method: "POST", url: `/v1/orders/${id}/confirm-total`, headers: who.headers })).statusCode).toBe(200);
  });

  it("keeps the coupon inside the revision's snapshot the same as the revision's columns", async () => {
    const shopSide = await accepted("shop");
    expect((await dropLine(shopSide.owner, shopSide.id, shopSide.drop)).statusCode).toBe(200);
    expect(await revision(shopSide.id)).toMatchObject({ shopCoupon: "20.00", platformCoupon: "0.00", nested: { applied: true, reason: null, shopFunded: "20.00", platformFunded: "0.00" } });
  });

  it("keeps the platform-funded amount, and a coupon the revised lines no longer meet, the same in the snapshot and the columns", async () => {
    const trimmed = await accepted("platform");
    expect((await dropLine(trimmed.owner, trimmed.id, trimmed.drop)).statusCode).toBe(200);
    expect(await revision(trimmed.id)).toMatchObject({ platformCoupon: "11.00", nested: { applied: true, reason: null, shopFunded: "0.00", platformFunded: "11.00" } });
  });

  it("takes a coupon off when the revised lines fall under its minimum order, and says why in the snapshot", async () => {
    // At 300 the minimum of 250 is met; at 200 it is not.
    const { owner, id, drop } = await accepted("shop", { minimumOrder: "250" });
    expect((await dropLine(owner, id, drop)).statusCode).toBe(200);
    expect(await revision(id)).toMatchObject({ shopCoupon: "0.00", platformCoupon: "0.00", total: "230.00", parts: "0.00", nested: { applied: false, reason: "BELOW_MINIMUM", shopFunded: "0.00", platformFunded: "0.00" } });
  });

  it("works every coupon amount out in the pricing engine's own functions, so the quote and a revision cannot differ (MNY-15)", async () => {
    const one = async (sql: string) => (await database.pool.query<{ v: string | null }>(`SELECT (${sql})::text AS v`)).rows[0]?.v;
    // A percentage coupon is trimmed to the surplus above the floor; a flat one that cannot be paid in full takes nothing; one that can takes its amount.
    expect(await one("pricing_platform_coupon('percentage', 30.00, 36.00, 15.00)")).toBe("21.00");
    expect(await one("pricing_platform_coupon('percentage', 10.00, 36.00, 15.00)")).toBe("10.00");
    expect(await one("pricing_platform_coupon('flat', 30.00, 36.00, 15.00)")).toBe("0.00");
    expect(await one("pricing_platform_coupon('flat', 10.00, 36.00, 15.00)")).toBe("10.00");
    expect(await one("pricing_platform_coupon('percentage', 10.00, 10.00, 15.00)")).toBe("0.00");
    const shares = async (coupon: object, totals: string, usable: string) => (await database.pool.query<{ outcome: string | null; shares: string[] | null }>(
      "SELECT outcome, shares::text[] AS shares FROM pricing_coupon_shares($1::jsonb, $2::numeric[], $3::boolean[])", [JSON.stringify(coupon), totals, usable])).rows[0];
    const ten = { form: "percentage", percentage: "10", cap: null, amount: null, minimumOrder: "150" };
    expect(await shares(ten, "{200,100}", "{true,true}")).toEqual({ outcome: null, shares: ["20.00", "10.00"] });
    expect(await shares(ten, "{100,100}", "{true,false}")).toEqual({ outcome: "below_minimum", shares: null });
    expect(await shares(ten, "{200,100}", "{false,false}")).toEqual({ outcome: "nothing_eligible", shares: null });
  });

  it("works a revision's whole money out in one engine call, for a shop-funded and a platform-funded coupon (MNY-15)", async () => {
    const rule = { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "after_shop_discount" };
    const coupon = (funding: string, over: object = {}) => ({ funding, form: "percentage", percentage: "10", cap: null, amount: null, minimumOrder: null, ...over });
    const quote = async (couponTerms: object | null, over: object = {}) => (await database.pool.query<{ q: Record<string, unknown> }>(
      "SELECT pricing_revision_quote($1::jsonb) AS q", [JSON.stringify({
        lines: [{ lineTotal: "200.00", couponEligible: true, commission: rule }], shopDiscount: null, coupon: couponTerms, floor: "15",
        deliveryFee: "30.00", deliveryPlatformShare: "6.00", smallCartFee: null, smallCartPlatformShare: null, pickupFee: null, pickupShopFee: null, ...over })])).rows[0]?.q;
    // Shop-funded: 20 off the line, commission on the 180 left, the platform's contribution is commission plus its delivery share.
    expect(await quote(coupon("shop"))).toMatchObject({ lines: [{ shopDiscount: "20.00", commission: "18.00" }], productValue: "200.00", shopDiscount: "0.00", shopCoupon: "20.00", platformCoupon: "0.00",
      commission: "18.00", customerTotal: "210.00", platformContribution: "24.00", couponReason: null });
    // Platform-funded: nothing off the line, commission on the full 200, the 20 trimmed to the 11 above the floor, taken off the total and the contribution.
    expect(await quote(coupon("platform"))).toMatchObject({ lines: [{ shopDiscount: "0.00", commission: "20.00" }], shopCoupon: "0.00", platformCoupon: "11.00",
      commission: "20.00", customerTotal: "219.00", platformContribution: "15.00", couponReason: null });
    // A flat platform coupon the surplus cannot pay in full takes nothing and says there is no room.
    expect(await quote(coupon("platform", { form: "flat", percentage: null, amount: "30" }))).toMatchObject({ platformCoupon: "0.00", customerTotal: "230.00", platformContribution: "26.00", couponReason: "NO_ROOM" });
    // Under its minimum order, or with nothing eligible, a coupon of either funding takes nothing and says why.
    for (const funding of ["shop", "platform"]) {
      expect(await quote(coupon(funding, { minimumOrder: "250" }))).toMatchObject({ shopCoupon: "0.00", platformCoupon: "0.00", customerTotal: "230.00", couponReason: "BELOW_MINIMUM" });
      expect(await quote(coupon(funding), { lines: [{ lineTotal: "200.00", couponEligible: false, commission: rule }] })).toMatchObject({ couponReason: "NOTHING_ELIGIBLE", customerTotal: "230.00" });
    }
    // A shop-wide discount stands in place of the coupon; a pickup keeps its booking fee and never takes a platform coupon.
    expect(await quote(coupon("platform"), { shopDiscount: { form: "percentage", percentage: "5", cap: null, amount: null, minimumOrder: null } })).toMatchObject({ shopDiscount: "10.00", shopCoupon: "0.00", platformCoupon: "0.00", customerTotal: "220.00" });
    expect(await quote(coupon("platform"), { pickupFee: "10.00", pickupShopFee: "5.00", deliveryFee: null, deliveryPlatformShare: null,
      lines: [{ lineTotal: "200.00", couponEligible: true }] })).toMatchObject({ platformCoupon: "0.00", commission: "0.00", customerTotal: "210.00", platformContribution: "15.00" });
  });

  it("records a shop-funded revision's quote totals and contribution from the engine", async () => {
    const money = async (id: string) => (await database.pool.query(
      "SELECT quote->>'customerTotal' AS total, quote->>'commission' AS commission, quote->>'platformContribution' AS contribution, quote->>'productValue' AS product FROM order_revisions WHERE order_id = $1 ORDER BY revision DESC LIMIT 1", [id])).rows[0];
    const shopSide = await accepted("shop");
    expect((await dropLine(shopSide.owner, shopSide.id, shopSide.drop)).statusCode).toBe(200);
    expect(await money(shopSide.id)).toEqual({ total: "210.00", commission: "18.00", contribution: "24.00", product: "200.00" });
  });

  it("records a platform-funded revision's quote totals and contribution from the engine", async () => {
    const { owner, id, drop } = await accepted("platform");
    expect((await dropLine(owner, id, drop)).statusCode).toBe(200);
    expect((await database.pool.query(
      "SELECT quote->>'customerTotal' AS total, quote->>'commission' AS commission, quote->>'platformContribution' AS contribution, quote->>'productValue' AS product FROM order_revisions WHERE order_id = $1 ORDER BY revision DESC LIMIT 1", [id])).rows[0])
      .toEqual({ total: "219.00", commission: "20.00", contribution: "15.00", product: "200.00" });
  });

  it("re-trims a platform-funded coupon to the revised surplus", async () => {
    const { owner, id, drop } = await accepted("platform");
    // At 300 the order earns 30 + 6 against the 15 floor: 21 to give. At 200 it is 11.
    expect((await dropLine(owner, id, drop)).statusCode).toBe(200);
    expect(await revision(id)).toMatchObject({ shopDiscount: "0.00", shopCoupon: "0.00", platformCoupon: "11.00", total: "219.00", parts: "0.00" });
  });
});
