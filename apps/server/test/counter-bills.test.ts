import { randomUUID } from "node:crypto";
import { SyncActionsResponse } from "@ygo/contracts";
import { COUNTER_BILL_EXAMPLES } from "@ygo/pricing";
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

beforeEach(async () => {
  name = `ygo_bills_${randomUUID().replaceAll("-", "")}`;
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
  const send = async (actions: Array<ReturnType<typeof bill> & { sequence?: number }>, device = "phone", headers = owner.headers, sentAt = clock.now().toISOString()) => {
    const deviceId = `00000000-0000-4000-8000-${device === "phone" ? "000000000001" : "000000000002"}`;
    const numbered = actions.map((action) => {
      if (action.sequence) return action;
      const sequence = (sequences.get(device) ?? 0) + 1;
      sequences.set(device, sequence);
      return Object.assign(action, { sequence });
    });
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers, payload: { deviceId, sentAt, actions: numbered } });
    expect(response.statusCode).toBe(200);
    return SyncActionsResponse.parse(response.json()).results;
  };
  const stock = async (packId: string) => (await database.pool.query(
    "SELECT COALESCE(sum(sm.quantity), 0)::text AS quantity FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id WHERE sl.pack_id = $1", [packId],
  )).rows[0]?.quantity as string;
  const count = async (table: string) => (await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n as number;
  return { owner, shopId, pack, bill, send, stock, count };
}

describe("counter bill sync (#51)", () => {
  it("checks every shared counter-bill example in SQL, and flags a total one paisa off", async () => {
    const { pack, bill, send } = await shop();
    for (const example of COUNTER_BILL_EXAMPLES) {
      const lines = await Promise.all(example.lines.map(async (line) => ({ ...line, packId: await pack("1", "100000") })));
      const [agreed, off] = await send([
        bill(lines, { payload: { lines, total: example.total, payment: "upi" } }),
        bill(lines, { payload: { lines, total: (BigInt(example.total.replace(".", "")) + 1n).toString().replace(/(\d\d)$/, ".$1"), payment: "upi" } }),
      ]);
      expect(agreed?.result).toMatchObject({ heldReason: null, totalMismatch: false });
      expect(off?.result).toMatchObject({ heldReason: null, totalMismatch: true });
      const { rows: [saved] } = await database.pool.query("SELECT checked_total::text AS total FROM counter_bills WHERE client_id = $1", [agreed?.actionId]);
      expect(saved?.total).toBe(example.total);
    }
  });

  it("numbers a bill, moves stock once per line even below zero, and replays the same answer", async () => {
    const { pack, bill, send, stock, count } = await shop();
    const rice = await pack("2", "7"), dal = await pack("1", "5");
    const entry = bill([{ packId: rice, count: 5, unitPrice: "99.50" }, { packId: dal, count: 1, unitPrice: "40" }],
      { payload: { lines: [{ packId: rice, count: 5, unitPrice: "99.50" }, { packId: dal, count: 1, unitPrice: "40" }], total: "537.50", payment: "cash" } });
    const [first] = await send([entry]);
    expect(first).toMatchObject({ status: "applied", code: null, result: { number: 1, heldReason: null, totalMismatch: false, reference: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/) } });
    expect(first?.result).toMatchObject({ reference: entry.id.slice(0, 4).toUpperCase() + "-" + entry.id.slice(4, 8).toUpperCase() });
    expect(await stock(rice)).toBe("-3.000");
    expect(await stock(dal)).toBe("4.000");
    // A lost response is answered again with the same number, and stock moves once.
    const [again] = await send([entry]);
    expect(again).toEqual(first);
    expect(await count("counter_bills")).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE kind = 'sale'")).rows[0]?.n).toBe(2);
    expect((await database.pool.query("SELECT position, count, unit_price::text AS price FROM counter_bill_lines ORDER BY position")).rows)
      .toEqual([{ position: 1, count: 5, price: "99.50" }, { position: 2, count: 1, price: "40.00" }]);
  });

  it("gives gapless numbers across Owner and Staff phones, skipping nothing for held or refused bills", async () => {
    const { shopId, pack, bill, send, count } = await shop();
    const staff = await account("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
    const rice = await pack();
    const line = [{ packId: rice, count: 1, unitPrice: "21" }];
    const sale = () => bill(line, { payload: { lines: line, total: "21", payment: "cash" } });
    const numbers = [
      ...await send([sale(), bill([{ packId: randomUUID(), count: 1, unitPrice: "5" }])]),
      ...await send([sale(), bill(line, { payload: { lines: line, total: "21", payment: "card" } })], "tablet", staff.headers),
      ...await send([sale()]),
    ].map((row) => [row.status, row.code, row.result && "number" in row.result ? row.result.number : null]);
    expect(numbers).toEqual([["applied", null, 1], ["applied", null, null], ["applied", null, 2], ["applied", null, null], ["applied", null, 3]]);
    expect(await count("counter_bills")).toBe(5);
    expect((await database.pool.query("SELECT last_number FROM counter_bill_numbers")).rows).toEqual([{ last_number: 3 }]);
  });

  it("keeps a bill whose reference is taken as a held bill beside the first, with no number and no stock moved", async () => {
    const { pack, bill, send, stock } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    const payload = { lines: line, total: "42", payment: "cash" };
    const first = bill(line, { id: "0f3a91bc-0000-4000-8000-000000000001", payload });
    const second = bill(line, { id: "0f3a91bc-1111-4000-8000-000000000002", payload });
    const [kept, held] = await send([first, second]);
    expect(kept?.result).toMatchObject({ reference: "0F3A-91BC", number: 1, heldReason: null });
    expect(held?.result).toMatchObject({ reference: "0F3A-91BC", number: null, heldReason: "reference_taken" });
    expect(await stock(rice)).toBe("8.000");
    expect((await send([second]))[0]).toEqual(held);
    expect((await send([bill(line, { payload })]))[0]?.result).toMatchObject({ number: 2 });
    // A clashing bill that is also past the limit keeps that reason too.
    const late = bill(line, { id: "0f3a91bc-2222-4000-8000-000000000003", createdAt: "2029-12-20T00:00:00.000Z", payload });
    expect((await send([late]))[0]?.result).toMatchObject({ number: null, heldReason: "too_old" });
    expect((await database.pool.query("SELECT client_id, number, held_reason, reference_clash FROM counter_bills WHERE reference = '0F3A-91BC' ORDER BY client_id")).rows).toEqual([
      { client_id: first.id, number: 1, held_reason: null, reference_clash: false },
      { client_id: second.id, number: null, held_reason: "reference_taken", reference_clash: true },
      { client_id: late.id, number: null, held_reason: "too_old", reference_clash: true },
    ]);
    // Admin can still number the clashing bill later, from the shop's counter.
    await database.pool.query("UPDATE counter_bill_numbers SET last_number = 3");
    await database.pool.query("UPDATE counter_bills SET number = 3, held_reason = NULL WHERE client_id = $1", [second.id]);
  });

  it("answers a reused action id from another account with a conflict, recording nothing", async () => {
    const { shopId, pack, bill, send, count } = await shop();
    const staff = await account("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    const entry = bill(line, { payload: { lines: line, total: "21", payment: "cash" } });
    await send([entry]);
    expect((await send([{ ...entry, sequence: 1 }], "tablet", staff.headers))[0]).toMatchObject({ status: "rejected", code: "ACTION_CONFLICT", result: null });
    expect(await count("counter_bills")).toBe(1);
  });

  it("numbers a bill from a phone whose clock is days behind, flagging the clock only", async () => {
    const { pack, bill, send } = await shop();
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    const behind = "2029-12-20T00:00:00.000Z";
    const [result] = await send([bill(line, { createdAt: behind, payload: { lines: line, total: "21", payment: "cash" } })], "phone", undefined, behind);
    expect(result).toMatchObject({ clockSuspect: true, result: { number: 1, heldReason: null } });
  });

  it("keeps a bill the server cannot read as held, with what the phone sent", async () => {
    const { pack, bill, send, count } = await shop();
    const line = { packId: await pack(), count: 1, unitPrice: "21" };
    const payload = { lines: [line, line], total: "42", payment: "cash" };
    expect((await send([bill([line], { payload })]))[0]).toMatchObject({ status: "applied", result: { number: null, heldReason: "invalid", totalMismatch: false } });
    expect((await database.pool.query("SELECT invalid_payload, payment, total FROM counter_bills")).rows).toEqual([{ invalid_payload: payload, payment: null, total: null }]);
    expect(await count("counter_bill_lines")).toBe(0);
  });

  it("holds a bill with a pack off the shop's list or older than the limit, recording its lines", async () => {
    const { pack, bill, send, stock, count } = await shop();
    const rice = await pack("1", "10"), withdrawn = await pack("1", "10");
    await database.pool.query("UPDATE master_products SET active = false WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [withdrawn]);
    const lines = (packId: string) => [{ packId: rice, count: 1, unitPrice: "21" }, { packId, count: 1, unitPrice: "21" }];
    const results = await send([
      bill(lines(withdrawn), { payload: { lines: lines(withdrawn), total: "42", payment: "cash" } }),
      bill(lines(randomUUID()), { payload: { lines: lines(randomUUID()), total: "42", payment: "cash" } }),
      bill(lines(rice).slice(0, 1), { createdAt: "2029-12-24T00:00:00.000Z", clockSuspect: true, payload: { lines: lines(rice).slice(0, 1), total: "21", payment: "cash" } }),
    ]);
    expect(results.map((row) => row.result)).toMatchObject([
      { number: null, heldReason: "not_listed" }, { number: null, heldReason: "not_listed" }, { number: null, heldReason: "too_old" },
    ]);
    expect(await stock(rice)).toBe("10.000");
    expect(await count("counter_bill_lines")).toBe(5);
    expect((await database.pool.query("SELECT clock_suspect, made_at FROM counter_bills WHERE held_reason = 'too_old'")).rows[0])
      .toEqual({ clock_suspect: true, made_at: new Date("2029-12-24T00:00:00.000Z") });
  });

  it("numbers a bill whose total disagrees and keeps both totals, but moves no stock", async () => {
    const { pack, bill, send, stock } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 3, unitPrice: "21" }];
    const [flagged] = await send([bill(line, { payload: { lines: line, total: "60", payment: "upi" } })]);
    expect(flagged?.result).toMatchObject({ number: 1, heldReason: null, totalMismatch: true });
    expect(await stock(rice)).toBe("10.000");
    expect((await database.pool.query("SELECT total::text, checked_total::text, total_mismatch, payment FROM counter_bills")).rows)
      .toEqual([{ total: "60.00", checked_total: "63.00", total_mismatch: true, payment: "upi" }]);
  });

  it.each(["live", "suspended"])("bills while %s", async (state) => {
    const { pack, bill, send } = await shop(state);
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    expect((await send([bill(line, { payload: { lines: line, total: "21", payment: "cash" } })]))[0]?.result).toMatchObject({ number: 1 });
  });

  it.each(["draft", "submitted", "under_review", "approved", "closed"])("refuses a bill while %s and gives no number", async (state) => {
    const { pack, bill, send, count } = await shop(state);
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    expect((await send([bill(line, { payload: { lines: line, total: "21", payment: "cash" } })]))[0]).toMatchObject({ status: "rejected", code: "SHOP_NOT_BILLING", result: null });
    expect(await count("counter_bills")).toBe(0);
  });

  it("keeps a bill as recorded: only a held bill may take the counter's next number", async () => {
    const { pack, bill, send } = await shop();
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    await send([bill(line, { payload: { lines: line, total: "21", payment: "cash" } }), bill(line, { createdAt: "2029-12-01T00:00:00.000Z", payload: { lines: line, total: "21", payment: "cash" } })]);
    for (const statement of ["UPDATE counter_bills SET total = 1", "UPDATE counter_bills SET number = 9 WHERE number = 1", "DELETE FROM counter_bills",
      "UPDATE counter_bill_lines SET count = 9", "DELETE FROM counter_bill_lines", "TRUNCATE counter_bills CASCADE"]) {
      await expect(database.pool.query(statement)).rejects.toThrow(/refused/);
    }
    // A held bill takes only the counter's next number, so Admin raises the counter first.
    await expect(database.pool.query("UPDATE counter_bills SET number = 2, held_reason = NULL WHERE held_reason = 'too_old'")).rejects.toThrow(/refused/);
    await database.pool.query("UPDATE counter_bill_numbers SET last_number = 2");
    await database.pool.query("UPDATE counter_bills SET number = 2, held_reason = NULL WHERE held_reason = 'too_old'");
    expect((await database.pool.query("SELECT number FROM counter_bills ORDER BY number")).rows).toEqual([{ number: 1 }, { number: 2 }]);
  });
});
