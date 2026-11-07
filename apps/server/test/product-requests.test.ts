import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createProductImageStorage } from "../src/adapters/product-images";
import { createLocalMailer } from "../src/adapters/mailer";
import { createLocalPushSender } from "../src/adapters/push-sender";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { sendDuePushes } from "../src/notifications";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
const query = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => (await database.pool.query<T>(sql, values)).rows;

beforeEach(async () => {
  admin = undefined;
  name = `ygo_product_requests_${randomUUID().replaceAll("-", "")}`;
  database = connectDatabase((await createTestDatabase(name)).href);
  await bootstrapAdmin(database.pool, { email: "admin@example.com", name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  const productImages = createProductImageStorage({ client: { async deleteObject() {}, async putObject() {} }, bucket: "test", imageBaseUrl: "https://images.ygo.example" });
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, productImages });
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function signIn(email: string, base: string) {
  await app.inject({ method: "POST", url: `${base}/code`, payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: `${base}/verify`, payload: { email, code } })).json();
  return { id: signed.account?.id as string | undefined, headers: { authorization: `Bearer ${signed.accessToken as string}`, "x-ygo-app-name": "shopkeeper", "x-ygo-app-version": "1.0.0" } };
}
const phone = async (email: string) => { const who = await signIn(email, "/v1/auth"); return { id: who.id as string, headers: who.headers }; };
let admin: Record<string, string> | undefined;
const adminHeaders = async () => (admin ??= (await signIn("admin@example.com", "/v1/admin/auth")).headers);

/** A shop with an Owner and a Staff member, a category to request into, and one catalog pack of rice the shop does not list yet. */
async function world(state = "live") {
  const owner = await phone("owner@example.com");
  const staff = await phone("staff@example.com");
  const shopId = randomUUID();
  await query(`INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan, fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
    VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [shopId, state]);
  await query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'staff')", [owner.id, staff.id, shopId]);
  const categoryId = (await query<{ id: string }>("INSERT INTO categories (name) VALUES ('Staples') RETURNING id"))[0]?.id as string;
  const catalogPack = async (quantity = "1", unit = "kg") => {
    const productId = (await query<{ id: string }>(
      `INSERT INTO master_products (name, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
       VALUES ($2, $1, $3, $4, 'a', 'b', 'c', true) RETURNING id`, [categoryId, `Rice ${randomUUID()}`, unit, unit === "each" ? "counted" : "measured"]))[0]?.id;
    return (await query<{ id: string }>("INSERT INTO packs (product_id, quantity) VALUES ($1, $2) RETURNING id", [productId, quantity]))[0]?.id as string;
  };
  const request = (headers: Record<string, string>, over: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/shop/product-requests", headers,
    payload: { clientId: randomUUID(), name: "Jaggery block", categoryId, baseUnit: "kg", packQuantity: "0.5", counterPrice: "40", mrp: "45", ...over } });
  const created = async (over: Record<string, unknown> = {}) => (await request(owner.headers, over)).json() as { id: string };
  const bill = async (packId: string, count = 1, headers = owner.headers) => {
    const response = await app.inject({ method: "POST", url: "/v1/sync/actions", headers, payload: { deviceId: randomUUID(), sentAt: clock.now().toISOString(),
      actions: [{ id: randomUUID(), sequence: 1, shopId, type: "counter_bill", createdAt: clock.now().toISOString(), clockSuspect: false,
        payload: { lines: [{ packId, count, unitPrice: "40" }], total: String(40 * count), payment: "cash" } }] } });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.json().results[0] as { status: string; result: { heldReason: string | null } };
  };
  const packOf = async (requestId: string) => (await query<{ id: string }>("SELECT pack_id AS id FROM product_requests WHERE id = $1", [requestId]))[0]?.id as string;
  const pull = async (headers = owner.headers) => (await app.inject({ method: "GET", url: "/v1/sync/changes", headers })).json() as { changes: Array<{ packId: string; item: { quantity: string } | null }> };
  const stockOf = async (packId: string) => (await query<{ n: string }>("SELECT COALESCE(sum(sm.quantity), 0)::text AS n FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id WHERE sl.pack_id = $1", [packId]))[0]?.n;
  const give = (requestId: string) => query("UPDATE master_products SET image_256_key = 'a', image_512_key = 'b', image_1024_key = 'c' WHERE id = (SELECT product_id FROM product_requests WHERE id = $1)", [requestId]);
  const act = async (id: string, action: "approve" | "map" | "reject", payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/admin/product-requests/${id}/${action}`, headers: await adminHeaders(), ...(payload ? { payload } : {}) });
  return { owner, staff, shopId, categoryId, catalogPack, request, created, bill, packOf, pull, stockOf, give, act };
}

describe("shop product requests (#62, CAT-3)", () => {
  it("makes a temporary unpublished product the shop can bill at once and no customer sees", async () => {
    const w = await world();
    const response = await w.request(w.owner.headers);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Jaggery block", status: "pending", reason: null, counterPrice: "40.00", mrp: "45.00", packQuantity: "0.500" });
    const packId = await w.packOf(response.json().id);
    expect(await query("SELECT published, requested_by_shop_id FROM master_products WHERE requested_by_shop_id IS NOT NULL")).toEqual([{ published: false, requested_by_shop_id: w.shopId }]);
    // Not in the Owner's pick-from-catalog list, and not what a customer's feed reads.
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-listings", headers: w.owner.headers })).json().items.map((item: { packId: string }) => item.packId)).not.toContain(packId);
    expect(await query("SELECT 1 FROM shop_listings listing JOIN packs pack ON pack.id = listing.pack_id JOIN master_products product ON product.id = pack.product_id WHERE listing.available AND product.published")).toHaveLength(0);
    // The phone's next pull carries it, and a counter bill for it is accepted.
    expect((await w.pull()).changes.map((change) => change.packId)).toContain(packId);
    expect((await w.bill(packId, 2)).result.heldReason).toBeNull();
    expect(await w.stockOf(packId)).toBe("-1.000");
  });

  it("treats a retried request as the first, and refuses a second shop product with the same name or barcode", async () => {
    const w = await world();
    const clientId = randomUUID();
    const first = await w.request(w.owner.headers, { clientId, barcode: "12345678" });
    const again = await w.request(w.owner.headers, { clientId, barcode: "12345678" });
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json().id).toBe(first.json().id);
    expect(await query("SELECT 1 FROM product_requests")).toHaveLength(1);
    expect((await w.request(w.owner.headers, { name: "jaggery BLOCK" })).json()).toMatchObject({ error: { code: "PRODUCT_NAME_IN_USE" } });
    expect((await w.request(w.owner.headers, { name: "Other", barcode: "12345678" })).json()).toMatchObject({ error: { code: "BARCODE_IN_USE" } });
    expect(await query("SELECT 1 FROM product_requests")).toHaveLength(1);
    expect(await query("SELECT 1 FROM master_products")).toHaveLength(1);
  });

  it("checks the request like the catalog does, and lets only an Owner of a shop that can sell make one", async () => {
    const w = await world();
    const bad = async (over: Record<string, unknown>) => (await w.request(w.owner.headers, over)).statusCode;
    expect(await bad({ counterPrice: "46" })).toBe(400);
    expect(await bad({ baseUnit: "each", packQuantity: "1.5" })).toBe(400);
    expect(await bad({ packQuantity: "0" })).toBe(400);
    expect(await bad({ barcode: "123" })).toBe(400);
    expect(await bad({ categoryId: randomUUID() })).toBe(400);
    expect(await bad({ unknown: 1 })).toBe(400);
    expect((await w.request(w.staff.headers)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/shop/product-requests" })).statusCode).toBe(401);
    await query("UPDATE shops SET state = 'submitted'");
    expect((await w.request(w.owner.headers)).json()).toMatchObject({ error: { code: "SHOP_LISTING_NOT_READY" } });
    expect(await query("SELECT 1 FROM product_requests")).toHaveLength(0);
  });

  it("flags a denylisted word after normalizing, never blocks, and does not match inside a longer word", async () => {
    const w = await world();
    const flagged = async (over: Record<string, unknown>) => {
      const response = await w.request(w.owner.headers, over);
      expect(response.statusCode).toBe(201);
      return (await query<{ flagged: boolean }>("SELECT flagged FROM product_requests WHERE id = $1", [response.json().id]))[0]?.flagged;
    };
    expect(await flagged({ name: "Gold Flake CIGARETTE!" })).toBe(true);
    expect(await flagged({ name: "Fresh   pan-masala sachet" })).toBe(true);
    expect(await flagged({ name: "Cheap stuff", brand: "Vape King" })).toBe(true);
    expect(await flagged({ name: "Brumble cigarettes lighter" })).toBe(false);
    expect(await flagged({ name: "Sugar" })).toBe(false);
  });

  it("lists the shop's own requests with the categories it may use, and only to its Owner", async () => {
    const w = await world();
    await w.created();
    const list = (await app.inject({ method: "GET", url: "/v1/shop/product-requests", headers: w.owner.headers })).json();
    expect(list.requests).toHaveLength(1);
    expect(list.categories).toContainEqual({ id: w.categoryId, name: "Staples", parentName: null });
    expect((await app.inject({ method: "GET", url: "/v1/shop/product-requests", headers: w.staff.headers })).statusCode).toBe(404);
  });
});

describe("Admin product requests (#62, A11)", () => {
  it("is for Admin only and lists the flagged ones first", async () => {
    const w = await world();
    await w.created({ name: "Sugar" });
    await w.created({ name: "Beer can" });
    expect((await app.inject({ method: "GET", url: "/v1/admin/product-requests" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/admin/product-requests", headers: w.owner.headers })).statusCode).toBe(403);
    const list = (await app.inject({ method: "GET", url: "/v1/admin/product-requests", headers: await adminHeaders() })).json().requests;
    expect(list.map((row: { name: string; flagged: boolean }) => [row.name, row.flagged])).toEqual([["Beer can", true], ["Sugar", false]]);
    expect(list[0]).toMatchObject({ shop: { name: "Sai General Stores" }, categoryName: "Staples", hasImage: false, status: "pending" });
  });

  it("returns the first request to retries that arrive at the same moment, never a server error", async () => {
    const w = await world();
    const clientId = randomUUID();
    const answers = await Promise.all(Array.from({ length: 5 }, () => w.request(w.owner.headers, { clientId })));
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(answers.map((answer) => answer.json().id)).size).toBe(1);
    expect(await query("SELECT 1 FROM product_requests")).toHaveLength(1);
    expect(await query("SELECT 1 FROM master_products")).toHaveLength(1);
  });

  it("serializes a map and bills at the same moment: every sale is either moved with the stock or held", async () => {
    const w = await world();
    const id = (await w.created()).id;
    const temp = await w.packOf(id);
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${temp}/opening-stock`, headers: w.owner.headers, payload: { quantity: "10", clientId: randomUUID() } });
    const target = await w.catalogPack("0.5", "kg");
    const [mapped, ...bills] = await Promise.all([w.act(id, "map", { packId: target }), ...Array.from({ length: 4 }, () => w.bill(temp, 1))]);
    expect(mapped.statusCode).toBe(200);
    const sold = bills.filter((bill) => bill.result.heldReason === null).length;
    expect(bills.filter((bill) => bill.result.heldReason !== null).every((bill) => bill.result.heldReason === "not_listed")).toBe(true);
    // Nothing is lost or counted twice: the sales that landed before the move left less to move.
    expect(await w.stockOf(temp)).toBe("0.000");
    expect(Number(await w.stockOf(target))).toBe(10 - sold * 0.5);
  });

  it("refuses a manager of an Area, because the catalog is Admin's", async () => {
    const w = await world();
    const id = (await w.created()).id;
    const areaId = (await query<{ id: string }>("INSERT INTO accounts (email, name) VALUES ('manager@example.com', 'Ravi Patil') RETURNING id"))[0]?.id;
    await query("INSERT INTO area_manager_memberships (account_id) VALUES ($1)", [areaId]);
    const web = await signIn("manager@example.com", "/v1/admin/auth");
    expect((await app.inject({ method: "GET", url: "/v1/admin/product-requests", headers: web.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/admin/product-requests/${id}/reject`, headers: web.headers, payload: { reason: "No", excludedGood: false } })).statusCode).toBe(403);
    expect((await query<{ status: string }>("SELECT status FROM product_requests"))[0]?.status).toBe("pending");
  });

  it("approves only with the product's images, publishes it once, and tells the Owner and Staff", async () => {
    const w = await world();
    const id = (await w.created()).id;
    await query("UPDATE master_products SET image_256_key = NULL, image_512_key = NULL, image_1024_key = NULL WHERE requested_by_shop_id IS NOT NULL");
    expect((await w.act(id, "approve")).json()).toMatchObject({ error: { code: "PRODUCT_IMAGE_REQUIRED" } });
    expect((await query<{ published: boolean }>("SELECT published FROM master_products"))[0]?.published).toBe(false);
    await w.give(id);
    const approved = await w.act(id, "approve");
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", hasImage: true });
    expect((await query<{ published: boolean }>("SELECT published FROM master_products"))[0]?.published).toBe(true);
    expect((await w.act(id, "approve")).json()).toMatchObject({ error: { code: "PRODUCT_REQUEST_RESOLVED" } });
    expect((await w.act(id, "reject", { reason: "Late", excludedGood: true })).json()).toMatchObject({ error: { code: "PRODUCT_REQUEST_RESOLVED" } });
    expect(await query("SELECT 1 FROM shop_listings WHERE removed_from_counter")).toHaveLength(0);
    for (const who of [w.owner, w.staff]) {
      const { notifications } = (await app.inject({ method: "GET", url: "/v1/me/notifications", headers: who.headers })).json();
      expect(notifications).toMatchObject([{ kind: "product_request_approved", title: "Product approved", orderId: null }]);
    }
    expect(await query("SELECT 1 FROM notifications WHERE kind = 'product_request_approved'")).toHaveLength(2);
  });

  it("keeps a requested product unpublished when Admin adds its image, until approval", async () => {
    const w = await world();
    const id = (await w.created()).id;
    await query("UPDATE master_products SET image_256_key = NULL, image_512_key = NULL, image_1024_key = NULL WHERE requested_by_shop_id IS NOT NULL");
    const productId = (await query<{ id: string }>("SELECT product_id AS id FROM product_requests"))[0]?.id;
    const image = (await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
    expect((await app.inject({ method: "PATCH", url: `/v1/admin/products/${productId}`, headers: await adminHeaders(), payload: { image } })).statusCode).toBe(200);
    expect(await query("SELECT published, image_256_key IS NOT NULL AS imaged FROM master_products")).toEqual([{ published: false, imaged: true }]);
    expect((await w.act(id, "approve")).statusCode).toBe(200);
    expect((await query<{ published: boolean }>("SELECT published FROM master_products"))[0]?.published).toBe(true);
  });

  it("rejects an excluded good: it leaves the counter list for new bills and stock, and its history stays", async () => {
    const w = await world();
    const id = (await w.created({ name: "Loose cigarette" })).id;
    const packId = await w.packOf(id);
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${packId}/opening-stock`, headers: w.owner.headers, payload: { quantity: "5", clientId: randomUUID() } });
    expect((await w.bill(packId, 1)).result.heldReason).toBeNull();
    expect((await w.pull()).changes.find((change) => change.packId === packId)?.item?.quantity).toBe("4.500");
    const rejected = await w.act(id, "reject", { reason: "Excluded good: tobacco", excludedGood: true });
    expect(rejected.json()).toMatchObject({ status: "rejected", reason: "Excluded good: tobacco", excludedGood: true });
    expect((await w.bill(packId, 1)).result.heldReason).toBe("not_listed");
    expect((await app.inject({ method: "POST", url: `/v1/me/shop-listings/${packId}/opening-stock`, headers: w.owner.headers, payload: { quantity: "5", clientId: randomUUID() } })).statusCode).toBe(404);
    expect((await w.pull()).changes.find((change) => change.packId === packId)?.item).toBeNull();
    expect(await w.stockOf(packId)).toBe("4.500");
    expect(await query("SELECT 1 FROM counter_bill_lines WHERE pack_id = $1", [packId])).toHaveLength(2);
    expect((await w.act(id, "reject", { reason: "Again", excludedGood: true })).json()).toMatchObject({ error: { code: "PRODUCT_REQUEST_RESOLVED" } });
  });

  it("rejects for any other reason without taking the product off the counter, and tells the shop why", async () => {
    const w = await world();
    const id = (await w.created()).id;
    const packId = await w.packOf(id);
    expect((await w.act(id, "reject", { reason: "Photo unclear, ask again", excludedGood: false })).statusCode).toBe(200);
    expect((await w.bill(packId, 1)).result.heldReason).toBeNull();
    const { notifications } = (await app.inject({ method: "GET", url: "/v1/me/notifications", headers: w.staff.headers })).json();
    expect(notifications).toMatchObject([{ kind: "product_request_rejected", title: "Product rejected", body: "Jaggery block: Photo unclear, ask again" }]);
    expect((await w.act(id, "reject", { reason: " ", excludedGood: false })).statusCode).toBe(400);
  });

  it("maps to a catalog pack, moves the stock by paired movements and keeps every bill and movement", async () => {
    const w = await world();
    const id = (await w.created()).id;
    const temp = await w.packOf(id);
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${temp}/opening-stock`, headers: w.owner.headers, payload: { quantity: "10", clientId: randomUUID() } });
    await w.bill(temp, 3);
    const target = await w.catalogPack("0.5", "kg");
    await w.pull();
    const mapped = await w.act(id, "map", { packId: target });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.json()).toMatchObject({ status: "mapped", mappedTo: { packId: target } });
    expect(await w.stockOf(temp)).toBe("0.000");
    expect(await w.stockOf(target)).toBe("8.500");
    const movements = await query<{ kind: string; quantity: string }>("SELECT kind, quantity::text FROM stock_movements ORDER BY created_at, kind");
    expect(movements.map((row) => row.kind).sort()).toEqual(["opening", "sale", "transfer_in", "transfer_out"]);
    expect(await query("SELECT 1 FROM counter_bill_lines WHERE pack_id = $1", [temp])).toHaveLength(1);
    // The shop now bills the catalog pack; the temporary one is gone from the counter list.
    expect((await w.bill(target, 1)).result.heldReason).toBeNull();
    expect((await w.bill(temp, 1)).result.heldReason).toBe("not_listed");
    const changes = (await w.pull()).changes;
    expect(changes.find((change) => change.packId === temp)?.item).toBeNull();
    expect(changes.find((change) => change.packId === target)?.item?.quantity).toBe("8.000");
    expect(await query("SELECT 1 FROM notifications WHERE kind = 'product_request_approved' AND body LIKE '%matched%'")).toHaveLength(2);
  });

  it("refuses to map onto a pack the shop already lists, or of another unit, or an unknown one, and changes nothing", async () => {
    const w = await world();
    const id = (await w.created()).id;
    const temp = await w.packOf(id);
    await app.inject({ method: "POST", url: `/v1/me/shop-listings/${temp}/opening-stock`, headers: w.owner.headers, payload: { quantity: "10", clientId: randomUUID() } });
    const listed = await w.catalogPack("0.5", "kg");
    await query("INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) VALUES ($1, $2, 1, 1, 1)", [w.shopId, listed]);
    expect((await w.act(id, "map", { packId: listed })).json()).toMatchObject({ error: { code: "PACK_ALREADY_LISTED" } });
    expect((await w.act(id, "map", { packId: await w.catalogPack("2", "each") })).statusCode).toBe(400);
    expect((await w.act(id, "map", { packId: await w.catalogPack("1", "kg") })).statusCode).toBe(400);
    expect((await w.act(id, "map", { packId: await w.catalogPack("0.25", "kg") })).statusCode).toBe(400);
    expect((await w.act(id, "map", { packId: randomUUID() })).statusCode).toBe(404);
    expect((await query<{ status: string }>("SELECT status FROM product_requests"))[0]?.status).toBe("pending");
    expect(await w.stockOf(temp)).toBe("10.000");
    expect(await query("SELECT 1 FROM stock_movements WHERE kind LIKE 'transfer%'")).toHaveLength(0);
    expect(await query("SELECT 1 FROM notifications WHERE kind LIKE 'product_request%'")).toHaveLength(0);
  });

  it("sends the push to the Owner's and Staff's phones", async () => {
    const w = await world();
    for (const [who, token] of [[w.owner, "ExponentPushToken[owner]"], [w.staff, "ExponentPushToken[staff]"]] as const) {
      expect((await app.inject({ method: "PUT", url: "/v1/me/push-token", headers: who.headers, payload: { token } })).statusCode).toBe(204);
    }
    await w.act((await w.created()).id, "reject", { reason: "Not sold here", excludedGood: false });
    const push = createLocalPushSender();
    await sendDuePushes(database.pool, push, clock.now());
    expect(push.sent.map(({ to, title }) => [to, title]).sort()).toEqual([["ExponentPushToken[owner]", "Product rejected"], ["ExponentPushToken[staff]", "Product rejected"]]);
  });
});
