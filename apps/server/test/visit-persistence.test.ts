import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, expect, inject, it } from "vitest";

const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 2 });
let client: pg.PoolClient;
let shopId: string;
let actorId: string;

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  shopId = randomUUID();
  actorId = randomUUID();
  await client.query(`INSERT INTO shops (id, state, shop_name, address, pincode, location,
    owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
    VALUES ($1, 'submitted', 'Test shop', 'Test address', '560001',
      ST_SetSRID(ST_MakePoint(77.6, 12.9), 4326)::geography,
      'Owner', 'proprietorship', 'ABCDE1234F', '12345678901234', '2030-01-01', 'shop@upi', now(), now())`, [shopId]);
});
afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});
afterAll(() => pool.end());

// Savepoints let each assertion inspect the evidence after a refused write.
async function refused(statement: string, values: unknown[] = [], code = "23514") {
  await client.query("SAVEPOINT refused_write");
  await expect(client.query(statement, values)).rejects.toMatchObject({ code });
  await client.query("ROLLBACK TO SAVEPOINT refused_write");
}
const visitSql = `INSERT INTO shop_visits
  (shop_id, actor_id, visit_date, pan, fssai, owner_phone, owner_email, alarm_permission, tester_opt_in, notes)
  VALUES ($1, $2, $3, true, true, true, true, true, true, $4) RETURNING id, recorded_at`;
const paidSql = `INSERT INTO onboarding_fees (shop_id, actor_id, status, amount, payment_date, reference, reason)
  VALUES ($1, $2, 'paid', $3, $4, $5, $6)`;
async function visit() {
  const saved = (await client.query<{ id: string; recorded_at: Date }>(visitSql, [shopId, actorId, "2020-01-01", null])).rows[0];
  if (!saved) throw new Error("Visit insert returned no row");
  return saved;
}

it("appends repeat visits in eligible states with historical dates and server timestamps", async () => {
  for (const state of ["submitted", "under_review", "approved"]) {
    await client.query("UPDATE shops SET state = $2 WHERE id = $1", [shopId, state]);
    expect((await visit()).recorded_at).toBeInstanceOf(Date);
  }
  expect((await client.query("SELECT count(*)::int AS n FROM shop_visits WHERE shop_id = $1", [shopId])).rows).toEqual([{ n: 3 }]);
  await client.query(visitSql, [shopId, actorId, (await client.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0].today, "n".repeat(500)]);
  await refused(visitSql, [shopId, actorId, "2020-01-01", "n".repeat(501)]);
  await client.query("UPDATE shops SET state = 'draft' WHERE id = $1", [shopId]);
  await refused(visitSql, [shopId, actorId, "2020-01-01", null]);
});

it("refuses future, infinite and invalid calendar dates", async () => {
  for (const date of ["9999-12-31", "infinity", "-infinity", "2025-02-29", "not-a-date"]) {
    await client.query("SAVEPOINT invalid_date");
    await expect(client.query(visitSql, [shopId, actorId, date, null])).rejects.toThrow();
    await client.query("ROLLBACK TO SAVEPOINT invalid_date");
  }
});

it.each(["pan", "fssai", "owner_phone", "owner_email", "alarm_permission", "tester_opt_in"])("requires the %s check", async (column) => {
  const saved = await visit();
  const columns = ["pan", "fssai", "owner_phone", "owner_email", "alarm_permission", "tester_opt_in"];
  for (const value of ["false", "NULL"]) {
    await refused(`INSERT INTO shop_visits (shop_id, actor_id, visit_date, ${columns.join(", ")})
      SELECT shop_id, actor_id, visit_date, ${columns.map((name) => name === column ? value : name).join(", ")}
      FROM shop_visits WHERE id = $1`, [saved.id], value === "NULL" ? "23502" : "23514");
  }
});

it("keeps visit and fee history append-only, including against TRUNCATE", async () => {
  const saved = await visit();
  await client.query("INSERT INTO onboarding_fees (shop_id, actor_id, status, reason) VALUES ($1, $2, 'waived', 'Pilot cohort')", [shopId, actorId]);
  for (const table of ["shop_visits", "onboarding_fees"]) {
    await refused(`UPDATE ${table} SET actor_id = $1 WHERE shop_id = $2`, [randomUUID(), shopId], "P0001");
    await refused(`DELETE FROM ${table} WHERE shop_id = $1`, [shopId], "P0001");
    await refused(`TRUNCATE ${table} CASCADE`, [], "P0001");
  }
  await refused("DELETE FROM shops WHERE id = $1", [shopId], "23503");
  expect((await client.query("SELECT actor_id FROM shop_visits WHERE id = $1", [saved.id])).rows).toEqual([{ actor_id: actorId }]);
});

it("purges photo metadata independently and retains history after actor deletion", async () => {
  await client.query("INSERT INTO accounts (id, email) VALUES ($1, $2)", [actorId, `${actorId}@test.example`]);
  const saved = await visit();
  const photoSql = "INSERT INTO visit_photos (id, visit_id, object_key, latitude, longitude, captured_at) VALUES ($1, $2, $3, $4, $5, $6)";
  for (const [lat, lon] of [[91, 0], [0, -181], ["NaN", 0], [0, "Infinity"], ["-Infinity", 0]]) {
    await refused(photoSql, [randomUUID(), saved.id, randomUUID(), lat, lon, null]);
  }
  await client.query(photoSql, [randomUUID(), saved.id, "visit-photos/test/hash.jpg", -90, 180, null]);
  expect((await client.query("SELECT captured_at FROM visit_photos WHERE visit_id = $1", [saved.id])).rows).toEqual([{ captured_at: null }]);
  await refused(photoSql, [randomUUID(), saved.id, "visit-photos/other/hash.jpg", 0, 0, null], "23505");
  await client.query("DELETE FROM visit_photos WHERE visit_id = $1", [saved.id]);
  await client.query(photoSql, [randomUUID(), saved.id, "visit-photos/test/hash.jpg", 0, 0, "2020:01:01 12:30:00"]);
  await client.query("DELETE FROM accounts WHERE id = $1", [actorId]);
  await client.query("DELETE FROM visit_photos WHERE visit_id = $1", [saved.id]);
  expect((await client.query("SELECT actor_id, visit_date::text FROM shop_visits WHERE id = $1", [saved.id])).rows)
    .toEqual([{ actor_id: actorId, visit_date: "2020-01-01" }]);
});

it("binds disposable uploads to shop, actor, declared size and expiry", async () => {
  const sql = `INSERT INTO visit_photo_uploads (id, shop_id, actor_id, byte_length, expires_at)
    VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`;
  for (const size of [1, 10_000_000]) await client.query(sql, [randomUUID(), shopId, actorId, size]);
  for (const size of [0, -1, 10_000_001]) await refused(sql, [randomUUID(), shopId, actorId, size]);
  expect((await client.query("SELECT actor_id, shop_id, byte_length FROM visit_photo_uploads WHERE shop_id = $1 ORDER BY byte_length", [shopId])).rows)
    .toEqual([1, 10_000_000].map((byte_length) => ({ actor_id: actorId, shop_id: shopId, byte_length })));
  await client.query("DELETE FROM visit_photo_uploads WHERE shop_id = $1", [shopId]);
});

it("keeps SMS independent and clears only the changed contact's visit confirmation", async () => {
  await client.query("INSERT INTO accounts (id, email, phone) VALUES ($1, $2, '+919876543210')", [actorId, `${actorId}@test.example`]);
  const state = async () => (await client.query(`SELECT phone_verified, phone_visit_confirmed_at IS NOT NULL AS phone_confirmed,
    email_visit_confirmed_at IS NOT NULL AS email_confirmed FROM accounts WHERE id = $1`, [actorId])).rows[0];
  expect(await state()).toEqual({ phone_verified: false, phone_confirmed: false, email_confirmed: false });
  await client.query("UPDATE accounts SET phone_visit_confirmed_at = now(), email_visit_confirmed_at = now() WHERE id = $1", [actorId]);
  expect(await state()).toEqual({ phone_verified: false, phone_confirmed: true, email_confirmed: true });
  await client.query("UPDATE accounts SET name = 'Renamed', phone = phone, email = email WHERE id = $1", [actorId]);
  expect(await state()).toEqual({ phone_verified: false, phone_confirmed: true, email_confirmed: true });
  await client.query("UPDATE accounts SET phone = '+919876543211', phone_visit_confirmed_at = now() WHERE id = $1", [actorId]);
  expect(await state()).toEqual({ phone_verified: false, phone_confirmed: false, email_confirmed: true });
  await client.query("UPDATE accounts SET phone_visit_confirmed_at = now(), phone_verified = true WHERE id = $1", [actorId]);
  await client.query("UPDATE accounts SET email = $2, email_visit_confirmed_at = now() WHERE id = $1", [actorId, `${randomUUID()}@test.example`]);
  expect(await state()).toEqual({ phone_verified: true, phone_confirmed: true, email_confirmed: false });
  await client.query("UPDATE accounts SET phone = NULL WHERE id = $1", [actorId]);
  expect((await state()).phone_confirmed).toBe(false);
  await refused("UPDATE accounts SET phone_visit_confirmed_at = now() WHERE id = $1", [actorId]);
});

it("requires a waiver reason and complete paid evidence, appending changes with a reason", async () => {
  await refused("INSERT INTO onboarding_fees (shop_id, actor_id, status) VALUES ($1, $2, 'waived')", [shopId, actorId]);
  await client.query(paidSql, [shopId, actorId, "100.50", "2020-01-01", "receipt-1", null]);
  await refused(paidSql, [shopId, actorId, "200", "2020-01-02", "receipt-2", null]);
  await client.query("INSERT INTO onboarding_fees (shop_id, actor_id, status, reason) VALUES ($1, $2, 'waived', 'Pilot cohort')", [shopId, actorId]);
  await client.query(paidSql, [shopId, actorId, "200", "2020-01-02", "receipt-2", "Corrected settlement"]);
  expect((await client.query("SELECT status, amount::text, reason FROM onboarding_fees WHERE shop_id = $1 ORDER BY amount NULLS FIRST", [shopId])).rows)
    .toEqual([{ status: "waived", amount: null, reason: "Pilot cohort" }, { status: "paid", amount: "100.50", reason: null }, { status: "paid", amount: "200.00", reason: "Corrected settlement" }]);
});

it("rejects invalid and conflicting fee evidence", async () => {
  for (const values of [
    [null, "2020-01-01", "receipt", null], ["0", "2020-01-01", "receipt", null],
    ["-1", "2020-01-01", "receipt", null], ["NaN", "2020-01-01", "receipt", null],
    ["10", null, "receipt", null], ["10", "infinity", "receipt", null],
    ["10", "9999-12-31", "receipt", null], ["10", "2020-01-01", null, null],
    ["10", "2020-01-01", " ", null], ["10", "2020-01-01", "r".repeat(501), null],
    ["10", "2020-01-01", "receipt", " "], ["10", "2020-01-01", "receipt", "r".repeat(501)],
  ]) await refused(paidSql, [shopId, actorId, ...values]);
  await refused("INSERT INTO onboarding_fees (shop_id, actor_id, status, reason) VALUES ($1, $2, 'unknown', 'reason')", [shopId, actorId]);
  await refused("INSERT INTO onboarding_fees (shop_id, actor_id, status, reason, amount) VALUES ($1, $2, 'waived', 'Pilot', 10)", [shopId, actorId]);
});

it("serializes concurrent fee appends before checking the change reason", async () => {
  await client.query("COMMIT");
  const second = await pool.connect();
  try {
    await client.query("BEGIN");
    await second.query("BEGIN");
    await client.query(paidSql, [shopId, actorId, "100", "2020-01-01", "first", null]);
    const pending = expect(second.query(paidSql, [shopId, actorId, "200", "2020-01-02", "second", null]))
      .rejects.toMatchObject({ code: "23514" });
    await client.query("COMMIT");
    await pending;
  } finally {
    await second.query("ROLLBACK");
    second.release();
  }
});
