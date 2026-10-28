import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { AGREEMENT_VERSION } from "@ygo/contracts";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";

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
  name = `ygo_agreement_${randomUUID().replaceAll("-", "")}`;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try { await root.query(`CREATE DATABASE ${name}`); } finally { await root.end(); }
  const url = new URL(rootUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  } finally { await client.end(); }
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
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

/** A sent shop in `state` with its Owner signed in. */
async function shop(state = "approved", email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [shopId, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  return { ...owner, shopId };
}

async function category(label: string): Promise<string> {
  return String((await database.pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING id", [label])).rows[0]?.id);
}

async function publish(scope: object, values: object): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope, values, reason: "Pilot card" } });
  expect(response.statusCode).toBe(201);
  return response.json().version as string;
}

const percent = (percentage: string) => ({ formula: "percentage", fixedAmount: null, percentage, minimum: null, maximum: null, base: "before_shop_discount" });
const globalCard = {
  commission: percent("10"),
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};

const read = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me/shop-agreement", headers });
const accept = (headers: Record<string, string>, payload: object) => app.inject({ method: "POST", url: "/v1/me/shop-agreement", headers, payload });

describe("Onboarding agreement (#362, ONB-5)", () => {
  it("shows the shop's card with each category whose commission differs, and stores the acceptance", async () => {
    const owner = await shop();
    const dairy = await category("Dairy");
    const snacks = await category("Snacks");
    await publish({ type: "global" }, globalCard);
    await publish({ type: "category", id: dairy }, { commission: percent("5") });
    await publish({ type: "category", id: snacks }, { commission: percent("10") });
    const version = await publish({ type: "shop", id: owner.shopId }, { minimumCart: "150" });

    const shown = await read(owner.headers);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      agreementVersion: AGREEMENT_VERSION, rateCardVersion: version, rateCard: { ...globalCard, minimumCart: "150" }, missing: [],
      categoryCommissions: [{ categoryId: dairy, name: "Dairy", commission: percent("5") }], accepted: null, current: false,
    });

    clock.set(new Date("2030-01-01T00:01:00.000Z"));
    const accepted = await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: version });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      accepted: { agreementVersion: AGREEMENT_VERSION, rateCardVersion: version, acceptedAt: "2030-01-01T00:01:00.000Z" }, current: true,
    });
    const stored = await database.pool.query("SELECT account_id, agreement_version, rate_card_version::text AS version FROM shop_agreement_acceptances WHERE shop_id = $1", [owner.shopId]);
    expect(stored.rows).toEqual([{ account_id: owner.id, agreement_version: AGREEMENT_VERSION, version }]);
    await expect(database.pool.query("DELETE FROM shop_agreement_acceptances")).rejects.toThrow(/immutable/);
  });

  it("asks again after a newer card that affects the shop, and ignores another shop's card", async () => {
    const owner = await shop();
    const other = await shop("approved", "other@example.com");
    const first = await publish({ type: "global" }, globalCard);
    expect((await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: first })).json().current).toBe(true);

    await publish({ type: "shop", id: other.shopId }, { minimumCart: "50" });
    expect((await read(owner.headers)).json()).toMatchObject({ rateCardVersion: first, current: true });

    const dairy = await publish({ type: "category", id: await category("Dairy") }, { commission: percent("5") });
    expect((await read(owner.headers)).json()).toMatchObject({ rateCardVersion: dairy, current: false });
    const stale = await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: first });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("RATE_CARD_CHANGED");
    expect((await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: dairy })).json().current).toBe(true);
    expect((await database.pool.query("SELECT 1 FROM shop_agreement_acceptances WHERE shop_id = $1", [owner.shopId])).rowCount).toBe(2);
  });

  it("refuses an incomplete card, an old agreement and a shop not yet Approved", async () => {
    const owner = await shop();
    const partial = await publish({ type: "global" }, { ...globalCard, statementGraceDays: undefined });
    const shown = (await read(owner.headers)).json();
    expect(shown.missing).toEqual(["statementGraceDays"]);
    const incomplete = await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: partial });
    expect(incomplete.json().error.code).toBe("RATE_CARD_INCOMPLETE");

    const version = await publish({ type: "global" }, globalCard);
    const outdated = await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION + 1, rateCardVersion: version });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json().error.code).toBe("AGREEMENT_OUTDATED");

    const early = await shop("under_review", "early@example.com");
    for (const response of [await read(early.headers), await accept(early.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: version })]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("SHOP_NOT_APPROVED");
    }
    expect((await read((await signIn("nobody@example.com")).headers)).statusCode).toBe(404);
    expect((await read({})).statusCode).toBe(401);
    expect((await accept(owner.headers, { agreementVersion: AGREEMENT_VERSION, rateCardVersion: "0" })).statusCode).toBe(400);
    expect((await database.pool.query("SELECT 1 FROM shop_agreement_acceptances")).rowCount).toBe(0);
  });
});
