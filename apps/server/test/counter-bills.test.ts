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
  it("checks every shared counter-bill example in SQL, as catalog lines and as typed lines, and flags a total one paisa off", async () => {
    const { pack, bill, send, stock } = await shop();
    const plusPaisa = (total: string) => (BigInt(total.replace(".", "")) + 1n).toString().padStart(3, "0").replace(/(\d\d)$/, ".$1");
    for (const example of COUNTER_BILL_EXAMPLES) {
      const discount = example.discount ? { discount: example.discount } : {};
      const catalog = await Promise.all(example.lines.map(async (line) => ({ ...line, packId: await pack("1", "100000") })));
      const manualLines = example.lines.map((line, index) => ({ name: `Loose item ${index + 1}`, ...line }));
      if (example.total === null) {
        // A discount over the sum cannot be recorded: it is kept unreadable, with no number and no stock moved.
        const [refused, typed] = await send([bill(catalog, { payload: { lines: catalog, ...discount, total: "0", payment: "upi" } }),
          bill([], { payload: { lines: [], manualLines, ...discount, total: "0", payment: "upi" } })]);
        expect(refused?.result).toMatchObject({ number: null, heldReason: "invalid" });
        expect(typed?.result).toMatchObject({ number: null, heldReason: "invalid" });
        continue;
      }
      const [agreed, off, typedAgreed, typedOff] = await send([
        bill(catalog, { payload: { lines: catalog, ...discount, total: example.total, payment: "upi" } }),
        bill(catalog, { payload: { lines: catalog, ...discount, total: plusPaisa(example.total), payment: "upi" } }),
        bill([], { payload: { lines: [], manualLines, ...discount, total: example.total, payment: "upi" } }),
        bill([], { payload: { lines: [], manualLines, ...discount, total: plusPaisa(example.total), payment: "upi" } }),
      ]);
      for (const row of [agreed, typedAgreed]) expect(row?.result).toMatchObject({ heldReason: null, totalMismatch: false });
      for (const row of [off, typedOff]) expect(row?.result).toMatchObject({ heldReason: null, totalMismatch: true });
      for (const row of [agreed, typedAgreed]) {
        const { rows: [saved] } = await database.pool.query("SELECT checked_total::text AS total FROM counter_bills WHERE client_id = $1", [row?.actionId]);
        expect(saved?.total).toBe(example.total);
      }
      // Typed lines move no stock; the catalog lines of the agreeing bill do.
      expect(await stock(catalog[0]?.packId ?? "")).toBe(`${100000 - (example.lines[0]?.count ?? 0)}.000`);
    }
  });

  it("records a typed line, a discount and the customer with the bill, and moves stock for the catalog lines only", async () => {
    const { pack, bill, send, stock } = await shop();
    const rice = await pack("1", "10");
    const lines = [{ packId: rice, count: 2, unitPrice: "21" }];
    const manualLines = [{ name: "Loose sugar", count: 3, unitPrice: "12.50" }];
    const customer = { name: "Meena Rao", phone: "+919812345678", offers: true };
    const [first] = await send([bill(lines, { payload: { lines, manualLines, discount: "9.50", customer, total: "70.00", payment: "cash" } })]);
    expect(first?.result).toMatchObject({ number: 1, heldReason: null, totalMismatch: false });
    expect(await stock(rice)).toBe("8.000");
    const { rows: [saved] } = await database.pool.query("SELECT discount::text, customer_name, customer_phone, customer_offers, checked_total::text FROM counter_bills");
    expect(saved).toEqual({ discount: "9.50", customer_name: "Meena Rao", customer_phone: "+919812345678", customer_offers: true, checked_total: "70.00" });
    expect((await database.pool.query("SELECT position, name, count, unit_price::text AS price FROM counter_bill_manual_lines")).rows)
      .toEqual([{ position: 1, name: "Loose sugar", count: 3, price: "12.50" }]);
  });

  it("numbers a bill made only of typed lines, with no stock to move", async () => {
    const { pack, bill, send, count } = await shop();
    await pack(); // a listed pack makes the shop Live
    const manualLines = [{ name: "Carry bag", count: 1, unitPrice: "5" }];
    const [only] = await send([bill([], { payload: { lines: [], manualLines, total: "5.00", payment: "upi" } })]);
    expect(only?.result).toMatchObject({ number: 1, heldReason: null });
    expect(await count("stock_movements WHERE kind = 'sale'")).toBe(0);
  });

  it("flags a bill whose manual line matches the denylist without blocking the shop (#69, CAT-8)", async () => {
    const { pack, bill, send } = await shop();
    await pack();
    const manualLines = [{ name: "King cigarette", count: 1, unitPrice: "20" }];
    const cleanLines = [{ name: "Carry bag", count: 1, unitPrice: "5" }];

    const rows = await send([
      bill([], { payload: { lines: [], manualLines, total: "20.00", payment: "cash" } }),
      bill([], { payload: { lines: [], manualLines: cleanLines, total: "5.00", payment: "upi" } }),
    ]);

    expect(rows[0]?.result).toMatchObject({ number: 1, heldReason: null });
    expect(rows[1]?.result).toMatchObject({ number: 2, heldReason: null });

    const { rows: flagRows } = await database.pool.query<{ number: number; flaggedDenylist: boolean }>(
      'SELECT number, flagged_denylist AS "flaggedDenylist" FROM counter_bills ORDER BY number'
    );
    expect(flagRows).toEqual([
      { number: 1, flaggedDenylist: true },
      { number: 2, flaggedDenylist: false },
    ]);
  });

  it("holds a bill with an unreadable customer or a name the database cannot keep, without stalling the batch", async () => {
    const { pack, bill, send } = await shop();
    const rice = await pack();
    const lines = [{ packId: rice, count: 1, unitPrice: "21" }];
    const rows = await send([
      bill(lines, { payload: { lines, customer: { phone: "+919812345678", offers: false, name: "Meena" }, manualLines: [{ name: "Bad \ud800 name", count: 1, unitPrice: "1" }], total: "22.00", payment: "cash" } }),
      bill(lines, { payload: { lines, customer: { name: "Meena", offers: true }, total: "21.00", payment: "cash" } }),
      bill(lines, { payload: { lines, total: "21.00", payment: "cash" } }),
    ]);
    expect(rows.map((row) => row.result && "heldReason" in row.result ? row.result.heldReason : "?")).toEqual(["invalid", "invalid", null]);
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
    await database.pool.query("UPDATE counter_bills SET number = 3, held_reason = NULL, numbered_at = received_at WHERE client_id = $1", [second.id]);
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

  it.each([["Owner phone first", true], ["Staff phone first", false]])("leaves the same stock and an unbroken numbering when two phones send in either order: %s (#642, BIL-5)", async (_label, ownerFirst) => {
    const { shopId, pack, bill, send, stock, count } = await shop();
    const staff = await account("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
    const rice = await pack("1", "50");
    const sale = (counted: number) => { const line = [{ packId: rice, count: counted, unitPrice: "21" }]; return bill(line, { payload: { lines: line, total: String(21 * counted), payment: "cash" } }); };
    const owners = () => send([sale(1), sale(2), sale(3)]);
    const staffs = () => send([sale(4), sale(5)], "tablet", staff.headers);
    const answers = ownerFirst ? [...await owners(), ...await staffs()] : [...await staffs(), ...await owners()];
    const numbers = answers.map((row) => row.result && "number" in row.result ? row.result.number : null).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect(await stock(rice)).toBe("35.000");
    expect(await count("counter_bills")).toBe(5);
    expect((await database.pool.query("SELECT last_number FROM counter_bill_numbers")).rows).toEqual([{ last_number: 5 }]);
  });

  it("tells the phone the offline limits it enforces and refuses a batch over them, applying nothing (#642, BIL-3)", async () => {
    await app.close();
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, syncMaxActions: 2, syncMaxOfflineHours: 24 });
    const { owner, pack, bill, send, count } = await shop();
    const access = await app.inject({ method: "GET", url: "/v1/sync/access", headers: owner.headers });
    expect(access.json()).toMatchObject({ limits: { maxActions: 2, maxOfflineHours: 24 } });
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    const sale = () => bill(line, { payload: { lines: line, total: "21", payment: "cash" } });
    const over = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: owner.headers,
      payload: { deviceId: "00000000-0000-4000-8000-000000000001", sentAt: clock.now().toISOString(), actions: [sale(), sale(), sale()].map((action, index) => ({ ...action, sequence: index + 1 })) } });
    expect(over.statusCode).toBe(400);
    expect(await count("counter_bills")).toBe(0);
    expect(await send([sale(), sale()])).toHaveLength(2);
  });

  it("numbers a bill from a phone whose clock is days ahead and dates its sale no later than the server got it (#642)", async () => {
    const { pack, bill, send } = await shop();
    const line = [{ packId: await pack(), count: 1, unitPrice: "21" }];
    const ahead = "2030-01-09T00:00:00.000Z";
    const [result] = await send([bill(line, { createdAt: ahead, payload: { lines: line, total: "21", payment: "cash" } })], "phone", undefined, ahead);
    expect(result).toMatchObject({ clockSuspect: true, result: { number: 1, heldReason: null } });
    expect((await database.pool.query("SELECT made_at, received_at FROM counter_bills")).rows).toEqual([{ made_at: new Date("2030-01-01T00:00:00.000Z"), received_at: new Date("2030-01-01T00:00:00.000Z") }]);
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
    expect((await database.pool.query("SELECT invalid_payload, payment, total FROM counter_bills")).rows).toEqual([{ invalid_payload: JSON.stringify(payload), payment: null, total: null }]);
    expect(await count("counter_bill_lines")).toBe(0);
  });

  it("keeps unreadable bills holding NUL and a lone surrogate as exact escaped text, and numbers the next bill 1 (#471)", async () => {
    const { pack, bill, send, stock } = await shop();
    const rice = await pack("1", "10");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    // inject sends these as the six-character escapes a phone would send; the server parses them back into the characters.
    const nul = { lines: line, total: "42", payment: "cash\u0000" }, surrogate = { lines: line, total: "42", payment: "\ud800" };
    const results = await send([bill(line, { payload: nul }), bill(line, { payload: surrogate }), bill(line, { payload: { lines: line, total: "42", payment: "cash" } })]);
    expect(results.map((row) => [row.status, row.result])).toMatchObject([
      ["applied", { number: null, heldReason: "invalid" }], ["applied", { number: null, heldReason: "invalid" }], ["applied", { number: 1, heldReason: null }],
    ]);
    expect(await stock(rice)).toBe("8.000");
    const { rows } = await database.pool.query<{ text: string }>("SELECT invalid_payload AS text FROM counter_bills WHERE held_reason = 'invalid' ORDER BY client_id = $1 DESC", [results[0]?.actionId]);
    expect(rows.map((row) => row.text)).toEqual([
      `{"lines":[{"packId":"${rice}","count":2,"unitPrice":"21"}],"total":"42","payment":"cash\\u0000"}`,
      `{"lines":[{"packId":"${rice}","count":2,"unitPrice":"21"}],"total":"42","payment":"\\ud800"}`,
    ]);
    expect(rows.map((row) => JSON.parse(row.text) as unknown)).toEqual([nul, surrogate]);
  });

  it("numbers the largest bill a phone can make at its 16-digit total, and holds a 17-digit total as unreadable (#471)", async () => {
    const { pack, bill, send, stock } = await shop();
    // One pack through the routes, then 99 copies in one statement, so the test stays quick.
    const first = await pack();
    const { rows: copies } = await database.pool.query<{ packId: string }>(`WITH source AS (SELECT p.category_id, sl.* FROM shop_listings sl
        JOIN packs pk ON pk.id = sl.pack_id JOIN master_products p ON p.id = pk.product_id WHERE sl.pack_id = $1),
      products AS (INSERT INTO master_products (name, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
        SELECT 'Rice ' || gen_random_uuid(), category_id, 'kg', 'measured', 'image256', 'image512', 'image1024', true FROM source, generate_series(1, 99) RETURNING id),
      copied AS (INSERT INTO packs (product_id, quantity) SELECT id, 1 FROM products RETURNING id)
    INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, minimum_order_quantity, quantity_step)
    SELECT shop_id, copied.id, online_price, counter_price, mrp, minimum_order_quantity, quantity_step FROM source, copied RETURNING pack_id AS "packId"`, [first]);
    const lines = [first, ...copies.map((copy) => copy.packId)].map((packId) => ({ packId, count: 9999, unitPrice: "9999999999.99" }));
    const [largest, longer] = await send([
      bill(lines, { payload: { lines, total: "9998999999990001", payment: "upi" } }),
      bill(lines, { payload: { lines, total: "99989999999900010", payment: "upi" } }),
    ]);
    expect(largest?.result).toMatchObject({ number: 1, heldReason: null, totalMismatch: false });
    expect(longer?.result).toMatchObject({ number: null, heldReason: "invalid" });
    expect(await stock(first)).toBe("-9949.000");
    expect(await stock(copies[98]?.packId ?? "")).toBe("-9999.000");
    expect((await database.pool.query("SELECT checked_total::text AS total FROM counter_bills WHERE number = 1")).rows).toEqual([{ total: "9998999999990001.00" }]);
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

  it("holds a bill at the largest pack and count, too large for a stock movement, and keeps the batch going", async () => {
    const { owner, pack, bill, send, stock, count } = await shop();
    const largest = await pack("999999999.999", "1"), rice = await pack();
    const huge = [{ packId: largest, count: 9999, unitPrice: "21" }], small = [{ packId: rice, count: 1, unitPrice: "21" }];
    const [held, sold] = await send([
      bill(huge, { payload: { lines: huge, total: "209979", payment: "cash" } }),
      bill(small, { payload: { lines: small, total: "21", payment: "cash" } }),
    ]);
    expect(held).toMatchObject({ status: "applied", result: { number: null, heldReason: "too_large", totalMismatch: false } });
    expect(sold).toMatchObject({ status: "applied", result: { number: 1, heldReason: null } });
    expect(await stock(largest)).toBe("1.000");
    expect(await count("counter_bill_lines")).toBe(2);
    expect((await app.inject({ method: "GET", url: "/v1/me/stock", headers: owner.headers })).statusCode).toBe(200);
  });

  it("numbers sales down to the lowest stock Stock can show, and holds the one past it", async () => {
    const { owner, pack, bill, send, stock } = await shop();
    const largest = await pack("999999999.999", "999999999.999");
    const line = [{ packId: largest, count: 1, unitPrice: "21" }];
    const sale = () => bill(line, { payload: { lines: line, total: "21", payment: "cash" } });
    const results = await send([sale(), sale(), sale()]);
    expect(results.map((row) => row.result)).toMatchObject([
      { number: 1, heldReason: null }, { number: 2, heldReason: null }, { number: null, heldReason: "too_large" },
    ]);
    expect(await stock(largest)).toBe("-999999999.999");
    const listed = await app.inject({ method: "GET", url: "/v1/me/stock", headers: owner.headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0]).toMatchObject({ quantity: expect.stringMatching(/^-999999999\.999$/) });
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

  it("numbers a mismatched bill too large for a stock movement, flagged and moving no stock (#471)", async () => {
    const { pack, bill, send, stock } = await shop();
    const largest = await pack("999999999.999", "1");
    const huge = [{ packId: largest, count: 9999, unitPrice: "21" }];
    const [flagged] = await send([bill(huge, { payload: { lines: huge, total: "1", payment: "cash" } })]);
    expect(flagged?.result).toMatchObject({ number: 1, heldReason: null, totalMismatch: true });
    expect(await stock(largest)).toBe("1.000");
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
      "UPDATE counter_bill_lines SET count = 9", "DELETE FROM counter_bill_lines", "TRUNCATE counter_bills CASCADE", "UPDATE counter_bills SET numbered_at = now()"]) {
      await expect(database.pool.query(statement)).rejects.toThrow(/refused/);
    }
    // A held bill takes only the counter's next number, so Admin raises the counter first.
    await expect(database.pool.query("UPDATE counter_bills SET number = 2, held_reason = NULL, numbered_at = now() WHERE held_reason = 'too_old'")).rejects.toThrow(/refused/);
    await database.pool.query("UPDATE counter_bill_numbers SET last_number = 2");
    // Numbering stamps when, never before the bill arrived, since the void window starts there (#497).
    for (const stamp of ["", ", numbered_at = received_at - interval '1 millisecond'"]) {
      await expect(database.pool.query(`UPDATE counter_bills SET number = 2, held_reason = NULL${stamp} WHERE held_reason = 'too_old'`)).rejects.toThrow(/refused/);
    }
    await database.pool.query("UPDATE counter_bills SET number = 2, held_reason = NULL, numbered_at = received_at WHERE held_reason = 'too_old'");
    expect((await database.pool.query("SELECT number FROM counter_bills ORDER BY number")).rows).toEqual([{ number: 1 }, { number: 2 }]);
  });
});
