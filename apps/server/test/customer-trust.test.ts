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
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { authorization: string };

const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signIn(path: string, email: string) {
  const requested = await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  expect(requested.statusCode).toBe(204);
  const signed = await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code: codeFor(email) } });
  expect(signed.statusCode).toBe(200);
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_customer_trust_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Admin", phone: "+919876543210" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signIn("/v1/admin/auth", "admin@example.com");
  await signIn("/v1/auth", "customer@example.com");
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function customerId(email = "customer@example.com") {
  const result = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]);
  return result.rows[0]?.id ?? "";
}

describe("Customer trust controls (#72, TRU-5)", () => {
  it("blocks and unblocks with reasons and writes both audit rows", async () => {
    const id = await customerId();
    const blocked = await app.inject({ method: "POST", url: `/v1/admin/customers/${id}/block`, headers: admin, payload: { reason: "Repeated refusal" } });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ id, blocked: true, blockReason: "Repeated refusal" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM customer_blocks WHERE account_id = $1", [id])).rows[0]?.count).toBe(1);

    const unblocked = await app.inject({ method: "POST", url: `/v1/admin/customers/${id}/unblock`, headers: admin, payload: { reason: "Resolved with customer" } });
    expect(unblocked.statusCode).toBe(204);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM customer_blocks WHERE account_id = $1", [id])).rows[0]?.count).toBe(0);
    expect((await database.pool.query<{ action: string; reason: string }>("SELECT action, reason FROM admin_actions WHERE target_id = $1 ORDER BY created_at", [id])).rows)
      .toEqual([{ action: "customer.block", reason: "Repeated refusal" }, { action: "customer.unblock", reason: "Resolved with customer" }]);
  });

  it("returns the phone state and lists a customer with two recent failures as flagged", async () => {
    const id = await customerId();
    await database.pool.query("UPDATE accounts SET phone = $2, phone_verified = true WHERE id = $1", [id, "+919876543211"]);
    const { rows: [card] } = await database.pool.query<{ version: string }>(
      "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version", [await customerId("admin@example.com"), clock.now()]);
    const shopId = randomUUID();
    await database.pool.query(
      `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
       VALUES ($1, 'live', 'Test Shop', 'Main Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 'Owner', 'proprietorship', 'ABCDE1234F', '11223344556677', '2031-03-31', 'test@upi', now(), now())`, [shopId]);
    await database.pool.query("INSERT INTO accounts (email) SELECT 'aa' || n || '@example.com' FROM generate_series(1, 51) n");
    for (let index = 0; index < 2; index++) {
      await database.pool.query(
        `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, total, rate_card_version, quote, failed_delivery_reason)
         VALUES ($1, $2, 'delivery_failed', $3, $3, 'Test Shop', 'Main Road', '411038', 'home', 'Flat 1', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 100, 0, 100, $4, '{}', $5)`, [id, shopId, clock.now(), card?.version, index === 0 ? 'customer_refused' : 'unreachable']);
      if (index === 0) {
        const one = await app.inject({ method: "GET", url: "/v1/admin/customers?search=customer@example.com", headers: admin });
        expect(one.json().items[0]).toMatchObject({ failedDeliveries: 1, refusals: 1, flagged: false });
      }
    }
    const lookup = await app.inject({ method: "GET", url: "/v1/admin/customers?search=customer@example.com", headers: admin });
    expect(lookup.json().items[0]).toMatchObject({ id, phone: "+919876543211", phoneState: "sms-verified", failedDeliveries: 2, refusals: 1, flagged: true });
    const flagged = await app.inject({ method: "GET", url: "/v1/admin/customers?flagged=true", headers: admin });
    expect(flagged.json().items).toEqual([expect.objectContaining({ id, flagged: true })]);
    clock.advance(31 * 24 * 60 * 60_000);
    admin = await signIn("/v1/admin/auth", "admin@example.com");
    const old = await app.inject({ method: "GET", url: "/v1/admin/customers?search=customer@example.com", headers: admin });
    expect(old.json().items[0]).toMatchObject({ failedDeliveries: 0, flagged: false });
    clock.set(new Date("2030-01-01T00:00:00.000Z"));
    await database.pool.query("INSERT INTO order_status_history (order_id, to_status, actor_id, actor_role, at, reason_code) SELECT id, 'delivery_failed', $2, 'admin', $3, 'admin_forced' FROM orders WHERE account_id = $1", [id, await customerId("admin@example.com"), clock.now()]);
    const forced = await app.inject({ method: "GET", url: "/v1/admin/customers?search=customer@example.com", headers: admin });
    expect(forced.json().items[0]).toMatchObject({ failedDeliveries: 0, flagged: false });
  });

  it("filters and counts before paging Search and Flagged Customers", async () => {
    const actorId = await customerId("admin@example.com");
    const { rows: [card] } = await database.pool.query<{ version: string }>(
      "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'pagination test', $2) RETURNING version", [actorId, clock.now()]);
    const shopId = randomUUID();
    await database.pool.query(
      `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
       VALUES ($1, 'live', 'Page Shop', 'Main Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 'Owner', 'proprietorship', 'ABCDE1234F', '11223344556678', '2031-03-31', 'page@upi', now(), now())`, [shopId]);
    await database.pool.query("INSERT INTO accounts (email) SELECT 'page-' || lpad(n::text, 3, '0') || '@example.com' FROM generate_series(1, 52) n");
    await database.pool.query("INSERT INTO accounts (email) VALUES ('other-flagged@example.com')");
    await database.pool.query(
      `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, total, rate_card_version, quote, failed_delivery_reason)
       SELECT a.id, $1, 'delivery_failed', $2, $2, 'Page Shop', 'Main Road', '411038', 'home', 'Flat 1', '411038',
         ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 100, 0, 100, $3, '{}',
         CASE failure.n WHEN 1 THEN 'customer_refused' ELSE 'unreachable' END
       FROM accounts a CROSS JOIN generate_series(1, 2) failure(n)
       WHERE (a.email LIKE 'page-%' AND a.email <> 'page-052@example.com') OR a.email = 'other-flagged@example.com'`,
      [shopId, clock.now(), card?.version],
    );

    const searchOne = await app.inject({ method: "GET", url: "/v1/admin/customers?search=page-&page=1&pageSize=25", headers: admin });
    expect(searchOne.statusCode).toBe(200);
    expect(searchOne.json().pagination).toEqual({ page: 1, pageSize: 25, totalRecords: 52 });
    expect(searchOne.json().items).toHaveLength(25);
    expect(searchOne.json().items.map((row: { email: string }) => row.email)).toEqual(
      [...searchOne.json().items.map((row: { email: string }) => row.email)].sort(),
    );

    const searchTwo = await app.inject({ method: "GET", url: "/v1/admin/customers?search=page-&page=2&pageSize=25", headers: admin });
    expect(searchTwo.json().pagination).toEqual({ page: 2, pageSize: 25, totalRecords: 52 });
    expect(searchTwo.json().items).toHaveLength(25);
    expect(new Set([...searchOne.json().items, ...searchTwo.json().items].map((row: { id: string }) => row.id)).size).toBe(50);

    const searchLast = await app.inject({ method: "GET", url: "/v1/admin/customers?search=page-&page=99&pageSize=25", headers: admin });
    expect(searchLast.json().pagination).toEqual({ page: 3, pageSize: 25, totalRecords: 52 });
    expect(searchLast.json().items).toHaveLength(2);
    expect(searchLast.json().items.some((row: { email: string; flagged: boolean }) => row.email === "page-052@example.com" && !row.flagged)).toBe(true);
    const searchEmails = [...searchOne.json().items, ...searchTwo.json().items, ...searchLast.json().items].map((row: { email: string }) => row.email);
    expect(new Set(searchEmails).size).toBe(52);
    expect(searchEmails).toEqual([...searchEmails].sort());

    const flagged = await app.inject({ method: "GET", url: "/v1/admin/customers?flagged=true&page=3&pageSize=25", headers: admin });
    expect(flagged.json().pagination).toEqual({ page: 3, pageSize: 25, totalRecords: 52 });
    expect(flagged.json().items).toHaveLength(2);
    expect(flagged.json().items.every((row: { flagged: boolean }) => row.flagged)).toBe(true);
    expect(flagged.json().items.some((row: { email: string }) => row.email === "page-052@example.com")).toBe(false);

    const empty = await app.inject({ method: "GET", url: "/v1/admin/customers?search=missing&page=8&pageSize=25", headers: admin });
    expect(empty.json()).toEqual({ items: [], pagination: { page: 1, pageSize: 25, totalRecords: 0 } });
    expect((await app.inject({ method: "GET", url: "/v1/admin/customers?page=0", headers: admin })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/admin/customers?pageSize=101", headers: admin })).statusCode).toBe(400);
  });

  it("refuses a blocked sign-up with 403", async () => {
    const id = await customerId();
    expect((await app.inject({ method: "POST", url: `/v1/admin/customers/${id}/block`, headers: admin, payload: { reason: "Trust review" } })).statusCode).toBe(200);
    clock.advance(30_000);
    await signIn("/v1/auth", "customer@example.com");
    await database.pool.query("DELETE FROM sessions WHERE account_id = $1", [id]);
    await database.pool.query("DELETE FROM accounts WHERE id = $1", [id]);
    clock.advance(30_000);
    expect((await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "customer@example.com" } })).statusCode).toBe(204);
    const refused = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: "customer@example.com", code: codeFor("customer@example.com") } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: { code: "CUSTOMER_BLOCKED" } });
  });

  it("closes new sign-ups but keeps existing accounts able to sign in", async () => {
    const changed = await app.inject({ method: "PUT", url: "/v1/admin/customer-signups", headers: admin, payload: { enabled: false, reason: "Pilot closed" } });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "new@example.com" } })).statusCode).toBe(204);
    const refused = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: "new@example.com", code: codeFor("new@example.com") } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: { code: "SIGNUPS_CLOSED" } });
    clock.advance(30_000);
    const existing = await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "customer@example.com" } });
    expect(existing.statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: "customer@example.com", code: codeFor("customer@example.com") } })).statusCode).toBe(200);
    expect((await database.pool.query<{ action: string; reason: string }>("SELECT action, reason FROM admin_actions WHERE action = 'customer.signups'", [])).rows)
      .toEqual([{ action: "customer.signups", reason: "Pilot closed" }]);
  });
});
