import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncActionsResponse, type SyncActionsBody } from "@ygo/contracts";
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

beforeEach(async () => {
  name = `ygo_listings_${randomUUID().replaceAll("-", "")}`;
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

async function owner(email = "owner@example.com") {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

async function shop(state = "approved", email = "owner@example.com") {
  const actor = await owner(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`,
    [shopId, state],
  );
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [actor.id, shopId]);
  const categoryId = (await database.pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING id", [`Category ${shopId}`])).rows[0]?.id as string;
  const productId = (await database.pool.query(
    `INSERT INTO master_products (name, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
     VALUES ($2, $1, 'kg', 'measured', 'image256', 'image512', 'image1024', true) RETURNING id`,
    [categoryId, `Rice ${shopId}`],
  )).rows[0]?.id as string;
  const packId = (await database.pool.query("INSERT INTO packs (product_id, quantity) VALUES ($1, '1') RETURNING id", [productId])).rows[0]?.id as string;
  return { ...actor, shopId, packId };
}

const listingBody = {
  onlinePrice: "20.50", counterPrice: "21", mrp: "25", lowStockLevel: "1.000",
  minimumOrderQuantity: "0.25", quantityStep: "0.05",
  quantityOptions: [{ name: "Family pack", quantity: "2", price: "38" }],
};

describe("Owner shop listings and opening stock", () => {
  it("does not expose onboarding or Stock operations for a Closed shop", async () => {
    const actor = await shop("closed");
    const read = await app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: actor.headers });
    const save = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const opening = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "1", clientId: randomUUID() } });
    const stock = await app.inject({ method: "GET", url: "/v1/me/stock", headers: actor.headers });
    expect([read.statusCode, save.statusCode, opening.statusCode, stock.statusCode]).toEqual([409, 409, 409, 409]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM shop_listings WHERE shop_id = $1", [actor.shopId])).rows[0]?.n).toBe(0);
  });

  it("refuses listing and stock setup before Admin approves the shop", async () => {
    const actor = await shop("under_review");
    const listing = await app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: actor.headers });
    const save = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    await database.pool.query(`INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp)
      VALUES ($1, $2, '20', '21', '25')`, [actor.shopId, actor.packId]);
    const stock = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "1", clientId: randomUUID() } });
    expect(listing.statusCode).toBe(409);
    expect(save.statusCode).toBe(409);
    expect(stock.statusCode).toBe(409);
    expect(listing.json()).toEqual({ error: { code: "SHOP_LISTING_NOT_READY" } });
    expect(save.json()).toEqual({ error: { code: "SHOP_LISTING_NOT_READY" } });
    expect(stock.json()).toEqual({ error: { code: "SHOP_LISTING_NOT_READY" } });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM stock_movements")).rows[0]?.n).toBe(0);
  });

  it("saves shop prices and measured quantity options, then appends one idempotent opening movement", async () => {
    const actor = await shop();
    const get = () => app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: actor.headers });
    const save = () => app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const opening = (body: object) => app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: body });

    const empty = await get();
    expect(empty.statusCode).toBe(200);
    expect(empty.json().items[0]).toMatchObject({ packId: actor.packId, listing: null, stock: "0", openingStockRecorded: false });

    const saved = await save();
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ listing: { onlinePrice: "20.50", counterPrice: "21.00", mrp: "25.00", minimumOrderQuantity: "0.250", quantityStep: "0.050", quantityOptions: [{ name: "Family pack", quantity: "2.000", price: "38.00" }] } });
    const clientId = randomUUID();
    const first = await opening({ quantity: "2.500", clientId });
    const retry = await opening({ quantity: "2.5", clientId });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await opening({ quantity: "2.500", clientId: randomUUID() })).json()).toEqual({ error: { code: "OPENING_STOCK_ALREADY_RECORDED" } });
    expect((await get()).json().items[0]).toMatchObject({ stock: "2.500", openingStockRecorded: true });
    expect((await database.pool.query("SELECT kind, quantity FROM stock_movements")).rows).toEqual([{ kind: "opening", quantity: "2.500" }]);
    await expect(database.pool.query("UPDATE stock_movements SET quantity = 9")).rejects.toThrow("append-only");
    await expect(database.pool.query("DELETE FROM stock_movements")).rejects.toThrow("append-only");
    await expect(database.pool.query("TRUNCATE stock_movements")).rejects.toThrow("append-only");
  });

  it("refuses fractional inventory for counted packs", async () => {
    const actor = await shop();
    const changed = await database.pool.query("UPDATE master_products SET base_unit = 'each', classification = 'counted' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [actor.packId]);
    expect(changed.rowCount).toBe(1);
    const save = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: { ...listingBody, minimumOrderQuantity: null, quantityStep: null } });
    expect(save.statusCode).toBe(200);
    const fractional = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "1.5", clientId: randomUUID() } });
    expect(fractional.statusCode).toBe(400);
    expect(fractional.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["quantity"] } });

    const zeroScale = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: { ...listingBody, lowStockLevel: "0.000", minimumOrderQuantity: null, quantityStep: null } });
    expect(zeroScale.statusCode).toBe(200);
    const zeroOpening = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "0.000", clientId: randomUUID() } });
    expect(zeroOpening.statusCode).toBe(201);
  });

  it("serializes concurrent retries of the same opening-stock request", async () => {
    const actor = await shop();
    const saved = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    expect(saved.statusCode).toBe(200);
    const body = { quantity: "2.500", clientId: randomUUID() };
    const send = () => app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: body });

    const [first, retry] = await Promise.all([send(), send()]);

    expect([first.statusCode, retry.statusCode].sort()).toEqual([200, 201]);
    expect(first.json()).toEqual(retry.json());
    expect((await database.pool.query("SELECT count(*)::int AS n, sum(quantity)::text AS quantity FROM stock_movements WHERE kind = 'opening'")).rows[0]).toEqual({ n: 1, quantity: "2.500" });
  });

  it("rejects staff writes and scopes each owner's listing and stock to their shop", async () => {
    const actor = await shop();
    const staff = await owner("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    const otherOwner = await shop("approved", "other-owner@example.com");
    const originalSave = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    expect(originalSave.statusCode).toBe(200);

    const staffSave = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: staff.headers, payload: listingBody });
    const staffStock = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: staff.headers, payload: { quantity: "1", clientId: randomUUID() } });
    expect(staffSave.statusCode).toBe(404);
    expect(staffStock.statusCode).toBe(404);

    const otherSave = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: otherOwner.headers, payload: { ...listingBody, onlinePrice: "19" } });
    const otherStock = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: otherOwner.headers, payload: { quantity: "1", clientId: randomUUID() } });
    expect(otherSave.statusCode).toBe(200);
    expect(otherStock.statusCode).toBe(201);
    expect((await database.pool.query("SELECT online_price FROM shop_listings WHERE shop_id = $1", [actor.shopId])).rows).toEqual([{ online_price: "20.50" }]);
    expect((await database.pool.query("SELECT online_price FROM shop_listings WHERE shop_id = $1", [otherOwner.shopId])).rows).toEqual([{ online_price: "19.00" }]);
    expect((await database.pool.query("SELECT sl.shop_id, sm.quantity FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id")).rows).toEqual([{ shop_id: otherOwner.shopId, quantity: "1.000" }]);
  });

  it("rejects prices above MRP and fractional counted low stock before writing", async () => {
    const actor = await shop();
    const overMrp = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: { ...listingBody, onlinePrice: "26" } });
    expect(overMrp.statusCode).toBe(400);
    expect(overMrp.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    await database.pool.query("UPDATE master_products SET base_unit = 'each', classification = 'counted' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [actor.packId]);
    const fractionalLowStock = await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: { ...listingBody, lowStockLevel: "0.5", minimumOrderQuantity: null, quantityStep: null, quantityOptions: [{ name: "Half pack", quantity: "1.5", price: "20" }] } });
    expect(fractionalLowStock.statusCode).toBe(400);
    expect(fractionalLowStock.json()).toEqual({ error: { code: "VALIDATION_FAILED", fields: ["lowStockLevel", "quantityOptions"] } });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM shop_listings")).rows[0]?.n).toBe(0);

    await expect(database.pool.query(
      `INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp)
       VALUES ($1, $2, '26', '21', '25')`,
      [actor.shopId, actor.packId],
    )).rejects.toMatchObject({ constraint: "shop_listings_prices_valid" });
  });
});

describe("ordered opening-stock sync", () => {
  async function setup() {
    const actor = await shop();
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const deviceId = randomUUID();
    const action = (sequence = 1, overrides = {}) => ({ id: randomUUID(), sequence, shopId: actor.shopId, type: "opening_stock",
      payload: { packId: actor.packId, quantity: "2.5" }, createdAt: clock.now().toISOString(), clockSuspect: false, ...overrides });
    const send = (actions: object[], device = deviceId, headers = actor.headers) => app.inject({ method: "POST", url: "/v1/sync/actions", headers,
      payload: { deviceId: device, sentAt: clock.now().toISOString(), actions } });
    return { actor, deviceId, action, send };
  }

  it("serializes concurrent replay, detects changed IDs, and replays the original result for 30 days", async () => {
    const { actor, action, send, deviceId } = await setup();
    const entry = action();
    const [first, second] = await Promise.all([send([entry]), send([entry])]);
    expect(first.statusCode).toBe(200); expect(second.json()).toEqual(first.json());
    expect(first.json().results[0]).toMatchObject({ status: "applied", code: null });
    expect((await send([{ ...entry, payload: { ...entry.payload, quantity: "9" } }])).json().results[0].code).toBe("ACTION_CONFLICT");
    expect((await send([entry], randomUUID())).json().results[0].code).toBe("ACTION_CONFLICT");
    clock.set(new Date("2030-01-30T00:00:00Z"));
    actor.headers = (await owner()).headers;
    expect((await send([entry])).json()).toEqual(first.json());
    clock.set(new Date("2030-02-01T00:00:00Z"));
    actor.headers = (await owner()).headers;
    expect((await send([entry])).json().results[0].code).toBe("ACTION_CONFLICT");
    expect((await database.pool.query("SELECT sequence FROM sync_devices WHERE device_id = $1", [deviceId])).rows[0]?.sequence).toBe("1");
    expect((await database.pool.query("SELECT count(*)::int AS n FROM stock_movements")).rows[0]?.n).toBe(1);
  });

  it("requires missing sequences and lets an acknowledged permanent failure precede independent work", async () => {
    const { action, send } = await setup();
    const second = action(2);
    expect((await send([second])).json().results[0]).toMatchObject({ status: "retry", code: "SEQUENCE_MISSING" });
    const invalid = action(1, { payload: { quantity: "broken" } });
    const response = await send([invalid, second, action(3)]);
    expect(response.json().results.map((r: { status: string; code: string }) => [r.status, r.code])).toEqual([
      ["rejected", "VALIDATION_FAILED"], ["applied", null], ["rejected", "OPENING_STOCK_ALREADY_RECORDED"],
    ]);
    expect((await send([invalid])).json().results[0]).toEqual(response.json().results[0]);
  });

  it("scopes devices, action IDs and results to the authenticated owner and shop", async () => {
    const { actor, action, send } = await setup();
    const entry = action();
    const other = await shop("approved", "second@example.com");
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${other.packId}`, headers: other.headers, payload: listingBody });
    const staff = await owner("staff-sync@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    expect((await send([entry], undefined, staff.headers)).statusCode).toBe(404);
    expect((await send([entry], undefined, other.headers)).statusCode).toBe(404);
    expect((await send([entry])).json().results[0].status).toBe("applied");
    expect((await send([{ ...entry, shopId: other.shopId, payload: { packId: other.packId, quantity: "3" } }], undefined, other.headers)).json().results[0].status).toBe("applied");
    expect((await send([{ ...action(2), shopId: other.shopId }])).statusCode).toBe(404);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM stock_movements")).rows[0]?.n).toBe(2);
  });

  it("enforces the age bound, flags clock skew, and recognizes the older endpoint's original ID", async () => {
    const { actor, action, send } = await setup();
    const old = action(1, { createdAt: "2029-12-24T00:00:00.000Z" });
    expect((await send([old])).json().results[0]).toMatchObject({ status: "rejected", code: "ACTION_TOO_OLD" });
    const frozen = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: actor.headers,
      payload: { deviceId: randomUUID(), sentAt: old.createdAt, actions: [{ ...old, id: randomUUID(), clockSuspect: true }] } });
    expect(frozen.json().results[0]).toMatchObject({ status: "rejected", code: "ACTION_TOO_OLD", clockSuspect: true });
    const legacy = action(2, { createdAt: old.createdAt });
    const previous = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers,
      payload: { clientId: legacy.id, quantity: "2.5" } });
    const replay = (await send([legacy])).json().results[0];
    expect(replay.status).toBe("applied"); expect(replay.result).toEqual(previous.json());
    const pack = (await database.pool.query("INSERT INTO packs (product_id, quantity) SELECT product_id, '2' FROM packs WHERE id = $1 RETURNING id", [actor.packId])).rows[0]?.id as string;
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${pack}`, headers: actor.headers, payload: listingBody });
    const flagged = action(3, { createdAt: "2030-01-01T00:06:00.000Z", payload: { packId: pack, quantity: "1" } });
    expect((await send([flagged])).json().results[0]).toMatchObject({ clockSuspect: true, status: "applied" });
    expect((await database.pool.query("SELECT clock_suspect FROM sync_actions WHERE action_id = $1", [flagged.id])).rows[0]?.clock_suspect).toBe(true);
  });
});

// Exercise the actual phone outbox over HTTP against Fastify and PostgreSQL.
it.each(["opening_stock", "stock_flag"] as const)("reopens the SQL queue and server after a committed %s response is lost", async (type) => {
  // Load the phone module at runtime so its native declaration globals do not enter the server's TypeScript program.
  const { openingStockQueue, syncOpeningStockBatch } = await import(new URL("../../shopkeeper/src/lib/opening-stock-queue.ts", import.meta.url).href);
  const { adapter } = await import(new URL("../../shopkeeper/test/stock-database-fixture.ts", import.meta.url).href);
  const actor = await shop("live");
  await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
  const directory = mkdtempSync(join(tmpdir(), "ygo-sync-"));
  const path = join(directory, "outbox.db");
  let db = new DatabaseSync(path);
  try {
    let queue = openingStockQueue(adapter(db), randomUUID, () => clock.now());
    const clientId = randomUUID();
    if (type === "opening_stock") queue.save(actor.shopId, actor.packId, { quantity: "3", clientId });
    else queue.saveFlag(actor.shopId, actor.packId, true);
    let address = await app.listen({ host: "127.0.0.1", port: 0 });
    const send = async (body: SyncActionsBody) => {
      const response = await fetch(`${address}/v1/sync/actions`, { method: "POST", headers: { ...actor.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return { ok: true as const, data: SyncActionsResponse.parse(await response.json()) };
    };
    await syncOpeningStockBatch(queue, actor.shopId, async (body: SyncActionsBody) => { await send(body); throw new Error("lost response"); });
    expect(queue.count()).toBe(1);
    const before = queue.batch(actor.shopId);
    db.close(); await app.close();
    db = new DatabaseSync(path); queue = openingStockQueue(adapter(db), randomUUID, () => clock.now());
    expect(queue.batch(actor.shopId)).toMatchObject({ deviceId: before.deviceId, actions: before.actions });
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    expect((await syncOpeningStockBatch(queue, actor.shopId, send))?.results[0]?.status).toBe("applied");
    expect(queue.count()).toBe(0);
    expect(db.prepare("SELECT attempts, status FROM opening_stock_actions").get()).toMatchObject({ attempts: 2, status: "applied" });
    expect((await database.pool.query("SELECT count(*)::int AS n, min(client_id::text) AS id FROM stock_movements")).rows[0])
      .toEqual(type === "opening_stock" ? { n: 1, id: clientId } : { n: 0, id: null });
    if (type === "stock_flag") expect((await database.pool.query("SELECT out_of_stock FROM shop_listings WHERE shop_id = $1", [actor.shopId])).rows[0]?.out_of_stock).toBe(true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});


// S08 over HTTP (#395): nothing saved on the phone is lost or shown as synced before the server's answer arrives.
it("keeps S08 truthful across a dropped reply, a restart, a real refusal and its correction", async () => {
  const { openingStockQueue, syncOpeningStockBatch } = await import(new URL("../../shopkeeper/src/lib/opening-stock-queue.ts", import.meta.url).href);
  const { adapter } = await import(new URL("../../shopkeeper/test/stock-database-fixture.ts", import.meta.url).href);
  const actor = await shop("live");
  await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
  const directory = mkdtempSync(join(tmpdir(), "ygo-s08-"));
  const path = join(directory, "outbox.db");
  // The phone saved its first change 8 days ago: past the server's 7-day age bound.
  let phoneNow = new Date(clock.now().getTime() - 8 * 86400_000);
  const today = new Date(clock.now().getTime() - 3600_000);
  let db = new DatabaseSync(path);
  try {
    let queue = openingStockQueue(adapter(db), randomUUID, () => phoneNow);
    queue.saveFlag(actor.shopId, actor.packId, true);
    phoneNow = clock.now();
    const send = async (body: SyncActionsBody) => {
      const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: actor.headers, payload: body });
      return { ok: true as const, data: SyncActionsResponse.parse(response.json()) };
    };
    await syncOpeningStockBatch(queue, actor.shopId, async (body: SyncActionsBody) => { await send(body); throw new Error("lost response"); });
    // Answered on the server, but the phone never heard: still waiting, never claimed as synced or refused.
    expect(queue.overview(today)).toMatchObject({ attention: [], waiting: [{ type: "stock_flag" }], synced: [] });
    db.close(); db = new DatabaseSync(path); queue = openingStockQueue(adapter(db), randomUUID, () => phoneNow);
    expect(queue.overview(today).waiting).toHaveLength(1);
    await syncOpeningStockBatch(queue, actor.shopId, send);
    const refused = queue.overview(today).attention;
    expect(refused).toMatchObject([{ type: "stock_flag", code: "ACTION_TOO_OLD" }]);
    // Sign-out warns while the refusal is open.
    expect(queue.failureCount()).toBe(1);
    queue.saveFlag(actor.shopId, actor.packId, true);
    await syncOpeningStockBatch(queue, actor.shopId, send);
    const after = queue.overview(today);
    expect(after.attention).toEqual([]); expect(after.waiting).toEqual([]);
    expect(after.synced).toMatchObject([{ type: "stock_flag", outOfStock: true, at: clock.now().toISOString() }]);
    expect(queue.failureCount()).toBe(0);
    expect((await database.pool.query("SELECT out_of_stock FROM shop_listings WHERE shop_id = $1", [actor.shopId])).rows[0]?.out_of_stock).toBe(true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("manual Stock flags (#392)", () => {
  async function setup(state = "live") {
    const actor = await shop();
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "7", clientId: randomUUID() } });
    await database.pool.query("UPDATE shops SET state = $2 WHERE id = $1", [actor.shopId, state]);
    const deviceId = randomUUID();
    const action = (sequence: number, outOfStock: boolean, overrides = {}) => ({ id: randomUUID(), sequence, shopId: actor.shopId, type: "stock_flag",
      payload: { packId: actor.packId, outOfStock }, createdAt: clock.now().toISOString(), clockSuspect: false, ...overrides });
    const send = (actions: object[], headers = actor.headers, device = deviceId) => app.inject({ method: "POST", url: "/v1/sync/actions", headers,
      payload: { deviceId: device, sentAt: clock.now().toISOString(), actions } });
    const read = (headers = actor.headers) => app.inject({ method: "GET", url: "/v1/me/stock", headers });
    return { actor, action, send, read };
  }

  it.each(["live", "suspended"])("lets Owner and Staff use Stock in %s, preserving FIFO/replay and quantity", async (state) => {
    const { actor, action, send, read } = await setup(state);
    const staff = await owner("staff@example.com");
    await database.pool.query("INSERT INTO shop_members VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    expect((await read(staff.headers)).json()).toMatchObject({ shopId: actor.shopId, state, items: [{ packId: actor.packId, quantity: "7.000", outOfStock: false }] });
    const entries = [action(1, true), action(2, false), action(3, true)];
    const first = await send(entries, staff.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().results.map((row: { status: string; result: { outOfStock: boolean } }) => [row.status, row.result.outOfStock]))
      .toEqual([["applied", true], ["applied", false], ["applied", true]]);
    expect((await send(entries, staff.headers)).json()).toEqual(first.json());
    // Another phone's later receipt wins even with an earlier client timestamp.
    const later = action(1, false, { createdAt: "2029-12-31T23:00:00.000Z" });
    expect((await send([later], actor.headers, randomUUID())).json().results[0].status).toBe("applied");
    expect((await read()).json().items[0]).toMatchObject({ outOfStock: false, quantity: "7.000" });
    expect((await database.pool.query("SELECT count(*)::int AS n, sum(quantity)::text AS quantity FROM stock_movements")).rows[0]).toEqual({ n: 1, quantity: "7.000" });
    // Replay an older result without restoring that old flag.
    expect((await send(entries, staff.headers)).json()).toEqual(first.json());
    expect((await read()).json().items[0].outOfStock).toBe(false);
    const opening = action(4, false, { type: "opening_stock", payload: { packId: actor.packId, quantity: "2" } });
    expect((await send([opening], staff.headers)).statusCode).toBe(404);
  });

  it.each(["draft", "submitted", "under_review", "approved", "closed"])("refuses Stock in %s without changing quantities", async (state) => {
    const { action, send, read } = await setup(state);
    expect((await read()).statusCode).toBe(409);
    expect((await send([action(1, true)])).json().results[0]).toMatchObject({ status: "rejected", code: "SHOP_LISTING_NOT_READY" });
    expect((await database.pool.query("SELECT out_of_stock FROM shop_listings")).rows[0]?.out_of_stock).toBe(false);
  });

  it("rejects malformed, old and missing-pack flags independently, and scopes reads/replays to current access", async () => {
    const { actor, action, send, read } = await setup();
    const stranger = await owner("stranger@example.com");
    expect((await read(stranger.headers)).statusCode).toBe(404);
    expect((await send([action(1, true)], stranger.headers)).statusCode).toBe(404);
    const entries = [action(1, true, { payload: { packId: actor.packId, outOfStock: "true" } }),
      action(2, true, { createdAt: "2029-12-20T00:00:00.000Z" }), action(3, true, { payload: { packId: randomUUID(), outOfStock: true } }), action(4, true)];
    expect((await send(entries)).json().results.map((row: { code: string | null }) => row.code)).toEqual(["VALIDATION_FAILED", "ACTION_TOO_OLD", "NOT_FOUND", null]);
    expect((await send([{ ...entries[3], payload: { packId: actor.packId, outOfStock: false } }])).json().results[0].code).toBe("ACTION_CONFLICT");
    await database.pool.query("DELETE FROM shop_members WHERE account_id = $1", [actor.id]);
    expect((await send(entries)).statusCode).toBe(404);
    expect((await read()).statusCode).toBe(404);
  });
});

describe("verified offline shop access", () => {
  it("distinguishes Live/Suspended/Closed, pre-live, Staff unlink, no shop and session expiry", async () => {
    const actor = await shop("live"), staff = await owner("staff@example.com");
    const read = (headers = actor.headers) => app.inject({ method: "GET", url: "/v1/sync/access", headers });
    await database.pool.query("INSERT INTO shop_members VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    for (const state of ["live", "suspended", "approved", "closed"]) {
      await database.pool.query("UPDATE shops SET state = $2 WHERE id = $1", [actor.shopId, state]);
      expect((await read()).json()).toEqual({ shopId: actor.shopId, state });
      expect((await read(staff.headers)).json()).toEqual({ shopId: actor.shopId, state });
    }
    await database.pool.query("DELETE FROM shop_members WHERE account_id = $1", [staff.id]);
    expect((await read(staff.headers)).json()).toEqual({ shopId: null, state: null });
    expect((await read((await owner("new@example.com")).headers)).json()).toEqual({ shopId: null, state: null });
    expect((await app.inject({ method: "GET", url: "/v1/sync/access" })).statusCode).toBe(401);
    clock.set(new Date("2030-01-02T00:00:00Z"));
    expect((await read()).statusCode).toBe(401);
  });

  it("waits for a concurrent membership removal before confirming offline access", async () => {
    const actor = await shop("live");
    const removal = await database.pool.connect();
    try {
      await removal.query("BEGIN");
      await removal.query("DELETE FROM shop_members WHERE account_id = $1", [actor.id]);
      let finished = false;
      const checking = app.inject({ method: "GET", url: "/v1/sync/access", headers: actor.headers }).then((response) => { finished = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(finished).toBe(false);
      await removal.query("COMMIT");
      expect((await checking).json()).toEqual({ shopId: null, state: null });
    } finally {
      await removal.query("ROLLBACK");
      removal.release();
    }
  });
});

describe("durable Stock cursor", () => {
  async function listed() {
    const actor = await shop("live");
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    return actor;
  }
  const pull = (headers: { authorization: string }, since?: string) => app.inject({ method: "GET", url: `/v1/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`, headers });
  it("returns first load, unchanged delta, metadata/stock/flag updates, and replayable lost responses", async () => {
    const actor = await listed();
    const first = await pull(actor.headers);
    expect(first.statusCode).toBe(200);
    const initial = first.json();
    expect(initial.changes).toHaveLength(1);
    expect(initial.changes[0].item).toMatchObject({ packId: actor.packId, quantity: "0", outOfStock: false });
    expect((await pull(actor.headers, initial.cursor)).json()).toMatchObject({ cursor: initial.cursor, changes: [] });
    await database.pool.query("UPDATE master_products SET name = 'Updated rice' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [actor.packId]);
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock`, headers: actor.headers, payload: { quantity: "7", clientId: randomUUID() } });
    await database.pool.query("UPDATE shop_listings SET out_of_stock = true WHERE shop_id = $1", [actor.shopId]);
    const changed = (await pull(actor.headers, initial.cursor)).json();
    expect(changed.changes[0].item).toMatchObject({ name: "Updated rice", quantity: "7.000", outOfStock: true });
    // The caller lost this page: retry the old cursor after a server restart.
    await app.close();
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    expect((await pull(actor.headers, initial.cursor)).json()).toEqual(changed);
    expect((await pull(actor.headers, changed.cursor)).json().changes).toEqual([]);
  });
  it.each(["pack", "product", "published", "category", "parent"])("returns a durable tombstone for %s removal and supports reactivation", async (kind) => {
    const actor = await listed();
    const before = (await pull(actor.headers)).json();
    const category = await database.pool.query("SELECT p.category_id AS id, p.id AS product FROM master_products p JOIN packs pk ON pk.product_id = p.id WHERE pk.id = $1", [actor.packId]);
    const { id: categoryId, product } = category.rows[0];
    if (kind === "parent") {
      const parent = (await database.pool.query("INSERT INTO categories (name) VALUES ('Parent') RETURNING id")).rows[0].id;
      await database.pool.query("UPDATE categories SET parent_id = $2 WHERE id = $1", [categoryId, parent]);
      await database.pool.query("UPDATE categories SET active = false WHERE id = $1", [parent]);
    } else if (kind === "pack") await database.pool.query("UPDATE packs SET active = false WHERE id = $1", [actor.packId]);
    else if (kind === "product") await database.pool.query("UPDATE master_products SET active = false WHERE id = $1", [product]);
    else if (kind === "published") await database.pool.query("UPDATE master_products SET published = false WHERE id = $1", [product]);
    else if (kind === "category") await database.pool.query("UPDATE categories SET active = false WHERE id = $1", [categoryId]);
    const removed = (await pull(actor.headers, before.cursor)).json();
    expect(removed.changes).toEqual([{ packId: actor.packId, item: null, deletedAt: clock.now().toISOString() }]);
    expect((await pull(actor.headers, before.cursor)).json()).toEqual(removed);
    await database.pool.query("UPDATE packs SET active = true WHERE id = $1", [actor.packId]);
    await database.pool.query("UPDATE master_products SET active = true, published = true WHERE id = $1", [product]);
    await database.pool.query("UPDATE categories SET active = true WHERE id = $1 OR id = (SELECT parent_id FROM categories WHERE id = $1)", [categoryId]);
    const restored = (await pull(actor.headers, removed.cursor)).json();
    expect(restored.changes[0]).toMatchObject({ packId: actor.packId, deletedAt: null, item: { packId: actor.packId } });
  });
  it("scopes cursors to verified shop access and supports Staff and Suspended shops", async () => {
    const actor = await listed(), other = await shop("live", "other@example.com");
    const first = (await pull(actor.headers)).json();
    expect((await pull(other.headers, first.cursor)).statusCode).toBe(400);
    expect((await pull(actor.headers, `${actor.shopId}:999`)).statusCode).toBe(400);
    expect((await pull(actor.headers, "invalid")).statusCode).toBe(400);
    const staff = await owner("staff@example.com");
    await database.pool.query("INSERT INTO shop_members VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    expect((await pull(staff.headers)).json()).toEqual(first);
    await database.pool.query("UPDATE shops SET state = 'suspended' WHERE id = $1", [actor.shopId]);
    expect((await pull(staff.headers, first.cursor)).json().state).toBe("suspended");
    await database.pool.query("DELETE FROM shop_members WHERE account_id = $1", [staff.id]);
    expect((await pull(staff.headers, first.cursor)).statusCode).toBe(404);
    await database.pool.query("UPDATE shops SET state = 'approved' WHERE id = $1", [actor.shopId]);
    expect((await pull(actor.headers)).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/v1/sync/changes" })).statusCode).toBe(401);
  });
  it("does not skip a catalog commit crossing a cursor boundary, and serializes competing pulls", async () => {
    const actor = await listed();
    const initial = (await pull(actor.headers)).json();
    const writer = await database.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE master_products SET name = 'Late commit' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [actor.packId]);
      await database.pool.query("UPDATE shop_listings SET out_of_stock = true WHERE shop_id = $1", [actor.shopId]);
      const earlier = (await pull(actor.headers, initial.cursor)).json();
      expect(earlier.changes[0].item).toMatchObject({ outOfStock: true });
      expect(earlier.changes[0].item.name).not.toBe("Late commit");
      await writer.query("COMMIT");
      const [a, b] = await Promise.all([pull(actor.headers, earlier.cursor), pull(actor.headers, earlier.cursor)]);
      expect(a.json()).toEqual(b.json());
      expect(a.json().changes[0].item.name).toBe("Late commit");
      expect((await pull(actor.headers, a.json().cursor)).json().changes).toEqual([]);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });
});

it("keeps real-server pulls atomic across SQLite restart, disk interruption and pending writes", async () => {
  const { openingStockQueue } = await import(new URL("../../shopkeeper/src/lib/opening-stock-queue.ts", import.meta.url).href);
  const { adapter } = await import(new URL("../../shopkeeper/test/stock-database-fixture.ts", import.meta.url).href);
  const actor = await shop("live");
  await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
  const directory = mkdtempSync(join(tmpdir(), "ygo-pull-")), filename = join(directory, "stock.db");
  let db = new DatabaseSync(filename);
  try {
    let queue = openingStockQueue(adapter(db), randomUUID, () => clock.now());
    const pull = async (since?: string) => (await app.inject({ method: "GET", url: `/v1/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`, headers: actor.headers })).json();
    queue.cache.apply(await pull());
    const cursor = queue.cache.cursor(actor.shopId);
    queue.saveFlag(actor.shopId, actor.packId, true);
    const original = queue.batch(actor.shopId).actions[0];
    await database.pool.query("UPDATE master_products SET name = 'New name' WHERE id = (SELECT product_id FROM packs WHERE id = $1)", [actor.packId]);
    const page = await pull(cursor);
    db.exec("CREATE TRIGGER interrupted BEFORE UPDATE ON stock_cache_shops BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    expect(() => queue.cache.apply(page, cursor)).toThrow("interrupted");
    expect(queue.cache.cursor(actor.shopId)).toBe(cursor);
    db.close(); db = new DatabaseSync(filename); queue = openingStockQueue(adapter(db), randomUUID, () => clock.now());
    db.exec("DROP TRIGGER interrupted");
    queue.cache.apply(await pull(queue.cache.cursor(actor.shopId)), cursor);
    expect(queue.cache.read(actor.shopId)?.items[0]?.name).toBe("New name");
    expect(queue.flag(actor.shopId, actor.packId)?.action).toEqual(original);
    const batch = queue.batch(actor.shopId);
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: actor.headers, payload: batch });
    queue.acknowledge(batch, response.json());
    const next = queue.cache.cursor(actor.shopId);
    queue.cache.apply(await pull(next), next);
    expect(queue.cache.read(actor.shopId)?.items[0]?.outOfStock).toBe(true);
    expect(queue.count()).toBe(0);
    await database.pool.query("UPDATE packs SET active = false WHERE id = $1", [actor.packId]);
    const last = queue.cache.cursor(actor.shopId);
    queue.cache.apply(await pull(last), last);
    expect(queue.cache.read(actor.shopId)?.items).toEqual([]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("opening-stock correction (#452)", () => {
  async function recorded(quantity = "10") {
    const actor = await shop("live");
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const post = (path: string, body: object, headers = actor.headers) => app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/${path}`, headers, payload: body });
    const correct = (quantity: string, clientId = randomUUID()) => post("opening-stock-correction", { quantity, clientId });
    const item = async () => (await app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: actor.headers })).json().items[0];
    const movements = async () => (await database.pool.query("SELECT kind, quantity::text FROM stock_movements ORDER BY created_at, id")).rows;
    if (quantity) expect((await post("opening-stock", { quantity, clientId: randomUUID() })).statusCode).toBe(201);
    return { actor, post, correct, item, movements };
  }

  it("appends a signed movement of the difference, keeps the opening row and answers the corrected total", async () => {
    const { correct, item, movements } = await recorded();
    const down = await correct("8");
    expect(down.statusCode).toBe(201);
    expect(down.json()).toMatchObject({ quantity: "8.000" });
    expect(await item()).toMatchObject({ stock: "8.000", openingStock: "8.000", openingStockRecorded: true });
    expect((await correct("12.5")).json()).toMatchObject({ quantity: "12.500" });
    expect((await correct("0")).json()).toMatchObject({ quantity: "0.000" });
    expect(await item()).toMatchObject({ stock: "0.000", openingStock: "0.000" });
    expect(await movements()).toEqual([
      { kind: "opening", quantity: "10.000" }, { kind: "opening_correction", quantity: "-2.000" },
      { kind: "opening_correction", quantity: "4.500" }, { kind: "opening_correction", quantity: "-12.500" },
    ]);
    // Only a correction may go negative, and a typed total never does.
    await expect(database.pool.query("UPDATE stock_movements SET quantity = -1")).rejects.toThrow("append-only");
    await expect(database.pool.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
      SELECT listing_id, actor_id, gen_random_uuid(), 'opening', -1 FROM stock_movements LIMIT 1`)).rejects.toThrow("stock_movements_quantity_valid");
    expect((await correct("-1")).statusCode).toBe(400);
  });

  it("refuses a correction with no opening to correct, a fractional count of pieces, Staff and another shop", async () => {
    const { actor, correct, post } = await recorded("");
    expect((await correct("5")).json()).toEqual({ error: { code: "OPENING_STOCK_NOT_RECORDED" } });
    await database.pool.query("UPDATE master_products SET base_unit = 'each', classification = 'counted'");
    await post("opening-stock", { quantity: "3", clientId: randomUUID() });
    expect((await correct("2.5")).statusCode).toBe(400);
    const staff = await owner("staff@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    expect((await post("opening-stock-correction", { quantity: "2", clientId: randomUUID() }, staff.headers)).statusCode).toBe(404);
    const other = await shop("live", "other@example.com");
    const crossed = await app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock-correction`, headers: other.headers, payload: { quantity: "2", clientId: randomUUID() } });
    expect(crossed.statusCode).toBe(404);
  });

  it("answers a retry of the same correction without a second movement", async () => {
    const { correct, movements } = await recorded();
    const clientId = randomUUID();
    const first = await correct("7", clientId);
    const retry = await correct("7", clientId);
    expect([first.statusCode, retry.statusCode]).toEqual([201, 200]);
    expect(retry.json()).toEqual(first.json());
    expect(await movements()).toHaveLength(2);
    expect((await correct("7", clientId)).json()).toEqual(first.json());
  });

  it("refuses the same id with a different corrected total, even after a later correction", async () => {
    const { correct, movements } = await recorded();
    const clientId = randomUUID();
    expect((await correct("7", clientId)).statusCode).toBe(201);
    const changed = await correct("9", clientId);
    expect(changed.statusCode).toBe(400);
    expect(await movements()).toHaveLength(2);
    expect((await correct("4")).statusCode).toBe(201);
    expect((await correct("7.0", clientId)).statusCode).toBe(200);
    expect((await correct("9", clientId)).statusCode).toBe(400);
    expect(await movements()).toHaveLength(3);
  });

  it("serializes two corrections: each is worked out against the latest committed total and the last one applied wins", async () => {
    const { correct, item, movements } = await recorded();
    const hold = await database.pool.connect();
    let late: ReturnType<typeof correct>;
    let early: ReturnType<typeof correct>;
    try {
      await hold.query("BEGIN");
      await hold.query("SELECT id FROM shop_listings FOR UPDATE");
      early = correct("6");
      late = correct("9");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await hold.query("COMMIT");
    } finally { hold.release(); }
    const answers = (await Promise.all([early, late])).map((answer) => answer.json().quantity as string);
    expect(answers.sort()).toEqual(["6.000", "9.000"]);
    const rows = await movements();
    const total = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(rows.map((row) => row.kind)).toEqual(["opening", "opening_correction", "opening_correction"]);
    expect([6, 9]).toContain(total);
    expect(Number((await item()).openingStock)).toBe(total);
    // Whichever applied last left exactly its own target as the opening total.
    expect(answers.map(Number)).toContain(total);
  });

  it("changes only the opening count when orders already hold stock, even below what is held", async () => {
    const { actor, correct, item } = await recorded();
    const customer = await owner("customer@example.com");
    const version = (await database.pool.query<{ version: string }>(
      "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', now()) RETURNING version", [customer.id])).rows[0]?.version;
    await database.pool.query(
      `WITH placed AS (INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, address_label, address_flat, address_pincode,
          address_point, product_value, delivery_fee, total, rate_card_version, quote)
        SELECT $1, $2, 'accepted', now(), now(), 'home', '1', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 60, 0, 60,
          $3, '{}'::jsonb RETURNING id)
       INSERT INTO order_lines (order_id, position, listing_id, name, baseUnit_placeholder, pack_quantity, count, unit_price, line_total, stock_quantity)
       SELECT id, 0, (SELECT id FROM shop_listings WHERE shop_id = $2), 'Rice', 'kg', 1, 4, 15, 60, 4 FROM placed`.replace("baseUnit_placeholder", "base_unit"),
      [customer.id, actor.shopId, version]);
    expect(await item()).toMatchObject({ stock: "6.000", held: "4.000", openingStock: "10.000" });
    expect((await correct("12")).statusCode).toBe(201);
    expect(await item()).toMatchObject({ stock: "8.000", held: "4.000", openingStock: "12.000" });
    expect((await correct("3")).statusCode).toBe(201);
    expect(await item()).toMatchObject({ stock: "-1.000", held: "4.000", openingStock: "3.000" });
  });
});

describe("opening-stock correction sync (#452)", () => {
  it("applies in order after the opening, replays a lost response once, and rejects a correction with no opening", async () => {
    const actor = await shop("live");
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const deviceId = randomUUID();
    const action = (sequence: number, type: string, quantity: string) => ({ id: randomUUID(), sequence, shopId: actor.shopId, type,
      payload: { packId: actor.packId, quantity }, createdAt: clock.now().toISOString(), clockSuspect: false });
    const send = (actions: object[]) => app.inject({ method: "POST", url: "/v1/sync/actions", headers: actor.headers,
      payload: { deviceId, sentAt: clock.now().toISOString(), actions } });
    const early = action(1, "opening_stock_correction", "4");
    expect((await send([early])).json().results[0]).toMatchObject({ status: "rejected", code: "OPENING_STOCK_NOT_RECORDED" });
    const opening = action(2, "opening_stock", "10");
    const fix = action(3, "opening_stock_correction", "7.5");
    const answer = await send([opening, fix]);
    expect(answer.json().results.map((row: { status: string }) => row.status)).toEqual(["applied", "applied"]);
    expect(answer.json().results[1].result).toMatchObject({ quantity: "7.500" });
    expect((await send([fix])).json()).toEqual({ results: [answer.json().results[1]] });
    expect((await database.pool.query("SELECT kind, quantity::text FROM stock_movements ORDER BY stock_movements.quantity DESC")).rows).toEqual([
      { kind: "opening", quantity: "10.000" }, { kind: "opening_correction", quantity: "-2.500" }]);
    const staff = await owner("staff2@example.com");
    await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, actor.shopId]);
    const refused = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: staff.headers,
      payload: { deviceId: randomUUID(), sentAt: clock.now().toISOString(), actions: [action(1, "opening_stock_correction", "1")] } });
    expect(refused.statusCode).toBe(404);
  });

  it("judges a retry by its stored target when two corrections share one batch", async () => {
    const actor = await shop("live");
    await app.inject({ method: "PUT", url: `/v1/me/shop-listings/${actor.packId}`, headers: actor.headers, payload: listingBody });
    const action = (sequence: number, type: string, quantity: string) => ({ id: randomUUID(), sequence, shopId: actor.shopId, type,
      payload: { packId: actor.packId, quantity }, createdAt: clock.now().toISOString(), clockSuspect: false });
    const [opening, first, second] = [action(1, "opening_stock", "10"), action(2, "opening_stock_correction", "7"), action(3, "opening_stock_correction", "9")];
    const sent = await app.inject({ method: "POST", url: "/v1/sync/actions", headers: actor.headers,
      payload: { deviceId: randomUUID(), sentAt: clock.now().toISOString(), actions: [opening, first, second] } });
    expect(sent.json().results.map((row: { status: string }) => row.status)).toEqual(["applied", "applied", "applied"]);
    const stamps = await database.pool.query("SELECT DISTINCT created_at FROM stock_movements");
    expect(stamps.rows).toHaveLength(1);
    const retry = (id: string, quantity: string) => app.inject({ method: "POST", url: `/v1/me/shop-listings/${actor.packId}/opening-stock-correction`,
      headers: actor.headers, payload: { quantity, clientId: id } });
    expect(sent.json().results.slice(1).map((row: { result: { quantity: string } }) => row.result.quantity)).toEqual(["7.000", "9.000"]);
    // A retry answers with the total it set, not the total after the later correction (#460).
    const again = await retry(first.id, "7");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ quantity: "7.000" });
    expect((await retry(second.id, "9")).statusCode).toBe(200);
    expect((await retry(first.id, "9")).statusCode).toBe(400);
    expect((await retry(second.id, "7")).statusCode).toBe(400);
    expect((await database.pool.query("SELECT quantity::text, target_quantity::text AS target FROM stock_movements WHERE kind = 'opening_correction' ORDER BY target_quantity")).rows)
      .toEqual([{ quantity: "-3.000", target: "7.000" }, { quantity: "2.000", target: "9.000" }]);
  });
});
