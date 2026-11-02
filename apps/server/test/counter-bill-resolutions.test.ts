import { randomUUID } from "node:crypto";
import { AdminCounterBillsResponse, SyncActionsResponse } from "@ygo/contracts";
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
let admin: { id: string; headers: { authorization: string } };

beforeEach(async () => {
  name = `ygo_bill_resolutions_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  admin = await signIn("admin@example.com", false);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function signIn(email: string, mobile = true) {
  const path = mobile ? "/v1/auth" : "/v1/admin/auth";
  await app.inject({ method: "POST", url: `${path}/code`, payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: `${path}/verify`, payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

type Line = { packId: string; count: number; unitPrice: string };

/** A Live shop whose Owner sends bills through sync, as in counter-bills.test.ts. */
async function shop() {
  const owner = await signIn("owner@example.com");
  await database.pool.query("UPDATE accounts SET name = 'Asha Owner' WHERE id = $1", [owner.id]);
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
    await database.pool.query("UPDATE shops SET state = 'live' WHERE id = $1", [shopId]);
    return packId;
  };
  let sequence = 0;
  const bill = (lines: Line[], overrides: Record<string, unknown> = {}) => ({ id: randomUUID(), shopId, type: "counter_bill",
    payload: { lines, total: lines.reduce((sum, line) => sum + line.count * Number(line.unitPrice), 0).toString(), payment: "cash" },
    createdAt: clock.now().toISOString(), clockSuspect: false, ...overrides });
  const send = async (actions: Array<ReturnType<typeof bill>>) => {
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: owner.headers, payload: { deviceId: "00000000-0000-4000-8000-000000000001",
      sentAt: clock.now().toISOString(), actions: actions.map((action) => ({ ...action, sequence: ++sequence })) } });
    expect(response.statusCode).toBe(200);
    return SyncActionsResponse.parse(response.json()).results;
  };
  const stock = async (packId: string) => (await database.pool.query(
    "SELECT COALESCE(sum(sm.quantity), 0)::text AS quantity FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id WHERE sl.pack_id = $1", [packId],
  )).rows[0]?.quantity as string;
  /** The stored bill's id for a bill sent with this action id. */
  const idOf = async (actionId: string) => (await database.pool.query("SELECT id FROM counter_bills WHERE client_id = $1", [actionId])).rows[0]?.id as string;
  const row = async (actionId: string) => (await database.pool.query("SELECT number, held_reason FROM counter_bills WHERE client_id = $1", [actionId])).rows[0] as { number: number | null; held_reason: string | null };
  return { owner, shopId, pack, bill, send, stock, idOf, row };
}

const resolve = (shopId: string, billId: string, action: string, note = "Checked with the shop", headers: { authorization: string } = admin.headers) =>
  app.inject({ method: "POST", url: `/v1/admin/shops/${shopId}/counter-bills/${billId}/resolutions`, headers, payload: { action, note } });
const list = (shopId: string, headers: { authorization: string } = admin.headers) => app.inject({ method: "GET", url: `/v1/admin/shops/${shopId}/counter-bills`, headers });
const movements = async () => (await database.pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE kind = 'sale'")).rows[0]?.n as number;

describe("Admin resolves held and flagged counter bills (#470)", () => {
  it("lists only held and flagged bills, with who made them, their lines, and the first bill of a clash", async () => {
    const { shopId, pack, bill, send, idOf } = await shop();
    const rice = await pack("5", "50");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    const clean = bill(line), mismatch = bill(line, { payload: { lines: line, total: "40", payment: "upi" } });
    const first = bill(line, { id: "0f3a91bc-0000-4000-8000-000000000001" }), clash = bill(line, { id: "0f3a91bc-1111-4000-8000-000000000002" });
    const invalid = bill(line, { payload: { lines: [line[0], line[0]], total: "42", payment: "cash" } });
    await send([clean, mismatch, first, clash, invalid]);

    const response = await list(shopId);
    expect(response.statusCode).toBe(200);
    const { bills } = AdminCounterBillsResponse.parse(response.json());
    const [mismatchId, clashId, invalidId, firstId] = await Promise.all([mismatch, clash, invalid, first].map((sent) => idOf(sent.id)));
    expect(bills.map((found) => found.id).sort()).toEqual([mismatchId, clashId, invalidId].sort());
    const flagged = bills.find((found) => found.id === mismatchId);
    expect(flagged).toMatchObject({ number: expect.any(Number), heldReason: null, totalMismatch: true, total: "40.00", checkedTotal: "42.00", payment: "upi", resolved: false,
      madeBy: { name: "Asha Owner", role: "owner" }, lines: [{ packId: rice, count: 2, unitPrice: "21.00", packQuantity: "5.000", baseUnit: "kg", name: expect.stringContaining("Rice") }] });
    const held = bills.find((found) => found.id === clashId);
    expect(held).toMatchObject({ heldReason: "reference_taken", number: null, original: { id: firstId, number: expect.any(Number) } });
    expect(bills.find((found) => found.id === invalidId)).toMatchObject({ heldReason: "invalid", lines: [], invalidPayload: expect.stringContaining('"total":"42"') });
  });

  it("never shows Admin a customer's name, phone or consent, not even in an unreadable bill's payload (#53)", async () => {
    const { shopId, pack, bill, send, idOf } = await shop();
    const rice = await pack("5", "50");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    const customer = { name: "Meera Kulkarni", phone: "+919876543210", offers: true };
    // Unreadable for a reason of its own (a repeated pack), with the customer sent where the phone puts it, beside it, and inside a line.
    const invalid = bill(line, { payload: { lines: [{ ...line[0], customer }, line[0]], total: "42", payment: "cash", customer, customerPhone: "+919876543210", note: "Meera" } });
    await send([invalid]);
    const invalidId = await idOf(invalid.id);

    const responses = [await list(shopId), await resolve(shopId, invalidId, "review", "Phone bug, counted by hand"), await list(shopId)];
    for (const [index, response] of responses.entries()) {
      expect(response.statusCode).toBe(index === 1 ? 201 : 200);
      for (const secret of ["Meera", "Kulkarni", "9876543210", "offers"]) expect(response.body).not.toContain(secret);
    }
    const { bills } = AdminCounterBillsResponse.parse(responses[0]?.json());
    const shown = bills.find((found) => found.id === invalidId);
    expect(JSON.parse(shown?.invalidPayload ?? "")).toEqual({ lines: [{ ...line[0], "[hidden key 4]": "[hidden]" }, line[0]], total: "42", payment: "cash", "[hidden key 4]": "[hidden]", "[hidden key 5]": "[hidden]", "[hidden key 6]": "[hidden]" });
    // The server keeps what the phone sent.
    expect((await database.pool.query("SELECT invalid_payload FROM counter_bills WHERE id = $1", [invalidId])).rows[0]?.invalid_payload).toContain("Meera Kulkarni");
  });

  it("numbers a not_listed bill with the shop's next number and takes its stock while its pack is still in the shop", async () => {
    const { shopId, pack, bill, send, stock, idOf, row } = await shop();
    const rice = await pack("1", "10"), withdrawn = await pack("2", "10");
    await database.pool.query("UPDATE master_products SET active = false WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [withdrawn]);
    const lines = [{ packId: rice, count: 1, unitPrice: "21" }, { packId: withdrawn, count: 3, unitPrice: "21" }];
    const held = bill(lines);
    await send([bill([{ packId: rice, count: 1, unitPrice: "21" }]), held]);
    expect(await row(held.id)).toEqual({ number: null, held_reason: "not_listed" });
    expect(await stock(withdrawn)).toBe("10.000");

    const done = await resolve(shopId, await idOf(held.id), "number", "Sold at the counter");
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ number: 2, heldReason: null, resolved: true, resolutions: [{ action: "numbered", note: "Sold at the counter", stockMoved: true, actorName: "Ravi Admin" }] });
    expect(await row(held.id)).toEqual({ number: 2, held_reason: null });
    expect(await stock(withdrawn)).toBe("4.000");
    expect(await stock(rice)).toBe("8.000");
    expect((await database.pool.query("SELECT last_number FROM counter_bill_numbers WHERE shop_id = $1", [shopId])).rows[0]).toEqual({ last_number: 2 });
  });

  it("numbers a not_listed bill whose pack is gone from the shop with no stock moved", async () => {
    const { shopId, pack, bill, send, stock, idOf, row } = await shop();
    const rice = await pack("1", "10");
    const lines = [{ packId: rice, count: 1, unitPrice: "21" }, { packId: randomUUID(), count: 1, unitPrice: "21" }];
    const held = bill(lines);
    await send([held]);

    const done = await resolve(shopId, await idOf(held.id), "number", "That pack was removed");
    expect(done.json()).toMatchObject({ number: 1, resolutions: [{ action: "numbered", stockMoved: false }] });
    expect((await row(held.id)).number).toBe(1);
    expect(await stock(rice)).toBe("10.000");
    expect(await movements()).toBe(0);
  });

  it("numbers a too_old bill and takes its stock, but not a too_large one", async () => {
    const { shopId, pack, bill, send, stock, idOf, row } = await shop();
    const rice = await pack("1", "10"), largest = await pack("999999999.999", "1");
    const old = bill([{ packId: rice, count: 2, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z", clockSuspect: true });
    const huge = bill([{ packId: largest, count: 9999, unitPrice: "21" }]);
    await send([old, huge]);
    expect(await row(old.id)).toEqual({ number: null, held_reason: "too_old" });
    expect(await row(huge.id)).toEqual({ number: null, held_reason: "too_large" });

    expect((await resolve(shopId, await idOf(old.id), "number")).json()).toMatchObject({ number: 1, resolutions: [{ stockMoved: true }] });
    expect(await stock(rice)).toBe("8.000");
    expect((await resolve(shopId, await idOf(huge.id), "number", "Too big to take from stock")).json()).toMatchObject({ number: 2, resolutions: [{ stockMoved: false }] });
    expect(await stock(largest)).toBe("1.000");
    expect(await movements()).toBe(1);
  });

  it("numbers a held bill whose total disagrees with no stock, and refuses a note-less action", async () => {
    const { shopId, pack, bill, send, stock, idOf, row } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 1, unitPrice: "21" }];
    const held = bill(line, { createdAt: "2029-12-24T00:00:00.000Z", payload: { lines: line, total: "5", payment: "cash" } });
    await send([held]);
    expect((await resolve(shopId, await idOf(held.id), "number", "")).statusCode).toBe(400);
    expect((await resolve(shopId, await idOf(held.id), "number", "   ")).statusCode).toBe(400);
    expect((await row(held.id)).number).toBeNull();

    expect((await resolve(shopId, await idOf(held.id), "number")).json()).toMatchObject({ number: 1, totalMismatch: true, resolutions: [{ stockMoved: false }] });
    expect(await stock(rice)).toBe("10.000");
  });

  it("closes a reference_taken bill as the same sale with no number and no stock, or numbers it as a different sale with stock", async () => {
    const { shopId, pack, bill, send, stock, idOf, row } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    const first = bill(line, { id: "0f3a91bc-0000-4000-8000-000000000001" });
    const same = bill(line, { id: "0f3a91bc-1111-4000-8000-000000000002" }), other = bill(line, { id: "0f3a91bc-2222-4000-8000-000000000003" });
    await send([first, same, other]);
    expect(await stock(rice)).toBe("8.000");

    const copy = await resolve(shopId, await idOf(same.id), "duplicate", "The phone resent the first bill");
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ number: null, heldReason: "reference_taken", resolved: true, resolutions: [{ action: "duplicate", stockMoved: false }] });
    expect(await row(same.id)).toEqual({ number: null, held_reason: "reference_taken" });
    expect(await stock(rice)).toBe("8.000");

    const different = await resolve(shopId, await idOf(other.id), "number", "A different sale, same reference by chance");
    expect(different.json()).toMatchObject({ number: 2, heldReason: null, resolutions: [{ action: "numbered", stockMoved: true }] });
    expect(await stock(rice)).toBe("6.000");
    expect((await list(shopId)).json().bills.map((found: { id: string; resolved: boolean }) => found.resolved)).toEqual([true, true]);
  });

  it("only reviews an invalid bill or a flagged one, and refuses actions that do not fit", async () => {
    const { shopId, pack, bill, send, idOf, row } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 1, unitPrice: "21" }];
    const invalid = bill(line, { payload: { lines: [line[0], line[0]], total: "42", payment: "cash" } });
    const flagged = bill(line, { payload: { lines: line, total: "9", payment: "cash" } });
    const clean = bill(line), held = bill([{ packId: randomUUID(), count: 1, unitPrice: "21" }]);
    await send([invalid, flagged, clean, held]);
    const refused = (id: string, action: string) => resolve(shopId, id, action).then((response) => [response.statusCode, response.json().error?.code]);

    expect(await refused(await idOf(invalid.id), "number")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(invalid.id), "duplicate")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(flagged.id), "number")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(clean.id), "review")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(clean.id), "note")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(held.id), "review")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);
    expect(await refused(await idOf(held.id), "duplicate")).toEqual([409, "COUNTER_BILL_ACTION_REFUSED"]);

    expect((await resolve(shopId, await idOf(invalid.id), "review", "Phone bug, sale counted by hand")).json()).toMatchObject({ number: null, heldReason: "invalid", resolved: true });
    expect((await resolve(shopId, await idOf(flagged.id), "review", "Shop changed the price by hand")).json()).toMatchObject({ number: 1, totalMismatch: true, resolved: true });
    expect(await row(flagged.id)).toEqual({ number: 1, held_reason: null });
    // Only the clean bill's own sale; nothing was added by Admin.
    expect(await movements()).toBe(1);
  });

  it("keeps a bill open after a note and closes it once, whatever comes after", async () => {
    const { shopId, pack, bill, send, idOf, stock } = await shop();
    const rice = await pack("1", "10");
    const held = bill([{ packId: rice, count: 1, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z" });
    await send([held]);
    const id = await idOf(held.id);

    expect((await resolve(shopId, id, "note", "Calling the shop")).json()).toMatchObject({ resolved: false, number: null, resolutions: [{ action: "noted" }] });
    expect((await resolve(shopId, id, "note", "No answer yet")).json().resolutions).toHaveLength(2);
    expect((await resolve(shopId, id, "number", "Shop confirmed the sale")).json()).toMatchObject({ resolved: true, number: 1 });
    expect(await stock(rice)).toBe("9.000");

    for (const action of ["number", "note", "review"]) {
      const again = await resolve(shopId, id, action);
      expect([again.statusCode, again.json().error.code]).toEqual([409, "COUNTER_BILL_RESOLVED"]);
    }
    expect(await stock(rice)).toBe("9.000");
    expect((await database.pool.query("SELECT count(*)::int AS n FROM counter_bill_resolutions")).rows[0]?.n).toBe(3);
  });

  it("lets only one of two Admins resolving the same bill at once number it and take its stock", async () => {
    const { shopId, pack, bill, send, idOf, stock, row } = await shop();
    const rice = await pack("1", "10");
    const held = bill([{ packId: rice, count: 3, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z" });
    await send([held]);
    const id = await idOf(held.id);
    await app.inject({ method: "POST", url: "/v1/admin/accounts", headers: admin.headers, payload: { email: "second@example.com", name: "Second Admin", phone: "+919812345679", role: "admin", reason: "Second Admin for the race test" } });
    const second = await signIn("second@example.com", false);

    const results = await Promise.all([resolve(shopId, id, "number", "First", admin.headers), resolve(shopId, id, "number", "Second", second.headers),
      resolve(shopId, id, "number", "First again", admin.headers), resolve(shopId, id, "number", "Second again", second.headers)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409]);
    expect(await row(held.id)).toEqual({ number: 1, held_reason: null });
    expect(await stock(rice)).toBe("7.000");
    expect(await movements()).toBe(1);
    expect((await database.pool.query("SELECT last_number FROM counter_bill_numbers")).rows).toEqual([{ last_number: 1 }]);
  });

  it("gives no number twice when several bills are resolved at the same time as the phone sends a new one", async () => {
    const { shopId, pack, bill, send, idOf } = await shop();
    const rice = await pack("1", "100");
    const olds = Array.from({ length: 4 }, () => bill([{ packId: rice, count: 1, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z" }));
    await send(olds);
    const ids = await Promise.all(olds.map((old) => idOf(old.id)));
    const fresh = bill([{ packId: rice, count: 1, unitPrice: "21" }]);

    const [responses] = await Promise.all([Promise.all(ids.map((id) => resolve(shopId, id, "number"))), send([fresh])]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201, 201]);
    const numbers = (await database.pool.query("SELECT number FROM counter_bills ORDER BY number")).rows.map((found) => found.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE kind = 'sale'")).rows[0]?.n).toBe(5);
  });

  it("keeps Admin only, and each bill inside its own shop", async () => {
    const { shopId, owner, pack, bill, send, idOf } = await shop();
    const rice = await pack("1", "10");
    const held = bill([{ packId: rice, count: 1, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z" });
    await send([held]);
    const id = await idOf(held.id);

    expect((await list(shopId, owner.headers)).statusCode).toBe(403);
    expect((await resolve(shopId, id, "number", "Not mine", owner.headers)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/v1/admin/shops/${shopId}/counter-bills` })).statusCode).toBe(401);
    expect((await list(randomUUID())).statusCode).toBe(404);
    expect((await resolve(randomUUID(), id, "number")).statusCode).toBe(404);
    expect((await resolve(shopId, randomUUID(), "number")).statusCode).toBe(404);
    const other = randomUUID();
    await database.pool.query(`INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
      VALUES ($1, 'live', 'Other', 'Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 'B', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'b@upi', now(), now())`, [other]);
    expect((await resolve(other, id, "number")).statusCode).toBe(404);
    expect((await database.pool.query("SELECT number FROM counter_bills WHERE id = $1", [id])).rows[0]?.number).toBeNull();
  });

  it("keeps what Admin decided as written", async () => {
    const { shopId, pack, bill, send, idOf } = await shop();
    const held = bill([{ packId: await pack(), count: 1, unitPrice: "21" }], { createdAt: "2029-12-24T00:00:00.000Z" });
    await send([held]);
    await resolve(shopId, await idOf(held.id), "number");
    await expect(database.pool.query("UPDATE counter_bill_resolutions SET note = 'changed'")).rejects.toThrow(/append-only/);
    await expect(database.pool.query("DELETE FROM counter_bill_resolutions")).rejects.toThrow(/append-only/);
    await expect(database.pool.query("TRUNCATE counter_bill_resolutions")).rejects.toThrow(/append-only/);
    await expect(database.pool.query("INSERT INTO counter_bill_resolutions (bill_id, actor_id, action, note, stock_moved) SELECT id, $1, 'noted', 'x', true FROM counter_bills", [admin.id])).rejects.toThrow();
  });
});
