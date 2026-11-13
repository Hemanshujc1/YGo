import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { AdminStatementsResponse, OwnerStatementsResponse, ShopBalancesResponse, Statement } from "@ygo/contracts";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { createLocalPushSender } from "../src/adapters/push-sender";
import { connectDatabase } from "../src/db";
import { jobMaxAgeHours, runJob } from "../src/jobs";
import { sendDuePushes } from "../src/notifications";
import { issueStatements } from "../src/statements";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let adminId: string;

// The weeks used here, Monday to Sunday in India (UTC+05:30). Week 1 ends at Sunday 23:59:59 IST, 18:29:59 UTC.
const WEEK1 = "2029-12-31";
const WEEK2 = "2030-01-07";
const WEEK3 = "2030-01-14";
/** Monday 01:00 IST after each week, when the timer runs the job. */
const RUN1 = new Date("2030-01-06T19:30:00.000Z");
const RUN2 = new Date("2030-01-13T19:30:00.000Z");
const RUN3 = new Date("2030-01-20T19:30:00.000Z");
const IN_WEEK1 = "2030-01-02T06:00:00.000Z";
const IN_WEEK2 = "2030-01-09T06:00:00.000Z";

beforeEach(async () => {
  name = `ygo_statements_${randomUUID().replaceAll("-", "")}`;
  database = connectDatabase((await createTestDatabase(name)).href);
  await bootstrapAdmin(database.pool, admin);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  adminId = String((await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [admin.email])).rows[0]?.id);
  await graceDays("global", null, 7);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

/** Publishes a rate card holding only the statement grace period, at global or shop scope. */
async function graceDays(scope: "global" | "shop", shopId: string | null, days: number) {
  const { rows: [card] } = await database.pool.query<{ version: string }>(
    "INSERT INTO rate_card_versions (actor_id, scope_type, scope_id, reason, published_at) VALUES ($1, $2, $3, 'test', $4) RETURNING version", [adminId, scope, shopId, clock.now()]);
  await database.pool.query("INSERT INTO rate_card_values (version, field, integer_value) VALUES ($1, 'statementGraceDays', $2)", [card?.version, days]);
}

async function signIn(email: string, url = "/v1/auth") {
  await app.inject({ method: "POST", url: `${url}/code`, payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
  const verify = await app.inject({ method: "POST", url: `${url}/verify`, payload: { email, code } });
  expect(verify.statusCode).toBe(200);
  return { authorization: `Bearer ${verify.json().accessToken as string}` };
}

const accountId = async (email: string) => String((await database.pool.query<{ id: string }>(
  "INSERT INTO accounts (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id", [email])).rows[0]?.id);

async function shop(shopName: string, owner?: string, staff?: string) {
  const id = String((await database.pool.query<{ id: string }>(
    "INSERT INTO shops (shop_name, address, pincode, created_at) VALUES ($1, 'Paud Road', '411038', $2) RETURNING id", [shopName, clock.now()])).rows[0]?.id);
  if (owner) await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [await accountId(owner), id]);
  if (staff) await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [await accountId(staff), id]);
  return id;
}

const deliveryQuote = (commission: string, contribution: string, smallCartShare: string | null = null) => ({
  status: "priced", rateCardVersion: "1", lines: [], sources: {}, productValue: "130.00", shopDiscount: null, commission,
  deliveryFee: { amount: "20.00", platformShare: "10.00", shopShare: "10.00" },
  smallCartFee: smallCartShare === null ? null : { amount: "15.00", platformShare: smallCartShare, shopShare: "0.00" },
  customerTotal: "150.00", shopKeeps: "117.00", platformContribution: contribution, placeable: true, reasons: [],
});
const pickupQuote = {
  ...deliveryQuote("0.00", "7.50"), deliveryFee: { amount: "0.00", platformShare: "0.00", shopShare: "0.00" },
  pickup: { customerFee: "5.00", shopFee: "2.50", contributionFloor: "5" },
};

/** A YGo-funded coupon at version 1, for an order placed with it. */
async function platformCouponId() {
  const terms = "version, code, funding, form, percentage, status, expires_at, per_customer_limit";
  const values = "1, 'YGO' || substr(md5(random()::text), 1, 6), 'platform', 'percentage', 5, 'off', now(), 1";
  const { rows: [coupon] } = await database.pool.query<{ id: string }>(`INSERT INTO coupons (${terms}, updated_at) VALUES (${values}, now()) RETURNING id`);
  await database.pool.query(`INSERT INTO coupon_versions (coupon_id, ${terms}, created_at) SELECT id, ${terms}, now() FROM coupons WHERE id = $1`, [coupon?.id]);
  return coupon?.id;
}

type Seed = { status?: string; completedAt?: string; pickup?: boolean; quote?: object; platformCoupon?: string };

/** An order completed (or not) at `completedAt`, priced by `quote`: by default ₹13 commission and ₹10 of the delivery fee, owing ₹23. */
async function order(shopId: string, { status = "delivered", completedAt = IN_WEEK1, pickup = false, quote, platformCoupon = "0" }: Seed = {}) {
  const customer = await accountId("customer@example.com");
  const { rows: [row] } = await database.pool.query<{ id: string; number: number }>(
    `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, fulfilment,
        address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, pickup_fee, total, rate_card_version, quote, platform_coupon, coupon_id, coupon_version)
     VALUES ($1, $2, $3, $4, $4, 'Shop', '12 Lane', '411038', $5, $6, $7, $8, ${pickup ? "NULL" : "ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography"},
        130, ${pickup ? "0, 5" : "20, NULL"}, $9, '1', $10, $11, $12, $13)
     RETURNING id, number`,
    [customer, shopId, status, completedAt, pickup ? "pickup" : "delivery", pickup ? null : "home", pickup ? null : "Flat 1", pickup ? null : "411038",
      (pickup ? 135 : 150) - Number(platformCoupon), quote ?? (pickup ? pickupQuote : deliveryQuote("13.00", "23.00")), platformCoupon,
      platformCoupon === "0" ? null : await platformCouponId(), platformCoupon === "0" ? null : 1]);
  return { id: String(row?.id), number: Number(row?.number) };
}

/** A partial acceptance of the order: ₹80 of goods, ₹8 commission; the delivery fee stands, so it owes 8 + 10 = ₹18. */
async function revise(orderId: string, status = "confirmed", commission = "8", contribution = "18") {
  const { rows: [listing] } = await database.pool.query<{ id: string }>(
    `WITH p AS (INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
       SELECT 'Atta ' || gen_random_uuid()::text, id, 'kg', 'measured', true, 'a', 'b', 'c' FROM categories LIMIT 1 RETURNING id),
     k AS (INSERT INTO packs (product_id, quantity) SELECT id, 1 FROM p RETURNING id)
     INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) SELECT o.shop_id, k.id, 80, 80, 90 FROM orders o, k WHERE o.id = $1 RETURNING id`, [orderId]);
  await database.pool.query(
    `WITH r AS (INSERT INTO order_revisions (order_id, revision, status, source_status, actor_role, created_at, confirmed_at, confirm_by_at, product_value, delivery_fee, total, commission, platform_contribution, quote)
       VALUES ($1, (SELECT COALESCE(max(revision), 0) + 1 FROM order_revisions WHERE order_id = $1), $2, 'placed', 'owner', $3, CASE WHEN $2 = 'confirmed' THEN $3::timestamptz END, $3, 80, 20, 100, $4, $5, '{}') RETURNING id)
     INSERT INTO order_revision_lines (revision_id, position, listing_id, name, base_unit, pack_quantity, original_count, count, unit_price, line_total, commission, stock_quantity)
     SELECT r.id, 1, $6, 'Atta', 'kg', 1, 1, 1, 80, 80, $4, 1 FROM r`, [orderId, status, clock.now(), commission, contribution, listing?.id]);
}

const statementsOf = async (shopId: string) => (await database.pool.query<{ id: string; periodStart: string; total: string; orderCount: number; dueOn: string; shopName: string }>(
  `SELECT id, to_char(period_start, 'YYYY-MM-DD') AS "periodStart", total::text, order_count AS "orderCount", to_char(due_on, 'YYYY-MM-DD') AS "dueOn", shop_name AS "shopName"
   FROM statements WHERE shop_id = $1 ORDER BY period_start`, [shopId])).rows;
const linesOf = async (statementId: string) => (await database.pool.query<{ orderId: string; late: boolean; owed: string }>(
  'SELECT order_id AS "orderId", late, owed::text FROM statement_lines WHERE statement_id = $1 ORDER BY order_number', [statementId])).rows;
const weeksDone = async () => (await database.pool.query<{ week: string; count: number }>(
  `SELECT to_char(period_start, 'YYYY-MM-DD') AS week, statement_count AS count FROM statement_weeks ORDER BY period_start`)).rows;

describe("Weekly statements (#629, MNY-8, MNY-12, Q-6)", () => {
  it("charges only delivered and picked-up orders, each at its final price's contribution, and adds up to the paisa", async () => {
    const shopId = await shop("Sai General Stores");
    const delivered = await order(shopId);
    const picked = await order(shopId, { status: "picked_up", pickup: true });
    const couponed = await order(shopId, { quote: deliveryQuote("13.00", "18.00"), platformCoupon: "5.00" });
    const smallCart = await order(shopId, { quote: deliveryQuote("13.37", "38.37", "15.00") });
    const revised = await order(shopId);
    await revise(revised.id, "declined", "1", "11");
    await revise(revised.id);
    const declined = await order(shopId);
    await revise(declined.id, "declined", "1", "11");
    for (const status of ["delivery_failed", "not_collected", "cancelled_by_shop", "rejected_by_shop", "expired", "placed", "out_for_delivery", "arrived"]) {
      await order(shopId, { status, pickup: status === "not_collected" });
    }
    expect(await issueStatements(database.pool, RUN1)).toBe(1);
    const [statement] = await statementsOf(shopId);
    const detail = (await app.inject({ method: "GET", url: `/v1/admin/statements/${statement?.id}`, headers: await signIn(admin.email, "/v1/admin/auth") })).json() as Statement;
    const line = (id: string) => detail.lines.find((l) => l.orderId === id);
    expect(line(delivered.id)).toMatchObject({ fulfilment: "delivery", orderTotal: "150.00", commission: "13.00", feeShare: "10.00", bookingFees: "0.00", platformCoupon: "0.00", owed: "23.00", late: false });
    expect(line(picked.id)).toMatchObject({ fulfilment: "pickup", orderTotal: "135.00", commission: "0.00", feeShare: "0.00", bookingFees: "7.50", owed: "7.50" });
    expect(line(couponed.id)).toMatchObject({ orderTotal: "145.00", commission: "13.00", feeShare: "10.00", platformCoupon: "5.00", owed: "18.00" });
    expect(line(smallCart.id)).toMatchObject({ commission: "13.37", feeShare: "25.00", owed: "38.37" });
    // The latest confirmed revision's commission and total; the declined one is ignored, and the delivery fee stands as quoted.
    expect(line(revised.id)).toMatchObject({ orderTotal: "100.00", commission: "8.00", feeShare: "10.00", owed: "18.00" });
    expect(line(declined.id)).toMatchObject({ commission: "13.00", owed: "23.00" });
    expect(detail.lines).toHaveLength(6);
    expect(detail).toMatchObject({ total: "127.87", orderCount: 6, periodStart: WEEK1, periodEnd: "2030-01-06", shopName: "Sai General Stores", shopAddress: "Paud Road", shopPincode: "411038" });
    expect(detail.lines.reduce((sum, l) => sum + Math.round(Number(l.owed) * 100), 0)).toBe(12787);
  });

  it("puts an order in the Monday–Sunday week of India in which it was completed", async () => {
    const shopId = await shop("S");
    const lastSecond = await order(shopId, { completedAt: "2030-01-06T18:29:59.999Z" });
    const mondayMidnight = await order(shopId, { completedAt: "2030-01-06T18:30:00.000Z" });
    // Sunday 20:00 UTC is already Monday 01:30 in India.
    const sundayUtc = await order(shopId, { completedAt: "2030-01-06T20:00:00.000Z" });
    const firstSecond = await order(shopId, { completedAt: "2029-12-30T18:30:00.000Z" });
    clock.set(new Date("2030-01-06T21:00:00.000Z"));
    await issueStatements(database.pool, RUN1);
    const [week1] = await statementsOf(shopId);
    expect(week1?.periodStart).toBe(WEEK1);
    expect((await linesOf(String(week1?.id))).map((l) => l.orderId).sort()).toEqual([lastSecond.id, firstSecond.id].sort());
    await issueStatements(database.pool, RUN2);
    const [, week2] = await statementsOf(shopId);
    expect(week2?.periodStart).toBe(WEEK2);
    expect((await linesOf(String(week2?.id))).map((l) => l.orderId).sort()).toEqual([mondayMidnight.id, sundayUtc.id].sort());
  });

  it("puts an order that reached the server after its week's statement on the next one, marked late, and never back on the first", async () => {
    const shopId = await shop("S");
    const onTime = await order(shopId);
    await issueStatements(database.pool, RUN1);
    // Delivered offline on Sunday of week 1, synced after Monday's run, and nothing else in week 2.
    const late = await order(shopId, { completedAt: "2030-01-06T16:00:00.000Z" });
    await issueStatements(database.pool, RUN2);
    const [first, second] = await statementsOf(shopId);
    expect(await linesOf(String(first?.id))).toEqual([{ orderId: onTime.id, late: false, owed: "23.00" }]);
    expect(second?.periodStart).toBe(WEEK2);
    expect(await linesOf(String(second?.id))).toEqual([{ orderId: late.id, late: true, owed: "23.00" }]);
    const detail = (await app.inject({ method: "GET", url: `/v1/admin/statements/${second?.id}`, headers: await signIn(admin.email, "/v1/admin/auth") })).json() as Statement;
    expect(detail.lines[0]?.completedAt).toBe("2030-01-06T16:00:00.000Z");
  });

  it("makes no statement for a week with nothing to charge, and records the week as done", async () => {
    const busy = await shop("Busy");
    const quiet = await shop("Quiet");
    await order(busy);
    await order(quiet, { status: "delivery_failed" });
    expect(await issueStatements(database.pool, RUN1)).toBe(1);
    expect(await statementsOf(quiet)).toEqual([]);
    expect(await issueStatements(database.pool, RUN2)).toBe(0);
    expect(await weeksDone()).toEqual([{ week: WEEK1, count: 1 }, { week: WEEK2, count: 0 }]);
  });

  it("makes nothing on a rerun and tells the Owner once; a missed Monday makes each missing week in order", async () => {
    const shopId = await shop("S", "owner@example.com");
    await order(shopId);
    expect(await issueStatements(database.pool, RUN1)).toBe(1);
    expect(await issueStatements(database.pool, new Date(RUN1.getTime() + 3_600_000))).toBe(0);
    const notices = async () => (await database.pool.query<{ count: number; pushes: number }>(
      "SELECT count(*)::int AS count, (SELECT count(*)::int FROM push_queue) AS pushes FROM notifications WHERE kind = 'statement_issued'")).rows[0];
    expect(await notices()).toEqual({ count: 1, pushes: 1 });
    // Week 2's run is missed. An order of week 2 and a late one of week 1 arrive; the next run, after week 3, makes week 2 then week 3.
    await order(shopId, { completedAt: IN_WEEK2 });
    const late = await order(shopId, { completedAt: "2030-01-05T06:00:00.000Z" });
    const week3 = await order(shopId, { completedAt: "2030-01-15T06:00:00.000Z" });
    expect(await issueStatements(database.pool, RUN3)).toBe(2);
    const [, second, third] = await statementsOf(shopId);
    expect([second?.periodStart, third?.periodStart]).toEqual([WEEK2, WEEK3]);
    expect((await linesOf(String(second?.id))).find((l) => l.orderId === late.id)?.late).toBe(true);
    expect(await linesOf(String(third?.id))).toEqual([{ orderId: week3.id, late: false, owed: "23.00" }]);
    expect(await weeksDone()).toEqual([{ week: WEEK1, count: 1 }, { week: WEEK2, count: 1 }, { week: WEEK3, count: 1 }]);
    expect(await notices()).toEqual({ count: 3, pushes: 3 });
  });

  it("makes each statement once when two runs start together", async () => {
    const one = await shop("One");
    const two = await shop("Two");
    for (let i = 0; i < 5; i += 1) { await order(one); await order(two); }
    const made = await Promise.all([issueStatements(database.pool, RUN1), issueStatements(database.pool, RUN1), issueStatements(database.pool, RUN1)]);
    expect(made.sort()).toEqual([0, 0, 2]);
    expect((await database.pool.query("SELECT 1 FROM statements")).rowCount).toBe(2);
    expect((await database.pool.query("SELECT 1 FROM statement_lines")).rowCount).toBe(10);
  });

  it("leaves an order completed while the run reads for the next statement, never on two", async () => {
    const shopId = await shop("S");
    await order(shopId);
    // Hold the run's lock, so the run waits; the order completed meanwhile is in its snapshot only if it committed first.
    const holder = await database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('issue_statements'))");
      const run = issueStatements(database.pool, RUN1);
      // Completed on Sunday, committed while the run waited: the run's snapshot starts after the lock, so it is on week 1's statement once.
      const during = await order(shopId, { completedAt: "2030-01-06T16:00:00.000Z" });
      await holder.query("SELECT pg_advisory_unlock(hashtext('issue_statements'))");
      expect(await run).toBe(1);
      await issueStatements(database.pool, RUN2);
      const lines = (await database.pool.query<{ week: string; late: boolean }>(
        `SELECT to_char(s.period_start, 'YYYY-MM-DD') AS week, l.late FROM statement_lines l JOIN statements s ON s.id = l.statement_id WHERE l.order_id = $1`, [during.id])).rows;
      expect(lines).toEqual([{ week: WEEK1, late: false }]);
    } finally {
      holder.release();
    }
  });

  it("is not stopped by a shop or its orders changing while it runs, and keeps the shop as it read it", async () => {
    const shopId = await shop("S");
    await order(shopId);
    // Just before the run's first statement, another connection changes the shop and the order that statement points to, after its snapshot.
    const other = await database.pool.connect();
    const connect = database.pool.connect.bind(database.pool) as () => Promise<pg.PoolClient>;
    let interfered = false;
    let runs = 0;
    const spy = vi.spyOn(database.pool, "connect").mockImplementation((async () => {
      runs += 1;
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        if (interfered || typeof args[0] !== "string" || !args[0].includes("INSERT INTO statements (")) return query(...args);
        interfered = true;
        return other.query("UPDATE shops SET address = 'Changed' WHERE id = $1", [shopId])
          .then(() => other.query("UPDATE orders SET delivery_photo_key = 'x' WHERE shop_id = $1", [shopId])).then(() => query(...args));
      }) as typeof client.query;
      return client;
    }) as typeof database.pool.connect);
    try {
      expect(await issueStatements(database.pool, RUN1)).toBe(1);
    } finally {
      spy.mockRestore();
      other.release();
    }
    expect(interfered).toBe(true);
    expect(runs).toBe(1);
    expect((await database.pool.query("SELECT shop_address FROM statements")).rows).toEqual([{ shop_address: "Paud Road" }]);
    expect((await database.pool.query("SELECT 1 FROM statement_lines")).rowCount).toBe(1);
  });

  it("sets the due date from the shop's grace period at issue, and keeps the shop's name and address as they were", async () => {
    const own = await shop("Own Card");
    const global = await shop("Global Card");
    await graceDays("shop", own, 3);
    await order(own);
    await order(global);
    await issueStatements(database.pool, RUN1);
    // Issued Monday 7 January in India.
    expect((await statementsOf(own))[0]?.dueOn).toBe("2030-01-10");
    expect((await statementsOf(global))[0]?.dueOn).toBe("2030-01-14");
    await database.pool.query("UPDATE shops SET shop_name = 'Renamed', address = 'Elsewhere' WHERE id = $1", [own]);
    const [statement] = await statementsOf(own);
    expect(statement?.shopName).toBe("Own Card");
    expect((await database.pool.query("SELECT shop_address FROM statements WHERE id = $1", [statement?.id])).rows[0]?.shop_address).toBe("Paud Road");
  });

  it("fails without a grace period, makes nothing, and records the failure", async () => {
    // The latest global card no longer holds a grace period, and the shop has none of its own.
    const { rows: [card] } = await database.pool.query<{ version: string }>(
      "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version", [adminId, clock.now()]);
    await database.pool.query("INSERT INTO rate_card_values (version, field, money_value) VALUES ($1, 'minimumCart', 100)", [card?.version]);
    const shopId = await shop("S");
    await order(shopId);
    clock.set(RUN1);
    await expect(runJob(database, "issue-statements", clock)).rejects.toThrow(/grace period/);
    expect(await statementsOf(shopId)).toEqual([]);
    expect(await weeksDone()).toEqual([]);
    const [run] = (await database.pool.query("SELECT status, error_text FROM job_runs WHERE job_name = 'issue-statements'")).rows;
    expect(run).toEqual({ status: "failed", error_text: "statements failed" });
  });

  it("records a run with how many statements it made, and is watched for staleness", async () => {
    await order(await shop("S"));
    clock.set(RUN1);
    await runJob(database, "issue-statements", clock);
    clock.advance(60_000);
    await runJob(database, "issue-statements", clock);
    const runs = (await database.pool.query("SELECT status, detail FROM job_runs WHERE job_name = 'issue-statements' ORDER BY started_at, id")).rows;
    expect(runs).toEqual([{ status: "ok", detail: "1 statement made" }, { status: "ok", detail: "0 statements made" }]);
    expect(jobMaxAgeHours["issue-statements"]).toBe(192);
  });

  it("never changes a statement once made, and refuses one that does not add up", async () => {
    const shopId = await shop("S");
    const { id: orderId } = await order(shopId);
    await issueStatements(database.pool, RUN1);
    for (const sql of [
      "UPDATE statements SET total = 0", "DELETE FROM statements", "TRUNCATE statements CASCADE",
      "UPDATE statement_lines SET late = true", "DELETE FROM statement_lines", "TRUNCATE statement_lines",
      "UPDATE statement_weeks SET statement_count = 9", "DELETE FROM statement_weeks", "TRUNCATE statement_weeks",
    ]) await expect(database.pool.query(sql), sql).rejects.toThrow(/append-only/);
    const other = await order(shopId, { completedAt: IN_WEEK2 });
    const insert = (total: string, owed: string) => database.pool.query(
      `WITH s AS (INSERT INTO statements (shop_id, period_start, period_end, issued_at, grace_days, due_on, shop_name, order_count, total)
         VALUES ($1, $2, $2::date + 6, $3, 0, ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, 'S', 1, $4) RETURNING id)
       INSERT INTO statement_lines (order_id, statement_id, order_number, completed_at, late, fulfilment, order_total, commission, fee_share, booking_fees, platform_coupon, owed)
       SELECT $5, s.id, 1, $6, false, 'delivery', 150, 13, 10, 0, 0, $7 FROM s`, [shopId, WEEK2, RUN2, total, other.id, IN_WEEK2, owed]);
    await expect(insert("99.00", "23.00")).rejects.toThrow(/does not add up/);
    await expect(insert("22.00", "22.00")).rejects.toThrow(/statement_lines_owed_reconciles/);
    // An order is on one statement only.
    await expect(database.pool.query(
      `WITH s AS (INSERT INTO statements (shop_id, period_start, period_end, issued_at, grace_days, due_on, shop_name, order_count, total)
         VALUES ($1, $2, $2::date + 6, $3, 0, ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, 'S', 1, 23) RETURNING id)
       INSERT INTO statement_lines (order_id, statement_id, order_number, completed_at, late, fulfilment, order_total, commission, fee_share, booking_fees, platform_coupon, owed)
       SELECT $4, s.id, 1, $5, true, 'delivery', 150, 13, 10, 0, 0, 23 FROM s`, [shopId, WEEK2, RUN2, orderId, IN_WEEK1])).rejects.toThrow(/statement_lines_pkey/);
  });
});

describe("Statements and balances on the server routes (#629, S15, A18)", () => {
  it("tells the Owner, not Staff, with the statement to open, and pushes it", async () => {
    const shopId = await shop("Sai General Stores", "owner@example.com", "staff@example.com");
    await order(shopId);
    await issueStatements(database.pool, RUN1);
    clock.set(RUN1);
    const [statement] = await statementsOf(shopId);
    const phone = async (email: string) => ({ ...await signIn(email), "x-ygo-app-name": "shopkeeper", "x-ygo-app-version": "1.0.0" });
    const owner = await phone("owner@example.com");
    const list = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/v1/me/notifications", headers })).json().notifications;
    const [notice] = await list(owner);
    expect(notice).toEqual({
      id: expect.any(String), kind: "statement_issued", title: "Weekly statement ready", orderId: null, statementId: statement?.id, read: false,
      body: "Statement #1001 for 31 Dec – 6 Jan: ₹23, due by 14 Jan 2030.", createdAt: RUN1.toISOString(),
    });
    expect(await list(await phone("staff@example.com"))).toEqual([]);
    expect((await app.inject({ method: "PUT", url: "/v1/me/push-token", headers: owner, payload: { token: "ExponentPushToken[owner]" } })).statusCode).toBe(204);
    const push = createLocalPushSender();
    await sendDuePushes(database.pool, push, clock.now());
    expect(push.sent).toEqual([expect.objectContaining({ to: "ExponentPushToken[owner]", title: "Weekly statement ready", data: { notificationId: notice.id, orderId: null, statementId: statement?.id } })]);
  });

  it("gives the Owner their balance in two parts and their statements a page at a time, newest first", async () => {
    const shopId = await shop("S", "owner@example.com");
    await order(shopId);
    await issueStatements(database.pool, RUN1);
    await order(shopId, { completedAt: IN_WEEK2 });
    await issueStatements(database.pool, RUN2);
    await order(shopId, { completedAt: "2030-01-15T06:00:00.000Z" });
    await issueStatements(database.pool, RUN3);
    await order(shopId, { completedAt: "2030-01-22T06:00:00.000Z", quote: deliveryQuote("2.50", "12.50") });
    clock.set(new Date("2030-01-22T07:00:00.000Z"));
    const owner = await signIn("owner@example.com");
    const first = (await app.inject({ method: "GET", url: "/v1/me/statements?limit=2", headers: owner })).json() as OwnerStatementsResponse;
    expect(first.balance).toEqual({ onStatements: "69.00", thisWeek: "12.50", total: "81.50" });
    expect(first.statements.map((s) => s.periodStart)).toEqual([WEEK3, WEEK2]);
    expect(first.nextBefore).toBe(first.statements[1]?.number);
    const second = (await app.inject({ method: "GET", url: `/v1/me/statements?limit=2&before=${first.nextBefore}`, headers: owner })).json() as OwnerStatementsResponse;
    expect(second.statements.map((s) => s.periodStart)).toEqual([WEEK1]);
    expect(second.nextBefore).toBeNull();
    const detail = await app.inject({ method: "GET", url: `/v1/me/statements/${first.statements[0]?.id}`, headers: owner });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as Statement).lines).toHaveLength(1);
  });

  it("shows a new Owner a zero balance and no statements", async () => {
    await shop("S", "owner@example.com");
    const body = (await app.inject({ method: "GET", url: "/v1/me/statements", headers: await signIn("owner@example.com") })).json();
    expect(body).toEqual({ balance: { onStatements: "0.00", thisWeek: "0.00", total: "0.00" }, statements: [], nextBefore: null });
  });

  it("refuses Staff, another shop's Owner, Area Managers and anyone signed out", async () => {
    const mine = await shop("Mine", "owner@example.com", "staff@example.com");
    await shop("Theirs", "other@example.com");
    await order(mine);
    await issueStatements(database.pool, RUN1);
    const [statement] = await statementsOf(mine);
    clock.set(RUN1);
    const get = async (url: string, headers: Record<string, string> = {}) => (await app.inject({ method: "GET", url, headers })).statusCode;
    const staff = await signIn("staff@example.com");
    expect(await get("/v1/me/statements", staff)).toBe(403);
    expect(await get(`/v1/me/statements/${statement?.id}`, staff)).toBe(403);
    const other = await signIn("other@example.com");
    expect(await get(`/v1/me/statements/${statement?.id}`, other)).toBe(404);
    expect(await get("/v1/me/statements", await signIn("stranger@example.com"))).toBe(404);
    expect(await get("/v1/me/statements")).toBe(401);
    expect(await get(`/v1/admin/statements/${statement?.id}`)).toBe(401);
    // An Owner's phone session is no Admin sign-in.
    expect(await get("/v1/admin/shop-balances", await signIn("owner@example.com"))).toBe(403);
    const manager = await accountId("am@example.com");
    await database.pool.query("UPDATE accounts SET name = 'Ravi Patil' WHERE id = $1", [manager]);
    await database.pool.query("INSERT INTO area_manager_memberships (account_id) VALUES ($1)", [manager]);
    await database.pool.query("UPDATE shops SET area_manager_id = $1", [manager]);
    const am = await signIn("am@example.com", "/v1/admin/auth");
    for (const url of ["/v1/admin/statements", `/v1/admin/statements/${statement?.id}`, "/v1/admin/shop-balances"]) expect(await get(url, am), url).toBe(403);
  });

  it("gives Admin every shop's statements by week, a page at a time, and every shop's balance", async () => {
    const one = await shop("One");
    const two = await shop("Two");
    await shop("Owes nothing");
    await order(one);
    await order(two);
    await order(two);
    await issueStatements(database.pool, RUN1);
    await order(one, { completedAt: IN_WEEK2 });
    await issueStatements(database.pool, RUN2);
    await order(two, { completedAt: "2030-01-15T06:00:00.000Z", pickup: true, status: "picked_up" });
    clock.set(new Date("2030-01-15T07:00:00.000Z"));
    const headers = await signIn(admin.email, "/v1/admin/auth");
    const all = (await app.inject({ method: "GET", url: "/v1/admin/statements?limit=2", headers })).json() as AdminStatementsResponse;
    const rest = (await app.inject({ method: "GET", url: `/v1/admin/statements?limit=2&before=${all.nextBefore}`, headers })).json() as AdminStatementsResponse;
    expect(rest.nextBefore).toBeNull();
    const pages = [...all.statements, ...rest.statements];
    expect(pages.map((s) => s.number)).toEqual([1003, 1002, 1001]);
    expect(pages.map((s) => `${s.shopName} ${s.periodStart}`).sort()).toEqual([`One ${WEEK1}`, `One ${WEEK2}`, `Two ${WEEK1}`]);
    expect(pages[0]).toMatchObject({ shopName: "One", periodStart: WEEK2 });
    const week = (await app.inject({ method: "GET", url: `/v1/admin/statements?week=${WEEK1}`, headers })).json() as AdminStatementsResponse;
    expect(week.statements.map((s) => [s.shopName, s.total]).sort()).toEqual([["One", "23.00"], ["Two", "46.00"]]);
    expect(((await app.inject({ method: "GET", url: "/v1/admin/statements/00000000-0000-4000-8000-000000000000", headers })).statusCode)).toBe(404);
    const balances = (await app.inject({ method: "GET", url: "/v1/admin/shop-balances", headers })).json() as ShopBalancesResponse;
    expect(balances.balances).toEqual([
      { shopId: two, shopName: "Two", onStatements: "46.00", thisWeek: "7.50", total: "53.50" },
      { shopId: one, shopName: "One", onStatements: "46.00", thisWeek: "0.00", total: "46.00" },
    ]);
  });
});
