import { randomUUID } from "node:crypto";
import pg from "pg";
import { AGREEMENT_VERSION } from "@ygo/contracts";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
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
let adminId: string;

/** The sign-in code last mailed to `email`. */
const codeFor = (email: string) => mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];

async function signInAdminWeb(email: string) {
  await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email } });
  const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email, code: codeFor(email) } });
  return { authorization: `Bearer ${signed.json().accessToken as string}` };
}

beforeEach(async () => {
  name = `ygo_live_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signInAdminWeb(adminEmail);
  adminId = (await app.inject({ method: "GET", url: "/v1/admin/me", headers: admin })).json().id as string;
  const area = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Kothrud') RETURNING id");
  await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1)", [area.rows[0]?.id]);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

/** A sent shop in `state`, its Owner signed in with a name and phone. */
async function shop(state = "approved", email = "owner@example.com") {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code: codeFor(email) } })).json();
  const headers = { authorization: `Bearer ${signed.accessToken as string}` };
  await app.inject({ method: "PUT", url: "/v1/me/profile", headers, payload: { name: "Asha Kulkarni", phone: "+919876543210" } });
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2031-03-31', 'asha@upi', now(), now())`, [shopId, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [signed.account.id, shopId]);
  return { id: signed.account.id as string, headers, shopId };
}

/** A visit with its photo, confirming the Owner's phone and email, as the visit route records it (#42). */
async function visit(shopId: string, ownerId: string) {
  const inserted = await database.pool.query<{ id: string }>(
    `INSERT INTO shop_visits (shop_id, actor_id, visit_date, pan, fssai, owner_phone, owner_email, alarm_permission, tester_opt_in)
     VALUES ($1, $2, '2026-01-01', true, true, true, true, true, true) RETURNING id`, [shopId, adminId]);
  await database.pool.query("INSERT INTO visit_photos (id, visit_id, object_key, latitude, longitude) VALUES ($1, $2, $3, 18.5, 73.8)",
    [randomUUID(), inserted.rows[0]?.id, `visits/${randomUUID()}.jpg`]);
  await database.pool.query("UPDATE accounts SET phone_visit_confirmed_at = now(), email_visit_confirmed_at = now() WHERE id = $1", [ownerId]);
}

async function publish(values: object): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope: { type: "global" }, values, reason: "Pilot card" } });
  expect(response.statusCode).toBe(201);
  return response.json().version as string;
}

const card = {
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};

const url = (shopId: string, path: string) => `/v1/admin/shop-applications/${shopId}/${path}`;
const check = (shopId: string, headers: Record<string, string> = admin) => app.inject({ method: "GET", url: url(shopId, "live-check"), headers });
const goLive = (shopId: string, headers: Record<string, string> = admin) => app.inject({ method: "POST", url: url(shopId, "go-live"), headers });
const accept = (headers: Record<string, string>, rateCardVersion: string) =>
  app.inject({ method: "POST", url: "/v1/me/shop-agreement", headers, payload: { agreementVersion: AGREEMENT_VERSION, rateCardVersion } });
// Monday, 9:00 AM – 9:00 PM (#371).
const hours = (headers: Record<string, string>) =>
  app.inject({ method: "PUT", url: "/v1/me/shop-hours", headers, payload: { ranges: [{ weekday: 1, opens: 540, closes: 1260 }] } });
const blockers = async (shopId: string) => (await check(shopId)).json().blockers as string[];

describe("Move to Live (#363, ONB-2, ADM-12)", () => {
  it("names each blocker as it clears, then moves the shop to Live with its fixed reason", async () => {
    const owner = await shop();
    expect((await check(owner.shopId)).json()).toEqual({
      blockers: ["visit", "owner_phone", "owner_email", "fee", "rate_card", "hours", "agreement"],
      rateCardMissing: ["commission", "deliveryFee", "deliveredContributionFloor", "minimumCart", "statementGraceDays"],
    });
    // The Owner's S14 reads the same list while Approved.
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-application", headers: owner.headers })).json().liveCheck.blockers)
      .toEqual(await blockers(owner.shopId));
    const refused = await goLive(owner.shopId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({ code: "SHOP_NOT_READY", liveCheck: (await check(owner.shopId)).json() });

    await visit(owner.shopId, owner.id);
    expect(await blockers(owner.shopId)).toEqual(["fee", "rate_card", "hours", "agreement"]);
    await database.pool.query("INSERT INTO onboarding_fees (shop_id, actor_id, status, reason) VALUES ($1, $2, 'waived', 'Pilot shop')", [owner.shopId, adminId]);
    expect(await blockers(owner.shopId)).toEqual(["rate_card", "hours", "agreement"]);
    expect((await hours(owner.headers)).statusCode).toBe(200);
    expect(await blockers(owner.shopId)).toEqual(["rate_card", "agreement"]);
    const partial = await publish({ ...card, statementGraceDays: undefined });
    expect((await check(owner.shopId)).json()).toEqual({ blockers: ["rate_card", "agreement"], rateCardMissing: ["statementGraceDays"] });
    expect((await accept(owner.headers, partial)).json().error.code).toBe("RATE_CARD_INCOMPLETE");
    const version = await publish(card);
    expect((await check(owner.shopId)).json()).toEqual({ blockers: ["agreement"], rateCardMissing: [] });
    expect((await accept(owner.headers, version)).statusCode).toBe(200);
    expect((await check(owner.shopId)).json()).toEqual({ blockers: [], rateCardMissing: [] });

    const moved = await goLive(owner.shopId);
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: owner.shopId, state: "live" });
    const actions = await database.pool.query("SELECT actor_id, action, reason FROM admin_actions WHERE target_id = $1", [owner.shopId]);
    expect(actions.rows).toEqual([{ actor_id: adminId, action: "shop.go_live", reason: "Moved to Live" }]);
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-application", headers: owner.headers })).json())
      .toMatchObject({ application: { state: "live" }, liveCheck: null });
    // Live is reached once: a second move, a check and a new visit are refused.
    expect((await goLive(owner.shopId)).json().error.code).toBe("SHOP_STATE_CHANGE_REFUSED");
    expect((await check(owner.shopId)).json().error.code).toBe("SHOP_STATE_CHANGE_REFUSED");
    await expect(visit(owner.shopId, owner.id)).rejects.toThrow(/Visits require/);
  });

  it("blocks again on an expired FSSAI licence, a pincode out of every Area, a changed contact and a newer rate card", async () => {
    const owner = await shop();
    await visit(owner.shopId, owner.id);
    await database.pool.query("INSERT INTO onboarding_fees (shop_id, actor_id, status, amount, payment_date, reference) VALUES ($1, $2, 'paid', 999, '2026-01-01', 'UPI 123')", [owner.shopId, adminId]);
    await hours(owner.headers);
    await accept(owner.headers, await publish(card));
    expect(await blockers(owner.shopId)).toEqual([]);

    // The expiry must be after today in India: at 00:00 UTC on 1 January 2030 it is already 05:30 there.
    const expiry = (date: string) => database.pool.query("UPDATE shops SET fssai_expiry = $1 WHERE id = $2", [date, owner.shopId]);
    await expiry("2030-01-01");
    expect(await blockers(owner.shopId)).toEqual(["fssai_expired"]);
    await expiry("2030-01-02");
    expect(await blockers(owner.shopId)).toEqual([]);

    await database.pool.query("DELETE FROM area_pincodes WHERE pincode = '411038'");
    expect(await blockers(owner.shopId)).toEqual(["pincode_not_in_area"]);
    await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) SELECT '411038', id FROM areas");

    await database.pool.query("UPDATE accounts SET email = 'new@example.com' WHERE id = $1", [owner.id]);
    expect(await blockers(owner.shopId)).toEqual(["owner_email"]);
    await database.pool.query("UPDATE accounts SET phone = '+919876543299' WHERE id = $1", [owner.id]);
    expect(await blockers(owner.shopId)).toEqual(["owner_phone", "owner_email"]);
    await database.pool.query("UPDATE accounts SET phone_verified = true WHERE id = $1", [owner.id]);
    expect(await blockers(owner.shopId)).toEqual(["owner_email"]);
    await database.pool.query("UPDATE accounts SET email_visit_confirmed_at = now() WHERE id = $1", [owner.id]);

    const newer = await publish({ ...card, minimumCart: "120" });
    expect(await blockers(owner.shopId)).toEqual(["agreement"]);
    expect((await goLive(owner.shopId)).json().error).toEqual({ code: "SHOP_NOT_READY", liveCheck: { blockers: ["agreement"], rateCardMissing: [] } });
    await accept(owner.headers, newer);
    expect((await goLive(owner.shopId)).json().state).toBe("live");
  });

  it("moves only an Approved shop, and only Admin moves it", async () => {
    const early = await shop("under_review");
    expect((await goLive(early.shopId)).json().error.code).toBe("SHOP_STATE_CHANGE_REFUSED");
    expect((await check(early.shopId)).json().error.code).toBe("SHOP_STATE_CHANGE_REFUSED");
    expect((await goLive(randomUUID())).json().error.code).toBe("NOT_FOUND");

    const owner = await shop("approved", "other@example.com");
    const created = await app.inject({ method: "POST", url: "/v1/admin/accounts", headers: admin,
      payload: { email: "manager@example.com", name: "Meera", phone: "+919800000001", role: "area_manager", reason: "Onboards shops" } });
    await app.inject({ method: "PUT", url: `/v1/admin/shop-applications/${owner.shopId}/area-manager`, headers: admin,
      payload: { areaManagerId: created.json().id, reason: "Her area" } });
    const manager = await signInAdminWeb("manager@example.com");
    for (const headers of [manager, owner.headers]) {
      expect((await goLive(owner.shopId, headers)).statusCode).toBe(403);
      expect((await check(owner.shopId, headers)).statusCode).toBe(403);
    }
    expect((await goLive(owner.shopId, {})).statusCode).toBe(401);
    expect((await database.pool.query("SELECT state FROM shops WHERE id = $1", [owner.shopId])).rows[0].state).toBe("approved");
  });
});
