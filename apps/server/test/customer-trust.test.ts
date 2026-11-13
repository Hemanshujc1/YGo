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
    for (let index = 0; index < 2; index++) {
      await database.pool.query(
        `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, total, rate_card_version, quote, failed_delivery_reason)
         VALUES ($1, $2, 'delivery_failed', $3, $3, 'Test Shop', 'Main Road', '411038', 'home', 'Flat 1', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 100, 0, 100, $4, '{}', 'customer_refused')`, [id, shopId, clock.now(), card?.version]);
    }
    const lookup = await app.inject({ method: "GET", url: "/v1/admin/customers?search=customer@example.com", headers: admin });
    expect(lookup.json().customers[0]).toMatchObject({ id, phone: "+919876543211", phoneState: "sms-verified", failedDeliveries: 2, refusals: 2, flagged: true });
    const flagged = await app.inject({ method: "GET", url: "/v1/admin/customers?flagged=true", headers: admin });
    expect(flagged.json().customers).toEqual([expect.objectContaining({ id, flagged: true })]);
  });

  it("refuses a blocked sign-up with 403", async () => {
    const id = await customerId();
    expect((await app.inject({ method: "POST", url: `/v1/admin/customers/${id}/block`, headers: admin, payload: { reason: "Trust review" } })).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "customer@example.com" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: { code: "CUSTOMER_BLOCKED" } });
  });

  it("closes new sign-ups but keeps existing accounts able to sign in", async () => {
    const changed = await app.inject({ method: "PUT", url: "/v1/admin/customer-signups", headers: admin, payload: { enabled: false, reason: "Pilot closed" } });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "new@example.com" } })).statusCode).toBe(403);
    const existing = await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "customer@example.com" } });
    expect(existing.statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: "customer@example.com", code: codeFor("customer@example.com") } })).statusCode).toBe(200);
    expect((await database.pool.query<{ action: string; reason: string }>("SELECT action, reason FROM admin_actions WHERE action = 'customer.signups'", [])).rows)
      .toEqual([{ action: "customer.signups", reason: "Pilot closed" }]);
  });
});
