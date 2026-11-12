import { randomUUID } from "node:crypto";
import { type StockChangeReason, SyncActionsResponse } from "@ygo/contracts";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { applyStockChange } from "../src/stock-changes";
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


const movements = async () => (await database.pool.query("SELECT kind, reason, quantity::text, target_quantity::text AS target FROM stock_movements ORDER BY created_at, id")).rows;

describe("stock changes with a reason (BIL-3, BIL-7, #67)", () => {
  it("records each reason as a signed adjustment and keeps on-hand the sum of the log", async () => {
    const { pack, send, change, stock } = await shop();
    const packId = await pack("1", "50");
    const cases: Array<[StockChangeReason, object, string]> = [
      ["received", { quantity: "10" }, "60.000"], ["damaged", { quantity: "-3" }, "57.000"], ["expired", { quantity: "-2" }, "55.000"],
      ["returned", { quantity: "1" }, "56.000"], ["correction", { quantity: "-6" }, "50.000"],
    ];
    for (const [reason, quantity, onHand] of cases) {
      const [result] = await send([change({ packId, reason, ...quantity })]);
      expect(result).toMatchObject({ status: "applied", result: { reason, onHand } });
      expect(await stock(packId)).toBe(onHand);
    }
    expect((await movements()).slice(1).map((row) => [row.kind, row.reason, row.quantity])).toEqual([
      ["adjustment", "received", "10.000"], ["adjustment", "damaged", "-3.000"], ["adjustment", "expired", "-2.000"],
      ["adjustment", "returned", "1.000"], ["adjustment", "correction", "-6.000"],
    ]);
  });

  it("turns a counted total into the difference against the latest on-hand, and replays one action once", async () => {
    const { owner, shopId, pack, send, change, stock } = await shop();
    const packId = await pack("1", "50");
    await send([change({ packId, reason: "received", quantity: "10" })]);
    const counted = change({ packId, reason: "counted", total: "42" });
    expect((await send([counted]))[0]).toMatchObject({ status: "applied", result: { change: "-18.000", onHand: "42.000" } });
    expect((await movements()).at(-1)).toEqual({ kind: "adjustment", reason: "counted", quantity: "-18.000", target: "42.000" });
    // The same action again answers the same and changes nothing; so does the movement's own id when the sync record is gone.
    expect((await send([counted]))[0]).toMatchObject({ status: "applied", result: { change: "-18.000" } });
    await database.pool.query("DELETE FROM sync_actions");
    const client = await database.pool.connect();
    try {
      const again = await applyStockChange(client, owner.id, shopId, counted.id, { packId, reason: "counted", total: "42" });
      expect(again).toMatchObject({ status: 200, result: { change: "-18.000", onHand: "42.000" } });
      expect(await applyStockChange(client, owner.id, shopId, counted.id, { packId, reason: "counted", total: "43" })).toEqual({ code: "VALIDATION_FAILED" });
    } finally { client.release(); }
    expect(await stock(packId)).toBe("42.000");
    expect((await movements()).length).toBe(3);
  });

  it("works two counts out against the committed on-hand even when they race, so neither overwrites a sale", async () => {
    const { pack, send, change, stock, bill } = await shop();
    const packId = await pack("1", "50");
    const results = await Promise.all([
      send([change({ packId, reason: "counted", total: "40" })], "phone"),
      send([change({ packId, reason: "counted", total: "70" })], "other"),
    ]);
    expect(results.flat().map((row) => row.status)).toEqual(["applied", "applied"]);
    // Each count's difference was taken from the on-hand at its turn, so the log ends at the count that ran last.
    const onHand = Number(await stock(packId));
    expect([40, 70]).toContain(onHand);
    const rows = await movements();
    expect(rows.slice(1).map((row) => Number(row.quantity)).reduce((sum, quantity) => sum + quantity, 50)).toBe(onHand);
    // A sale after the counts is applied on top of them.
    await send([bill([{ packId, count: 3, unitPrice: "21" }], { payload: { lines: [{ packId, count: 3, unitPrice: "21" }], total: "63", payment: "cash" } })]);
    expect(Number(await stock(packId))).toBe(onHand - 3);
  });

  it("refuses a reason that does not fit its sign, an unknown reason and a retry with another change", async () => {
    const { pack, send, change } = await shop();
    const packId = await pack("1", "50");
    const refused = await send([
      change({ packId, reason: "damaged", quantity: "3" }), change({ packId, reason: "expired", quantity: "0" }),
      change({ packId, reason: "received", quantity: "0" }), change({ packId, reason: "stolen", quantity: "-1" }),
    ]);
    expect(refused.map((row) => [row.status, row.code])).toEqual(Array(4).fill(["rejected", "VALIDATION_FAILED"]));
    const first = change({ packId, reason: "received", quantity: "5" });
    expect((await send([first]))[0]?.status).toBe("applied");
    const changed = { ...first, payload: { packId, reason: "received", quantity: "6" } };
    expect((await send([changed]))[0]).toMatchObject({ status: "retry", code: "ACTION_CONFLICT" });
  });

  it("refuses a stale change, an unknown pack and a stranger's shop", async () => {
    const { pack, send, change, stock } = await shop();
    const packId = await pack("1", "50");
    const old = new Date(clock.now().getTime() - 400 * 24 * 3600 * 1000).toISOString();
    expect((await send([change({ packId, reason: "received", quantity: "1" }, { createdAt: old })]))[0]).toMatchObject({ code: "ACTION_TOO_OLD" });
    expect((await send([change({ packId: randomUUID(), reason: "received", quantity: "1" })]))[0]).toMatchObject({ code: "NOT_FOUND" });
    expect(await stock(packId)).toBe("50.000");
  });

  it("is refused before Live and once Closed, kept while Suspended, and open to Staff", async () => {
    const approved = await shop("approved");
    const approvedPack = await approved.pack("1", "5");
    expect((await approved.send([approved.change({ packId: approvedPack, reason: "received", quantity: "1" })]))[0]).toMatchObject({ code: "SHOP_LISTING_NOT_READY" });
    expect(await approved.stock(approvedPack)).toBe("5.000");
    await database.pool.query("UPDATE shops SET state = 'suspended' WHERE id = $1", [approved.shopId]);
    expect((await approved.send([approved.change({ packId: approvedPack, reason: "received", quantity: "1" })]))[0]).toMatchObject({ status: "applied" });
    // A Staff member changes stock too (S13).
    const staffId = (await database.pool.query<{ id: string }>("INSERT INTO accounts (email) VALUES ('staff@example.com') RETURNING id")).rows[0]?.id;
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staffId, approved.shopId]);
    const staff = await account("staff@example.com");
    expect((await approved.send([approved.change({ packId: approvedPack, reason: "damaged", quantity: "-1" })], "other", staff.headers))[0]).toMatchObject({ status: "applied" });
    await database.pool.query("UPDATE shops SET state = 'closed' WHERE id = $1", [approved.shopId]);
    expect((await approved.send([approved.change({ packId: approvedPack, reason: "received", quantity: "1" })]))[0]).toMatchObject({ code: "SHOP_LISTING_NOT_READY" });
  });

  it("never blocks going below zero, nor the counter sale that follows (BIL-4)", async () => {
    const { pack, send, change, stock, bill } = await shop();
    const packId = await pack("1", "2");
    expect((await send([change({ packId, reason: "damaged", quantity: "-5" })]))[0]).toMatchObject({ status: "applied", result: { onHand: "-3.000" } });
    const sale = await send([bill([{ packId, count: 1, unitPrice: "21" }], { payload: { lines: [{ packId, count: 1, unitPrice: "21" }], total: "21", payment: "cash" } })]);
    expect(sale[0]?.status).toBe("applied");
    expect(await stock(packId)).toBe("-4.000");
  });

  it("refuses a fractional count for a counted pack", async () => {
    const { pack, send, change } = await shop();
    const packId = await pack("1", "5");
    await database.pool.query("UPDATE master_products SET base_unit = 'each', classification = 'counted' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [packId]);
    expect((await send([change({ packId, reason: "received", quantity: "1.5" })]))[0]).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await send([change({ packId, reason: "received", quantity: "2" })]))[0]).toMatchObject({ status: "applied" });
  });
});

describe("low stock on the Stock pull (#67)", () => {

  it("marks a pack Low only when some stock is left at or below its level, never an Out one", async () => {
    const { owner, pack, send, change } = await shop();
    const packId = await pack("1", "8");
    await database.pool.query("UPDATE shop_listings SET low_stock_level = 10 WHERE pack_id = $1", [packId]);
    const state = async () => ((await app.inject({ method: "GET", url: "/v1/sync/changes", headers: owner.headers })).json().changes as Array<{ item: { packId: string; lowStock: boolean } | null }>)
      .find((row) => row.item?.packId === packId)?.item?.lowStock;
    expect(await state()).toBe(true);
    await send([change({ packId, reason: "received", quantity: "20" })]);
    expect(await state()).toBe(false);
    await send([change({ packId, reason: "counted", total: "0" })]);
    expect(await state()).toBe(false);
    await send([change({ packId, reason: "counted", total: "9" })]);
    await database.pool.query("UPDATE shop_listings SET out_of_stock = true WHERE pack_id = $1", [packId]);
    expect(await state()).toBe(false);
  });
});
