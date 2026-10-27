import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  name = `ygo_listings_${randomUUID().replaceAll("-", "")}`;
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

async function owner() {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email: "owner@example.com" } });
  const code = mailer.sent.findLast((sent) => sent.to === "owner@example.com")?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: "owner@example.com", code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

async function shop(state = "approved") {
  const actor = await owner();
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
     VALUES ('Rice', $1, 'kg', 'measured', 'image256', 'image512', 'image1024', true) RETURNING id`,
    [categoryId],
  )).rows[0]?.id as string;
  const packId = (await database.pool.query("INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, '1', '12345678') RETURNING id", [productId])).rows[0]?.id as string;
  return { ...actor, shopId, packId };
}

const listingBody = {
  onlinePrice: "20.50", counterPrice: "21", mrp: "25", lowStockLevel: "1.000",
  minimumOrderQuantity: "0.25", quantityStep: "0.05",
  quantityOptions: [{ quantity: "2", price: "38" }],
};

describe("Owner shop listings and opening stock", () => {
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
    expect(saved.json()).toMatchObject({ listing: { onlinePrice: "20.50", counterPrice: "21.00", mrp: "25.00", minimumOrderQuantity: "0.250", quantityStep: "0.050", quantityOptions: [{ quantity: "2.000", price: "38.00" }] } });
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
  });
});
