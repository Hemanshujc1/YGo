import { randomUUID } from "node:crypto";
import { ShopCounterBill, ShopCounterBillsResponse, SyncActionsResponse } from "@ygo/contracts";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { connectDatabase } from "../src/db";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const start = new Date("2030-01-01T00:00:00.000Z");
const clock = createLocalClock(start);
const mailer = createLocalMailer();
const day = 86400_000;
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

const build = (counterBillVoidSeconds?: number) => buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, counterBillVoidSeconds });

beforeEach(async () => {
  name = `ygo_bill_voids_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  clock.set(start);
  mailer.sent.length = 0;
  app = build();
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
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` }, refreshToken: signed.refreshToken as string };
}

type Line = { packId: string; count: number; unitPrice: string };
type Headers = { authorization: string };
type Account = { refreshToken: string };

/** A Live shop whose Owner sends bills through sync, as in counter-bill-resolutions.test.ts. */
async function shop(email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, 'approved', 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`,
    [shopId],
  );
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  const categoryId = (await database.pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING id", [`Staples ${randomUUID()}`])).rows[0]?.id as string;
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
  /** Sends bills through sync and answers each stored bill's id. */
  const send = async (...actions: Array<ReturnType<typeof bill>>) => {
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: owner.headers, payload: { deviceId: "00000000-0000-4000-8000-000000000001",
      sentAt: clock.now().toISOString(), actions: actions.map((action) => ({ ...action, sequence: ++sequence })) } });
    expect(response.statusCode).toBe(200);
    expect(SyncActionsResponse.parse(response.json()).results.every((result) => result.status === "applied")).toBe(true);
    return Promise.all(actions.map(async (action) => (await database.pool.query("SELECT id FROM counter_bills WHERE client_id = $1", [action.id])).rows[0]?.id as string));
  };
  return { owner, shopId, pack, bill, send };
}

const stock = async (packId: string) => (await database.pool.query(
  "SELECT COALESCE(sum(sm.quantity), 0)::text AS quantity FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id WHERE sl.pack_id = $1", [packId],
)).rows[0]?.quantity as string;
// An account refreshes its session before each call, since the test may have moved the clock past an access token's life.
const fresh = async (who: Headers | Account) => {
  if (!("refreshToken" in who)) return who;
  const session = (await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: who.refreshToken } })).json();
  who.refreshToken = session.refreshToken as string;
  return { authorization: `Bearer ${session.accessToken as string}` };
};
const list = async (who: Headers | Account) => app.inject({ method: "GET", url: "/v1/me/counter-bills", headers: await fresh(who) });
const voidBill = async (who: Headers | Account, billId: string, body: Record<string, unknown> = { reason: "wrong_item" }) =>
  app.inject({ method: "POST", url: `/v1/me/counter-bills/${billId}/void`, headers: await fresh(who), payload: body });
const billRow = async (billId: string) => (await database.pool.query("SELECT to_jsonb(b) AS row FROM counter_bills b WHERE id = $1", [billId])).rows[0]?.row as unknown;
const voids = async () => (await database.pool.query<{ bill_id: string; reason: string; note: string | null; stock_moved: boolean }>("SELECT bill_id, reason, note, stock_moved FROM counter_bill_voids")).rows;
const code = (response: { json: () => unknown }) => (response.json() as { error: { code: string } }).error.code;

describe("The Owner voids a counter bill (#54, BIL-6)", () => {
  it("lists the shop's readable bills from the last 2 days, newest first, held ones without a void", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const line = [{ packId: rice, count: 2, unitPrice: "21" }];
    clock.set(new Date(start.getTime() - 3 * day));
    const [old] = await send(bill(line));
    clock.set(start);
    const [first] = await send(bill(line, { payload: { lines: line, total: "42", payment: "upi" } }));
    clock.set(new Date(start.getTime() + 60_000));
    const [sameReference, invalid] = await send(bill(line, { id: "0f3a91bc-0000-4000-8000-000000000001" }), bill(line, { payload: { lines: line, total: "-1", payment: "cash" } }));
    // A second bill with the same reference is held, with no number.
    clock.set(new Date(start.getTime() + 120_000));
    const [clash] = await send(bill(line, { id: "0f3a91bc-1111-4000-8000-000000000002" }));
    // Another shop's bill never shows.
    const other = await shop("other@example.com");
    await other.send(other.bill([{ packId: await other.pack(), count: 1, unitPrice: "21" }]));

    const response = await list(owner.headers);
    expect(response.statusCode).toBe(200);
    const { bills } = ShopCounterBillsResponse.parse(response.json());
    expect(bills.map((found) => found.id)).toEqual([clash, sameReference, first]);
    expect(bills.map((found) => found.id)).not.toContain(old);
    expect(bills.map((found) => found.id)).not.toContain(invalid);
    expect(bills[2]).toEqual({ id: first, reference: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/), number: 2, total: "42.00", payment: "upi",
      madeAt: start.toISOString(), receivedAt: start.toISOString(), voidUntil: new Date(start.getTime() + day).toISOString(), voidable: true, voided: null });
    expect(bills[0]).toMatchObject({ number: null, voidable: false, voided: null });
  });

  it("gives back exactly the stock the bill took, in a new movement, and leaves the bill as recorded", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50"), dal = await pack("1", "20");
    const [billId] = await send(bill([{ packId: rice, count: 2, unitPrice: "21" }, { packId: dal, count: 3, unitPrice: "21" }],
      { payload: { lines: [{ packId: rice, count: 2, unitPrice: "21" }, { packId: dal, count: 3, unitPrice: "21" }], manualLines: [{ name: "Rope", count: 1, unitPrice: "30" }], total: "135", payment: "cash" } }));
    expect([await stock(rice), await stock(dal)]).toEqual(["40.000", "17.000"]);
    const before = await billRow(billId as string);

    clock.set(new Date(start.getTime() + 3600_000));
    const response = await voidBill(owner, billId as string, { reason: "other", note: "  Customer changed their mind  " });
    expect(response.statusCode).toBe(201);
    expect(ShopCounterBill.parse(response.json())).toMatchObject({ id: billId, number: 1, voidable: false,
      voided: { reason: "other", note: "Customer changed their mind", createdAt: clock.now().toISOString() } });
    expect([await stock(rice), await stock(dal)]).toEqual(["50.000", "20.000"]);
    const returned = await database.pool.query("SELECT kind, quantity::text AS quantity, actor_id FROM stock_movements sm WHERE kind = 'void' ORDER BY sm.quantity");
    expect(returned.rows).toEqual([{ kind: "void", quantity: "3.000", actor_id: owner.id }, { kind: "void", quantity: "10.000", actor_id: owner.id }]);
    expect(await billRow(billId as string)).toEqual(before);
    expect(await voids()).toEqual([{ bill_id: billId, reason: "other", note: "Customer changed their mind", stock_moved: true }]);
    // The void shows on the list too.
    expect(ShopCounterBillsResponse.parse((await list(owner)).json()).bills[0]).toMatchObject({ voidable: false, voided: { reason: "other" } });
  });

  it("gives no stock back for a bill that took none: a total that disagrees, or typed lines only", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [mismatch, typed] = await send(bill([{ packId: rice, count: 2, unitPrice: "21" }], { payload: { lines: [{ packId: rice, count: 2, unitPrice: "21" }], total: "40", payment: "cash" } }),
      bill([], { payload: { lines: [], manualLines: [{ name: "Rope", count: 1, unitPrice: "30" }], total: "30", payment: "cash" } }));
    expect(await stock(rice)).toBe("50.000");
    for (const id of [mismatch, typed]) expect((await voidBill(owner.headers, id as string)).statusCode).toBe(201);
    expect(await stock(rice)).toBe("50.000");
    expect((await voids()).map((saved) => saved.stock_moved)).toEqual([false, false]);
  });

  it("gives stock back to a pack taken off the shop's list since the sale", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 2, unitPrice: "21" }]));
    await database.pool.query("UPDATE master_products SET active = false WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [rice]);
    expect((await voidBill(owner.headers, billId as string)).statusCode).toBe(201);
    expect(await stock(rice)).toBe("50.000");
  });

  it("closes the window on the server's clock, counted from when the server received the bill, whatever the phone's clock said", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    // The phone said one bill was made 3 days ago and another an hour ahead; both reached the server now.
    const [late, ahead, onTime] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }], { createdAt: new Date(start.getTime() - 3 * day).toISOString() }),
      bill([{ packId: rice, count: 1, unitPrice: "21" }], { createdAt: new Date(start.getTime() + 3600_000).toISOString(), clockSuspect: true }),
      bill([{ packId: rice, count: 1, unitPrice: "21" }]));

    clock.set(new Date(start.getTime() + day - 1));
    expect((await voidBill(owner, late as string)).statusCode).toBe(201);
    clock.set(new Date(start.getTime() + day));
    const refused = await voidBill(owner, ahead as string);
    expect([refused.statusCode, code(refused)]).toEqual([409, "COUNTER_BILL_NOT_VOIDABLE"]);
    const { bills } = ShopCounterBillsResponse.parse((await list(owner)).json());
    expect(bills.find((found) => found.id === onTime)).toMatchObject({ voidable: false, voided: null });
    expect(await voids()).toHaveLength(1);
    expect(await stock(rice)).toBe("40.000");
  });

  it("takes the window from COUNTER_BILL_VOID_SECONDS", async () => {
    await app.close();
    app = build(3600);
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    expect(ShopCounterBillsResponse.parse((await list(owner)).json()).bills[0]?.voidUntil).toBe(new Date(start.getTime() + 3600_000).toISOString());
    clock.set(new Date(start.getTime() + 3600_000));
    expect(code(await voidBill(owner, billId as string))).toBe("COUNTER_BILL_NOT_VOIDABLE");
  });

  it("lists bills as far back as a void window longer than 2 days", async () => {
    await app.close();
    app = build(3 * 86400);
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    clock.set(new Date(start.getTime() - 2.5 * day));
    const [billId] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    clock.set(start);
    expect(ShopCounterBillsResponse.parse((await list(owner)).json()).bills).toMatchObject([{ id: billId, voidable: true }]);
  });

  it("refuses a void whose stock back would be more than Stock can show, and changes nothing", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 2, unitPrice: "21" }]));
    await database.pool.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
      SELECT id, $2, gen_random_uuid(), 'void', 999999999.999 - 40 FROM shop_listings WHERE pack_id = $1`, [rice, owner.id]);
    const response = await voidBill(owner.headers, billId as string);
    expect([response.statusCode, code(response)]).toEqual([409, "COUNTER_BILL_NOT_VOIDABLE"]);
    expect(await voids()).toEqual([]);
    expect(await stock(rice)).toBe("999999999.999");
  });

  it("gives back only the bill's own sales, not another movement that shares its id", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50"), dal = await pack("1", "20");
    const sent = bill([{ packId: rice, count: 2, unitPrice: "21" }]);
    const [billId] = await send(sent);
    await database.pool.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
      SELECT id, gen_random_uuid(), $2, 'sale', -4 FROM shop_listings WHERE pack_id = $1`, [dal, sent.id]);
    expect((await voidBill(owner.headers, billId as string)).statusCode).toBe(201);
    expect([await stock(rice), await stock(dal)]).toEqual(["50.000", "16.000"]);
  });

  it("makes one void and one stock return however many requests arrive at once", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 2, unitPrice: "21" }]));
    const responses = await Promise.all(["wrong_item", "wrong_price", "billed_twice", "not_taken", "wrong_item"].map((reason) => voidBill(owner.headers, billId as string, { reason })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(responses.filter((response) => response.statusCode === 409).map(code)).toEqual(Array(4).fill("COUNTER_BILL_VOIDED"));
    expect(await voids()).toHaveLength(1);
    expect(await stock(rice)).toBe("50.000");
    // A retry later, as after a lost response, is refused the same way and returns nothing more.
    expect(code(await voidBill(owner.headers, billId as string))).toBe("COUNTER_BILL_VOIDED");
    expect(await stock(rice)).toBe("50.000");
  });

  it("refuses a held bill: it has no number and took no stock", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    await send(bill([{ packId: rice, count: 1, unitPrice: "21" }], { id: "0f3a91bc-0000-4000-8000-000000000001" }));
    const [held] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }], { id: "0f3a91bc-1111-4000-8000-000000000002" }));
    const response = await voidBill(owner.headers, held as string);
    expect([response.statusCode, code(response)]).toEqual([409, "COUNTER_BILL_NOT_VOIDABLE"]);
    expect(await voids()).toEqual([]);
  });

  it("lets only the Owner void: Staff get 403, and another shop's bill is not found", async () => {
    const { owner, shopId, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    const staff = await signIn("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
    const other = await shop("other@example.com");
    await other.pack();
    const stranger = await signIn("stranger@example.com");

    expect((await list(staff.headers)).statusCode).toBe(200);
    expect([(await voidBill(staff.headers, billId as string)).statusCode, (await voidBill(other.owner.headers, billId as string)).statusCode,
      (await voidBill(stranger.headers, billId as string)).statusCode, (await list(stranger.headers)).statusCode]).toEqual([403, 404, 404, 404]);
    expect((await voidBill(owner.headers, randomUUID())).statusCode).toBe(404);
    expect(await voids()).toEqual([]);
    expect(await stock(rice)).toBe("45.000");
  });

  it("voids while Live or Suspended, and refuses once the shop is Closed", async () => {
    const { owner, shopId, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [first, second] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]), bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    await database.pool.query("UPDATE shops SET state = 'suspended' WHERE id = $1", [shopId]);
    expect((await voidBill(owner.headers, first as string)).statusCode).toBe(201);
    await database.pool.query("UPDATE shops SET state = 'closed' WHERE id = $1", [shopId]);
    const response = await voidBill(owner.headers, second as string);
    expect([response.statusCode, code(response)]).toEqual([409, "SHOP_NOT_BILLING"]);
  });

  it("needs a reason from the list, and a note only for Other", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    for (const body of [{}, { reason: "mistake" }, { reason: "other" }, { reason: "other", note: "   " }, { reason: "other", note: "x".repeat(501) }, { reason: "wrong_item", note: "Extra" }]) {
      expect((await voidBill(owner.headers, billId as string, body)).statusCode).toBe(400);
    }
    expect(await voids()).toEqual([]);
  });

  it("keeps a void as written", async () => {
    const { owner, pack, bill, send } = await shop();
    const rice = await pack("5", "50");
    const [billId] = await send(bill([{ packId: rice, count: 1, unitPrice: "21" }]));
    await voidBill(owner.headers, billId as string);
    await expect(database.pool.query("UPDATE counter_bill_voids SET reason = 'other', note = 'Changed'")).rejects.toThrow(/append-only/);
    await expect(database.pool.query("DELETE FROM counter_bill_voids")).rejects.toThrow(/append-only/);
    await expect(database.pool.query("INSERT INTO counter_bill_voids (bill_id, actor_id, reason, stock_moved, created_at) VALUES ($1, $2, 'wrong_item', false, now())", [billId, owner.id])).rejects.toThrow(/unique/);
  });
});
