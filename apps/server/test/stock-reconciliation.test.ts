import { randomUUID } from "node:crypto";
import { SyncActionsResponse } from "@ygo/contracts";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { runJob } from "../src/jobs";
import { recordDeliverySale } from "../src/delivery";
import { reconcileStock } from "../src/stock-reconciliation";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  name = `ygo_stock_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function account(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

type Line = { packId: string; count: number; unitPrice: string };

/** A shop with no rate card, so "Live with an incomplete rate card" is every Live case here. */
async function shop(state = "live") {
  const owner = await account("owner@example.com");
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, 'approved', 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`,
    [shopId],
  );
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  const categoryId = (await database.pool.query("INSERT INTO categories (name) VALUES ('Staples') RETURNING id")).rows[0]?.id as string;
  /** A listed pack of `quantity` kg with `opening` kg on hand. */
  const pack = async (quantity = "1", opening = "50") => {
    const productId = (await database.pool.query(
      `INSERT INTO master_products (name, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
       VALUES ($2, $1, 'kg', 'measured', 'image256', 'image512', 'image1024', true) RETURNING id`, [categoryId, `Rice ${randomUUID()}`],
    )).rows[0]?.id as string;
    const packId = (await database.pool.query("INSERT INTO packs (product_id, quantity) VALUES ($1, $2) RETURNING id", [productId, quantity])).rows[0]?.id as string;
    await database.pool.query("UPDATE shops SET state = 'approved' WHERE id = $1", [shopId]);
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${packId}`, headers: owner.headers,
      payload: { onlinePrice: "20", counterPrice: "21", mrp: "25", lowStockLevel: "0", minimumOrderQuantity: "0.25", quantityStep: "0.05" } });
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${packId}/opening-stock`, headers: owner.headers, payload: { quantity: opening, clientId: randomUUID() } });
    await database.pool.query("UPDATE shops SET state = $2 WHERE id = $1", [shopId, state]);
    return packId;
  };
  const sequences = new Map<string, number>();
  const bill = (lines: Line[], overrides: Record<string, unknown> = {}) => ({ id: randomUUID(), shopId, type: "counter_bill",
    payload: { lines, total: "0", payment: "cash" }, createdAt: clock.now().toISOString(), clockSuspect: false, ...overrides });
  /** Sends actions from one device, numbering any action that has no sequence yet. */
  const send = async (actions: Array<{ id: string; shopId: string; type: string; payload: unknown; createdAt: string; clockSuspect: boolean; sequence?: number }>, device = "phone", headers = owner.headers, sentAt = clock.now().toISOString()) => {
    const deviceId = `00000000-0000-4000-8000-${device === "phone" ? "000000000001" : "000000000002"}`;
    const numbered = actions.map((action) => {
      if (action.sequence) return action;
      const sequence = (sequences.get(device) ?? 0) + 1;
      sequences.set(device, sequence);
      return Object.assign(action, { sequence });
    });
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers, payload: { deviceId, sentAt, actions: numbered } });
    expect([response.statusCode, response.body]).toEqual([200, expect.any(String)]);
    return SyncActionsResponse.parse(response.json()).results;
  };
  const stock = async (packId: string) => (await database.pool.query(
    "SELECT COALESCE(sum(sm.quantity), 0)::text AS quantity FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id WHERE sl.pack_id = $1", [packId],
  )).rows[0]?.quantity as string;
  const count = async (table: string) => (await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n as number;
  const change = (payload: object, overrides: Record<string, unknown> = {}) => ({ id: randomUUID(), shopId, type: "stock_change", payload, createdAt: clock.now().toISOString(), clockSuspect: false, ...overrides });
  return { owner, shopId, pack, bill, send, stock, count, change };
}


const rateCard = async () => {
  const { rows: [actor] } = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = 'admin@example.com'");
  const { rows: [card] } = await database.pool.query<{ version: string }>(
    "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version", [actor?.id, clock.now()]);
  return String(card?.version);
};
const quote = {
  status: "priced", rateCardVersion: "1", lines: [], sources: {}, productValue: "130.00", shopDiscount: null, commission: "13.00",
  deliveryFee: { amount: "20.00", platformShare: "10.00", shopShare: "10.00" }, smallCartFee: null, customerTotal: "150.00",
  shopKeeps: "117.00", platformContribution: "23.00", placeable: true, reasons: [],
};

/** An online order of `count` packs of one listing, at the given status. */
async function order(shopId: string, customerId: string, packId: string, count: number, status: string, card: string) {
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, fulfilment,
        address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, pickup_fee, total, rate_card_version, quote, shop_discount)
     VALUES ($1, $2, $3, $4, $4, 'Shop', '12 Lane', '411038', 'delivery', 'home', 'Flat 1', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
        130, 20, NULL, 150, $5, $6, 0) RETURNING id`, [customerId, shopId, status, clock.now(), card, quote]);
  const id = String(row?.id);
  await database.pool.query(
    `INSERT INTO order_lines (order_id, position, listing_id, name, base_unit, pack_quantity, count, unit_price, line_total, stock_quantity)
     SELECT $1, 1, sl.id, 'Rice', 'kg', pk.quantity, $3, 10, 10 * $3, $3 * pk.quantity FROM shop_listings sl JOIN packs pk ON pk.id = sl.pack_id WHERE sl.pack_id = $2`, [id, packId, count]);
  return id;
}

const issues = async () => (await database.pool.query("SELECT on_hand::text AS \"onHand\", expected::text, difference::text, resolved_at FROM stock_reconciliation_issues ORDER BY first_found_at, id")).rows;
const movementCount = async () => (await database.pool.query("SELECT count(*)::int AS n FROM stock_movements")).rows[0]?.n as number;

describe("stock reconciliation (#67)", () => {
  it("finds nothing when opening, adjustments, counter sales, a void and delivered orders all agree", async () => {
    const { owner, shopId, pack, send, change, bill } = await shop();
    const packId = await pack("1", "50");
    const customer = await account("customer@example.com");
    await send([change({ packId, reason: "received", quantity: "10" }), change({ packId, reason: "counted", total: "55" })]);
    const sale = bill([{ packId, count: 4, unitPrice: "21" }], { payload: { lines: [{ packId, count: 4, unitPrice: "21" }], total: "84", payment: "cash" } });
    await send([sale]);
    const billId = (await database.pool.query("SELECT id FROM counter_bills WHERE client_id = $1", [sale.id])).rows[0]?.id as string;
    expect((await app.inject({ method: "POST", url: `/v1/me/counter-bills/${billId}/void`, headers: owner.headers, payload: { reason: "wrong_item" } })).statusCode).toBe(201);
    const card = await rateCard();
    const delivered = await order(shopId, customer.id, packId, 3, "delivered", card);
    const client = await database.pool.connect();
    try { await recordDeliverySale(client, delivered, customer.id, clock.now()); } finally { client.release(); }
    // An accepted order only holds stock: reservations are not physical stock, so on-hand and expected both leave them out.
    await order(shopId, customer.id, packId, 5, "accepted", card);
    expect(await reconcileStock(database.pool, clock)).toBe(0);
    expect(await issues()).toEqual([]);
  });

  it("reports a delivered order whose sale was never recorded, and a sale no document explains, without touching stock", async () => {
    const { shopId, pack } = await shop();
    const packId = await pack("1", "50");
    const customer = await account("customer@example.com");
    const card = await rateCard();
    await order(shopId, customer.id, packId, 3, "picked_up", card);
    expect(await reconcileStock(database.pool, clock)).toBe(1);
    expect(await issues()).toEqual([{ onHand: "50.000", expected: "47.000", difference: "3.000", resolved_at: null }]);
    const before = await movementCount();
    // A stray sale of 2 that no bill or order names: on-hand falls to 48 while the documents still expect 47.
    await database.pool.query(
      "INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) SELECT id, $2, gen_random_uuid(), 'sale', -2 FROM shop_listings WHERE shop_id = $1", [shopId, customer.id]);
    clock.set(new Date("2030-01-02T00:00:00.000Z"));
    expect(await reconcileStock(database.pool, clock)).toBe(1);
    expect(await issues()).toMatchObject([{ onHand: "48.000", expected: "47.000", difference: "1.000", resolved_at: null }]);
    expect(await movementCount()).toBe(before + 1);
  });

  it("reports a delivered order revised down, because delivery still deducts the placed quantities (known bug #609)", async () => {
    const { shopId, pack } = await shop();
    const packId = await pack("1", "50");
    const customer = await account("customer@example.com");
    const card = await rateCard();
    const revised = await order(shopId, customer.id, packId, 4, "delivered", card);
    await database.pool.query(
      `WITH r AS (INSERT INTO order_revisions (order_id, revision, status, source_status, actor_role, created_at, confirmed_at, confirm_by_at, product_value, delivery_fee, total, commission, platform_contribution, quote)
         VALUES ($1, 1, 'confirmed', 'placed', 'owner', $2, $2, $2, 20, 20, 40, 2, 3, $3) RETURNING id)
       INSERT INTO order_revision_lines (revision_id, position, listing_id, name, base_unit, pack_quantity, original_count, count, unit_price, line_total, commission, stock_quantity, change_reason)
       SELECT r.id, 1, l.listing_id, 'Rice', 'kg', 1, 4, 2, 10, 20, 2, 2, 'out_of_stock' FROM r, order_lines l WHERE l.order_id = $1`, [revised, clock.now(), quote]);
    const client = await database.pool.connect();
    try { await recordDeliverySale(client, revised, customer.id, clock.now()); } finally { client.release(); }
    // 2 packs went out, but recordDeliverySale deducted the 4 placed (#609). The job must keep reporting this, never hide it.
    // When #609 is fixed this expectation flips to "no issue": on-hand 48.
    expect(await reconcileStock(database.pool, clock)).toBe(1);
    expect(await issues()).toEqual([{ onHand: "46.000", expected: "48.000", difference: "-2.000", resolved_at: null }]);
  });

  it("closes an issue when a later run finds the listing right, and keeps one open row per listing", async () => {
    const { shopId, pack } = await shop();
    await pack("1", "10");
    const who = (await account("who@example.com")).id;
    await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) SELECT id, $2, gen_random_uuid(), 'sale', -4 FROM shop_listings WHERE shop_id = $1", [shopId, who]);
    await reconcileStock(database.pool, clock);
    await reconcileStock(database.pool, clock);
    expect(await issues()).toMatchObject([{ difference: "-4.000", resolved_at: null }]);
    // Giving the 4 back with a void movement makes the figure agree with the documents again.
    await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) SELECT id, $2, gen_random_uuid(), 'void', 4 FROM shop_listings WHERE shop_id = $1", [shopId, who]);
    clock.set(new Date("2030-01-02T00:00:00.000Z"));
    expect(await reconcileStock(database.pool, clock)).toBe(0);
    expect(await issues()).toMatchObject([{ difference: "-4.000", resolved_at: clock.now() }]);
  });

  it("does not call a negative figure a difference: a counter sale is never blocked (BIL-4)", async () => {
    const { pack, send, change, bill } = await shop();
    const packId = await pack("1", "2");
    await send([change({ packId, reason: "damaged", quantity: "-5" })]);
    await send([bill([{ packId, count: 1, unitPrice: "21" }], { payload: { lines: [{ packId, count: 1, unitPrice: "21" }], total: "21", payment: "cash" } })]);
    expect(await reconcileStock(database.pool, clock)).toBe(0);
  });

  it("runs as the reconcile-stock job, records the run and writes no movement", async () => {
    const { shopId, pack } = await shop();
    await pack("1", "10");
    const who = (await account("who@example.com")).id;
    await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) SELECT id, $2, gen_random_uuid(), 'sale', -1 FROM shop_listings WHERE shop_id = $1", [shopId, who]);
    const before = await movementCount();
    await runJob(database, "reconcile-stock", clock);
    expect((await database.pool.query("SELECT job_name, status FROM job_runs")).rows).toEqual([{ job_name: "reconcile-stock", status: "ok" }]);
    expect(await issues()).toHaveLength(1);
    expect(await movementCount()).toBe(before);
  });
});
