import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { TERMINAL_ORDER_STATUSES, OrderStatus, type AdminOrderDetail, type AdminOrdersResponse } from "@ygo/contracts";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { customerFailedDeliveries } from "../src/customer-refusals";
import { connectDatabase } from "../src/db";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let rateCard: string;

beforeEach(async () => {
  name = `ygo_admin_orders_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, admin);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  const { rows: [actor] } = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [admin.email]);
  const { rows: [card] } = await database.pool.query<{ version: string }>(
    "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version",
    [actor?.id, clock.now()],
  );
  rateCard = String(card?.version);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try {
    await root.connect();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally {
    await root.end();
  }
});

async function signIn(email: string, url = "/v1/admin/auth") {
  expect((await app.inject({ method: "POST", url: `${url}/code`, payload: { email } })).statusCode).toBe(204);
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
  const verify = await app.inject({ method: "POST", url: `${url}/verify`, payload: { email, code } });
  expect(verify.statusCode).toBe(200);
  return { authorization: `Bearer ${verify.json().accessToken as string}` };
}

const account = async (email: string, accountName: string | null = null) =>
  String((await database.pool.query<{ id: string }>("INSERT INTO accounts (email, name) VALUES ($1, $2) RETURNING id", [email, accountName])).rows[0]?.id);

const manager = async (email: string, managerName = "Ravi Patil") => {
  const id = await account(email, managerName);
  await database.pool.query("INSERT INTO area_manager_memberships (account_id) VALUES ($1)", [id]);
  return id;
};

const shop = async (shopName: string, areaManagerId: string | null = null) =>
  String((await database.pool.query<{ id: string }>(
    "INSERT INTO shops (shop_name, created_at, area_manager_id) VALUES ($1, $2, $3) RETURNING id", [shopName, clock.now(), areaManagerId])).rows[0]?.id);

const quote = {
  status: "priced", rateCardVersion: "1", lines: [], sources: {}, productValue: "130.00", shopDiscount: null, commission: "13.00",
  deliveryFee: { amount: "20.00", platformShare: "10.00", shopShare: "10.00" }, smallCartFee: null, customerTotal: "150.00",
  shopKeeps: "117.00", platformContribution: "23.00", placeable: true, reasons: [],
};

type Seed = { shopId: string; customerId: string; status?: string; placedAt?: string; changedAt?: string; fulfilment?: "delivery" | "pickup" };

async function createOrder({ shopId, customerId, status = "placed", placedAt = "2030-01-01T00:00:00.000Z", changedAt = placedAt, fulfilment = "delivery" }: Seed) {
  const delivery = fulfilment === "delivery";
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, fulfilment,
        address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, pickup_fee, total, rate_card_version, quote)
     VALUES ($1, $2, $3, $4, $5, 'Shop', '12 Lane', '411038', $6, $7, $8, $9, ${delivery ? "ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography" : "NULL"},
        130, ${delivery ? "20, NULL" : "0, 5"}, 150, $10, $11)
     RETURNING id`,
    [customerId, shopId, status, placedAt, changedAt, fulfilment, delivery ? "home" : null, delivery ? "Flat 1" : null, delivery ? "411038" : null, rateCard, quote],
  );
  const id = String(row?.id);
  const { rows: [item] } = await database.pool.query<{ id: string }>(
    `WITH p AS (INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
       SELECT 'Atta ' || gen_random_uuid()::text, id, 'kg', 'measured', true, 'p/256.webp', 'p/512.webp', 'p/1024.webp' FROM categories LIMIT 1 RETURNING id),
     k AS (INSERT INTO packs (product_id, quantity) SELECT id, 1 FROM p RETURNING id)
     INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) SELECT $1, id, 130, 130, 140 FROM k RETURNING id`, [shopId]);
  await database.pool.query(
    `INSERT INTO order_lines (order_id, position, listing_id, name, base_unit, pack_quantity, count, unit_price, line_total, stock_quantity)
     VALUES ($1, 1, $2, 'Atta', 'kg', 1, 1, 130, 130, 1)`, [id, item?.id]);
  return id;
}

const get = async (headers: Record<string, string>, url: string) => await app.inject({ method: "GET", url, headers });
const force = async (headers: Record<string, string>, id: string, payload: object) =>
  await app.inject({ method: "POST", url: `/v1/admin/orders/${id}/force-transition`, headers, payload });
const orders = async (headers: Record<string, string>, query = "") => await get(headers, `/v1/admin/orders${query}`);
const statusOf = async (id: string) => (await database.pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])).rows[0]?.status;

/** Every move Admin may force, written out: it is the allowlist's whole reach (ADM-4, ORD-1). */
const ALLOWED: Record<string, string[]> = {
  placed: ["rejected_by_shop", "expired", "cancelled_by_shop"],
  accepted: ["cancelled_by_shop"],
  preparing: ["cancelled_by_shop"],
  ready: ["cancelled_by_shop"],
  arrived: ["delivery_failed"],
};
const TARGETS = ["rejected_by_shop", "expired", "cancelled_by_shop", "not_collected", "delivery_failed"];

describe("Admin orders: monitoring and forced transitions (ADM-4, ADM-7, ORD-1, #66)", () => {
  it("refuses a request with no sign-in, and an Area Manager's force", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const am = await manager("am@example.com");
    const id = await createOrder({ shopId: await shop("Mine", am), customerId });
    expect((await app.inject({ method: "GET", url: "/v1/admin/orders" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/admin/orders/${id}/force-transition`, payload: { from: "placed", to: "expired", reason: "x" } })).statusCode).toBe(401);
    const amHeaders = await signIn("am@example.com");
    expect((await force(amHeaders, id, { from: "placed", to: "expired", reason: "x" })).statusCode).toBe(403);
    expect(await statusOf(id)).toBe("placed");
  });

  it("scopes an Area Manager to the shops assigned to them, on the list, the counts and the detail", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const amA = await manager("a@example.com");
    const mine = await createOrder({ shopId: await shop("A", amA), customerId });
    const theirs = await createOrder({ shopId: await shop("B", await manager("b@example.com")), customerId });
    const loose = await createOrder({ shopId: await shop("C"), customerId });
    const a = await signIn("a@example.com");
    const body = (await orders(a)).json() as AdminOrdersResponse;
    expect(body.orders.map((o) => o.id)).toEqual([mine]);
    expect(body.counts.active).toBe(1);
    expect(((await orders(await signIn(admin.email))).json() as AdminOrdersResponse).orders).toHaveLength(3);
    expect((await get(a, `/v1/admin/orders/${theirs}`)).statusCode).toBe(404);
    expect((await get(a, `/v1/admin/orders/${loose}`)).statusCode).toBe(404);
    const detail = (await get(a, `/v1/admin/orders/${mine}`)).json() as AdminOrderDetail;
    expect(detail.forcedMoves).toEqual([]);
  });

  it("allows exactly the allowlisted moves and refuses every other, for every status", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const shopId = await shop("S");
    const headers = await signIn(admin.email);
    for (const status of OrderStatus.options) {
      for (const to of TARGETS) {
        // Not collected is tried on a pickup, the only order it can close; the delivery case is checked below.
        const id = await createOrder({ shopId, customerId, status, fulfilment: to === "not_collected" ? "pickup" : "delivery" });
        const res = await force(headers, id, { from: status, to, reason: "  Shop unreachable  " });
        const allowed = ALLOWED[status]?.includes(to) || (status === "ready" && to === "not_collected");
        if (allowed) expect([status, to, res.statusCode]).toEqual([status, to, 200]);
        else expect([status, to, res.statusCode, res.body]).toEqual([status, to, 409, expect.stringContaining("ORDER_MOVE_NOT_ALLOWED")]);
        expect(await statusOf(id)).toBe(allowed ? to : status);
      }
    }
    // A pickup that is ready can be closed as not collected; a delivery cannot.
    const pickup = await createOrder({ shopId, customerId, status: "ready", fulfilment: "pickup" });
    expect((await force(headers, pickup, { from: "ready", to: "not_collected", reason: "Nobody came" })).statusCode).toBe(200);
    const delivery = await createOrder({ shopId, customerId, status: "ready" });
    expect((await force(headers, delivery, { from: "ready", to: "not_collected", reason: "Nobody came" })).json().error.code).toBe("ORDER_MOVE_NOT_ALLOWED");
  });

  it("offers no move for a final order and for a status outside the allowlist, and never a forward move", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const shopId = await shop("S");
    const headers = await signIn(admin.email);
    for (const status of OrderStatus.options) {
      const id = await createOrder({ shopId, customerId, status });
      const detail = (await get(headers, `/v1/admin/orders/${id}`)).json() as AdminOrderDetail;
      expect([status, detail.forcedMoves]).toEqual([status, ALLOWED[status] ?? []]);
      if (TERMINAL_ORDER_STATUSES.includes(status as never)) expect(detail.forcedMoves).toEqual([]);
    }
    const pickup = await createOrder({ shopId, customerId, status: "ready", fulfilment: "pickup" });
    expect(((await get(headers, `/v1/admin/orders/${pickup}`)).json() as AdminOrderDetail).forcedMoves).toEqual(["cancelled_by_shop", "not_collected"]);
  });

  it("validates the body: a trimmed reason of 1 to 500 characters, the status shown, and a move Admin can name", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId });
    const headers = await signIn(admin.email);
    for (const payload of [
      { from: "placed", to: "expired", reason: "" }, { from: "placed", to: "expired", reason: "   " }, { from: "placed", to: "expired", reason: "x".repeat(501) },
      { from: "placed", to: "expired" }, { from: "placed", to: "delivered", reason: "x" }, { from: "placed", to: "accepted", reason: "x" },
      { to: "expired", reason: "x" }, { from: "placed", to: "expired", reason: "x", extra: 1 },
    ]) expect([payload, (await force(headers, id, payload)).statusCode]).toEqual([payload, 400]);
    expect((await force(headers, id, { from: "placed", to: "expired", reason: "x".repeat(500) })).statusCode).toBe(200);
    expect((await force(headers, randomUUID(), { from: "placed", to: "expired", reason: "x" })).statusCode).toBe(404);
  });

  it("answers ORDER_STATUS_CHANGED, and changes nothing, when the order moved since A15 loaded", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId, status: "accepted" });
    const res = await force(await signIn(admin.email), id, { from: "placed", to: "expired", reason: "Stuck" });
    expect([res.statusCode, res.json().error.code]).toEqual([409, "ORDER_STATUS_CHANGED"]);
    expect(await statusOf(id)).toBe("accepted");
    expect((await database.pool.query("SELECT 1 FROM admin_actions WHERE action = 'order.force_transition'")).rowCount).toBe(0);
    expect((await database.pool.query("SELECT 1 FROM order_status_history WHERE order_id = $1", [id])).rowCount).toBe(0);
  });

  it("records Admin, from, to and the trimmed reason in the audit and the history, notifies the customer, and freezes the money", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId, status: "accepted" });
    const before = (await database.pool.query("SELECT product_value, delivery_fee, total, quote, rate_card_version, placed_at FROM orders WHERE id = $1", [id])).rows[0];
    const lines = (await database.pool.query("SELECT * FROM order_lines WHERE order_id = $1", [id])).rows;
    const { rows: [actor] } = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [admin.email]);
    clock.set(new Date("2030-01-01T00:10:00.000Z"));
    const headers = await signIn(admin.email);
    const res = await force(headers, id, { from: "accepted", to: "cancelled_by_shop", reason: "  Shop closed for the day  " });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as AdminOrderDetail;
    expect(detail.order.status).toBe("cancelled_by_shop");
    expect(detail.forcedMoves).toEqual([]);
    expect(detail.timeline.at(-1)).toMatchObject({ from: "accepted", to: "cancelled_by_shop", actorRole: "admin", actorName: admin.name, reasonCode: "admin_forced" });
    const audit = await database.pool.query("SELECT actor_id, target_id, target_type, reason, from_status, to_status FROM admin_actions WHERE action = 'order.force_transition'");
    expect(audit.rows).toEqual([{ actor_id: actor?.id, target_id: id, target_type: "order", reason: "Shop closed for the day", from_status: "accepted", to_status: "cancelled_by_shop" }]);
    const history = await database.pool.query("SELECT from_status, to_status, actor_id, actor_role, reason_code FROM order_status_history WHERE order_id = $1", [id]);
    expect(history.rows).toEqual([{ from_status: "accepted", to_status: "cancelled_by_shop", actor_id: actor?.id, actor_role: "admin", reason_code: "admin_forced" }]);
    const note = await database.pool.query("SELECT account_id, app, kind, body FROM notifications WHERE order_id = $1", [id]);
    expect(note.rows).toEqual([{ account_id: customerId, app: "customer", kind: "order_cancelled_by_shop", body: expect.not.stringContaining("closed for the day") }]);
    expect((await database.pool.query("SELECT 1 FROM push_queue")).rowCount).toBe(1);
    expect((await database.pool.query("SELECT product_value, delivery_fee, total, quote, rate_card_version, placed_at FROM orders WHERE id = $1", [id])).rows[0]).toEqual(before);
    expect((await database.pool.query("SELECT * FROM order_lines WHERE order_id = $1", [id])).rows).toEqual(lines);
    // A final status stays locked: a second force is refused.
    const again = await force(headers, id, { from: "cancelled_by_shop", to: "expired", reason: "again" });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "ORDER_MOVE_NOT_ALLOWED"]);
  });

  it.each([
    ["placed", "expired", "order_expired", "Order #", "YGo closed this order because it was not answered in time. You were not charged."],
    ["placed", "rejected_by_shop", "order_rejected", "Order #", "YGo closed this order because it could not be taken. You were not charged."],
    ["arrived", "delivery_failed", "order_delivery_failed", "Order #", "YGo closed this order because it could not be delivered. Contact YGo support if you have questions."],
    ["ready", "cancelled_by_shop", "order_cancelled_by_shop", "Order #", "YGo cancelled this order. You were not charged."],
  ])("tells the customer in YGo's voice, not the shop's and without the Admin's reason, when Admin forces %s to %s", async (from, to, kind, _title, body) => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("Fresh Mart"), customerId, status: from });
    const res = await force(await signIn(admin.email), id, { from, to, reason: "Private note about the shop" });
    expect(res.statusCode).toBe(200);
    const notes = await database.pool.query("SELECT account_id, app, kind, title, body FROM notifications WHERE order_id = $1", [id]);
    expect(notes.rows).toEqual([{ account_id: customerId, app: "customer", kind, title: expect.stringContaining("#"), body }]);
    expect(notes.rows[0].body).not.toContain("Fresh Mart");
    expect(notes.rows[0].body).not.toContain("Private note");
    expect((await database.pool.query("SELECT 1 FROM push_queue")).rowCount).toBe(1);
  });

  it("leaves the customer's own order views working after Admin rejects an order, with no shop reason to show", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId });
    expect((await force(await signIn(admin.email), id, { from: "placed", to: "rejected_by_shop", reason: "Shop unreachable" })).statusCode).toBe(200);
    const customer = await signIn("cust@example.com", "/v1/auth");
    const one = await get(customer, `/v1/orders/${id}`);
    expect([one.statusCode, one.json().status, one.json().rejectReason]).toEqual([200, "rejected_by_shop", null]);
    expect((await get(customer, "/v1/orders")).statusCode).toBe(200);
  });

  it("does not count an Admin-forced delivery failure against the customer's failed deliveries (TRU-5)", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const shopId = await shop("S");
    await createOrder({ shopId, customerId, status: "delivery_failed" });
    const forced = await createOrder({ shopId, customerId, status: "arrived" });
    expect((await force(await signIn(admin.email), forced, { from: "arrived", to: "delivery_failed", reason: "Deliverer's phone died" })).statusCode).toBe(200);
    expect(await statusOf(forced)).toBe("delivery_failed");
    expect(await customerFailedDeliveries(database.pool, customerId, clock.now())).toEqual({ failed: 1, refused: 0 });
  });

  it("shows the confirmed revised total and product value, as the customer sees them", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId, status: "accepted" });
    await database.pool.query(
      `WITH r AS (INSERT INTO order_revisions (order_id, revision, status, source_status, actor_role, created_at, confirmed_at, confirm_by_at, product_value, delivery_fee, total, commission, platform_contribution, quote)
         VALUES ($1, 1, 'confirmed', 'placed', 'owner', $2, $2, $2, 80, 20, 100, 8, 12, $3) RETURNING id)
       INSERT INTO order_revision_lines (revision_id, position, listing_id, name, base_unit, pack_quantity, original_count, count, unit_price, line_total, commission, stock_quantity)
       SELECT r.id, 1, l.listing_id, 'Atta', 'kg', 1, 1, 1, 80, 80, 8, 1 FROM r, order_lines l WHERE l.order_id = $1`, [id, clock.now(), quote]);
    const headers = await signIn(admin.email);
    const detail = (await get(headers, `/v1/admin/orders/${id}`)).json() as AdminOrderDetail;
    expect([detail.order.total, detail.money.total, detail.money.productValue]).toEqual(["100.00", "100.00", "80.00"]);
    const list = (await orders(headers)).json() as AdminOrdersResponse;
    expect(list.orders[0]?.total).toBe("100.00");
  });

  it("keeps the Admin's original reason retrievable on the order detail, for Admin only", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const managerId = await manager("rm@example.com");
    const id = await createOrder({ shopId: await shop("S", managerId), customerId, status: "placed" });
    const headers = await signIn(admin.email);
    expect((await force(headers, id, { from: "placed", to: "expired", reason: "  Shop phone is off  " })).statusCode).toBe(200);
    const detail = (await get(headers, `/v1/admin/orders/${id}`)).json() as AdminOrderDetail;
    expect(detail.forcedActions).toEqual([{ at: expect.any(String), adminName: admin.name, from: "placed", to: "expired", reason: "Shop phone is off" }]);
    const managerHeaders = await signIn("rm@example.com");
    const seen = await get(managerHeaders, `/v1/admin/orders/${id}`);
    expect(seen.statusCode).toBe(200);
    expect((seen.json() as AdminOrderDetail).forcedActions).toEqual([]);
  });

  it("serves an older order whose stored quote is not in today's shape, with no breakdown", async () => {
    const customerId = await account("cust@example.com", null);
    const id = await createOrder({ shopId: await shop("S"), customerId });
    await database.pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
    await database.pool.query("UPDATE orders SET quote = '{\"rateCardVersion\": \"1\"}'::jsonb WHERE id = $1", [id]);
    await database.pool.query("ALTER TABLE orders ENABLE TRIGGER USER");
    const res = await get(await signIn(admin.email), `/v1/admin/orders/${id}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json() as AdminOrderDetail;
    expect(detail.breakdown).toBeNull();
    expect(detail.order.customerName).toBeNull();
    expect(detail.people.delivererName).toBeNull();
    expect(detail.money.total).toBe("150.00");
  });

  it("rolls the status, history and notification back when the audit record cannot be written", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const id = await createOrder({ shopId: await shop("S"), customerId });
    await database.pool.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
    await database.pool.query("CREATE TRIGGER fail_audit BEFORE INSERT ON admin_actions FOR EACH ROW WHEN (NEW.action = 'order.force_transition') EXECUTE FUNCTION fail_audit()");
    const res = await force(await signIn(admin.email), id, { from: "placed", to: "expired", reason: "Stuck" });
    expect(res.statusCode).toBe(500);
    expect(await statusOf(id)).toBe("placed");
    for (const table of ["order_status_history", "notifications", "push_queue"]) {
      expect([table, (await database.pool.query(`SELECT 1 FROM ${table}`)).rowCount]).toEqual([table, 0]);
    }
  });

  it("lists orders unanswered at the re-alert time by the server's clock (ADM-7, #57)", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const shopId = await shop("S");
    const at = (seconds: number) => new Date(clock.now().getTime() - seconds * 1000).toISOString();
    const waiting119 = await createOrder({ shopId, customerId, changedAt: at(119) });
    const waiting120 = await createOrder({ shopId, customerId, changedAt: at(120), placedAt: at(121) });
    const accepted = await createOrder({ shopId, customerId, status: "accepted", changedAt: at(900), placedAt: at(901) });
    const headers = await signIn(admin.email);
    const body = (await orders(headers, "?group=unanswered")).json() as AdminOrdersResponse;
    expect(body.orders.map((o) => o.id)).toEqual([waiting120]);
    expect(body.orders[0]).toMatchObject({ unanswered: true, statusAgeSeconds: 120 });
    expect(body).toMatchObject({ counts: { active: 3, unanswered: 1 }, serverTime: clock.now().toISOString(), unansweredAfterSeconds: 120 });
    const all = ((await orders(headers, "?group=all")).json() as AdminOrdersResponse).orders;
    expect(all.find((o) => o.id === waiting119)?.unanswered).toBe(false);
    expect(all.find((o) => o.id === accepted)?.unanswered).toBe(false);
    // Polling: a later request reads the moved clock, and a forced move drops the order from the list.
    clock.set(new Date(clock.now().getTime() + 1000));
    const later = (await orders(headers, "?group=unanswered")).json() as AdminOrdersResponse;
    expect(later.orders.map((o) => o.id).sort()).toEqual([waiting119, waiting120].sort());
    expect((await force(headers, waiting120, { from: "placed", to: "expired", reason: "No answer" })).statusCode).toBe(200);
    const after = (await orders(headers, "?group=unanswered")).json() as AdminOrdersResponse;
    expect([after.orders.map((o) => o.id), after.counts]).toEqual([[waiting119], { active: 2, unanswered: 1 }]);
  });

  it("filters by group and shop", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const one = await shop("One");
    const two = await shop("Two");
    const live = await createOrder({ shopId: one, customerId, status: "preparing" });
    const done = await createOrder({ shopId: one, customerId, status: "delivered" });
    const other = await createOrder({ shopId: two, customerId, status: "accepted" });
    const headers = await signIn(admin.email);
    const ids = async (query: string) => ((await orders(headers, query)).json() as AdminOrdersResponse).orders.map((o) => o.id).sort();
    expect(await ids("")).toEqual([live, other].sort());
    expect(await ids("?group=final")).toEqual([done]);
    expect(await ids("?group=all")).toEqual([live, done, other].sort());
    expect(await ids(`?group=all&shopId=${two}`)).toEqual([other]);
    expect((await orders(headers, "?group=nope")).statusCode).toBe(400);
    expect((await orders(headers, "?cursor=bad")).statusCode).toBe(400);
  });

  it("pages with a stable cursor over equal placement times, and a status change between pages moves nothing", async () => {
    const customerId = await account("cust@example.com", "Meera");
    const shopId = await shop("S");
    const same = "2030-01-01T00:00:00.000Z";
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push(await createOrder({ shopId, customerId, placedAt: same }));
    made.push(await createOrder({ shopId, customerId, placedAt: "2030-01-01T00:00:01.000Z" }));
    const headers = await signIn(admin.email);
    const first = (await orders(headers, "?limit=2")).json() as AdminOrdersResponse;
    expect(first.orders).toHaveLength(2);
    expect(first.orders[0]?.id).toBe(made[5]);
    // Between pages: the order the first page ended on changes status, and a new one is placed.
    await force(headers, first.orders[1]?.id as string, { from: "placed", to: "expired", reason: "Stuck" });
    await createOrder({ shopId, customerId, placedAt: "2030-01-01T00:00:02.000Z" });
    const seen = [...first.orders.map((o) => o.id)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = (await orders(headers, `?group=all&limit=2&cursor=${encodeURIComponent(cursor)}`)).json() as AdminOrdersResponse;
      seen.push(...page.orders.map((o) => o.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(made.sort());
  });
});
