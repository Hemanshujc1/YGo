import type { AdminProductRequest, CreateProductRequestBody, ProductRequest, ProductRequestsResponse } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";
import { notifyShop } from "./notifications";

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const requestSql = `SELECT r.id, p.name, p.brand, p.base_unit AS "baseUnit", pk.quantity::text AS "packQuantity", sl.counter_price::text AS "counterPrice",
  sl.mrp::text AS mrp, r.status, r.reason, ${iso("r.created_at")} AS "createdAt"
  FROM product_requests r JOIN master_products p ON p.id = r.product_id JOIN packs pk ON pk.id = r.pack_id JOIN shop_listings sl ON sl.id = r.listing_id`;

/** The shop's requests, newest first, and the categories a request may name: active ones with no active child (CAT-5). */
export async function listShopRequests(db: Pool | PoolClient, shopId: string): Promise<ProductRequestsResponse> {
  const [requests, categories] = await Promise.all([
    db.query<ProductRequest>(`${requestSql} WHERE r.shop_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [shopId]),
    db.query<ProductRequestsResponse["categories"][number]>(
      `SELECT c.id, c.name, parent.name AS "parentName" FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id
       WHERE c.active AND COALESCE(parent.active, true) AND NOT EXISTS (SELECT 1 FROM categories child WHERE child.parent_id = c.id AND child.active)
       ORDER BY lower(COALESCE(parent.name, c.name)), lower(c.name)`),
  ]);
  return { requests: requests.rows, categories: categories.rows };
}

/**
 * A request at the counter at once (CAT-3): a temporary product, pack and listing that only this shop can bill, because the product is
 * not published. A retry with the same `clientId` returns the first request. The denylist only flags (CAT-8): Admin looks, nothing is refused.
 * Null when the category is not one a product may have. A taken name or barcode throws its unique-index error for the route to name.
 */
export async function createProductRequest(client: PoolClient, shopId: string, accountId: string, body: CreateProductRequestBody): Promise<{ request: ProductRequest; created: boolean } | null> {
  // Retries of one request run one after another, so the later one finds the first instead of failing on its product's name.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`product_request:${shopId}:${body.clientId}`]);
  const found = await client.query<ProductRequest>(`${requestSql} WHERE r.shop_id = $1 AND r.client_id = $2`, [shopId, body.clientId]);
  if (found.rows[0]) return { request: found.rows[0], created: false };
  const category = await client.query(
    `SELECT 1 FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id
     WHERE c.id = $1 AND c.active AND COALESCE(parent.active, true) AND NOT EXISTS (SELECT 1 FROM categories child WHERE child.parent_id = c.id AND child.active)`, [body.categoryId]);
  if (!category.rowCount) return null;
  const { rows: [product] } = await client.query<{ id: string }>(
    `INSERT INTO master_products (name, brand, category_id, base_unit, classification, requested_by_shop_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [body.name, body.brand ?? null, body.categoryId, body.baseUnit, body.baseUnit === "each" ? "counted" : "measured", shopId]);
  const { rows: [pack] } = await client.query<{ id: string }>("INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, $2, $3) RETURNING id", [product?.id, body.packQuantity, body.barcode ?? null]);
  // Counter only: not available online until the Owner switches it on after approval, when a measured product also needs its minimum and step.
  const { rows: [listing] } = await client.query<{ id: string }>(
    "INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, available) VALUES ($1, $2, $3, $3, $4, false) RETURNING id", [shopId, pack?.id, body.counterPrice, body.mrp]);
  const { rows: [created] } = await client.query<{ id: string }>(
    `INSERT INTO product_requests (shop_id, requested_by, client_id, product_id, pack_id, listing_id, flagged)
     VALUES ($1, $2, $3, $4, $5, $6, EXISTS (SELECT 1 FROM denylist_words d
       WHERE ' ' || trim(regexp_replace(lower($7::text), '[^a-z0-9]+', ' ', 'g')) || ' ' LIKE '% ' || d.word || ' %')) RETURNING id`,
    [shopId, accountId, body.clientId, product?.id, pack?.id, listing?.id, `${body.name} ${body.brand ?? ""}`]);
  const { rows: [request] } = await client.query<ProductRequest>(`${requestSql} WHERE r.id = $1`, [created?.id]);
  if (!request) throw new Error("A saved product request is missing");
  return { request, created: true };
}

const adminSql = `SELECT r.id, p.name, p.brand, p.base_unit AS "baseUnit", pk.quantity::text AS "packQuantity", sl.counter_price::text AS "counterPrice",
  sl.mrp::text AS mrp, r.status, r.reason, ${iso("r.created_at")} AS "createdAt", p.id AS "productId",
  json_build_object('id', s.id, 'name', s.shop_name) AS shop, c.name AS "categoryName", pk.barcode, r.flagged,
  (p.image_256_key IS NOT NULL AND p.image_512_key IS NOT NULL AND p.image_1024_key IS NOT NULL) AS "hasImage", r.excluded_good AS "excludedGood",
  CASE WHEN r.mapped_pack_id IS NULL THEN NULL ELSE json_build_object('packId', r.mapped_pack_id, 'name', tp.name || ' ' || tk.quantity::text || ' ' || tp.base_unit) END AS "mappedTo"
  FROM product_requests r JOIN master_products p ON p.id = r.product_id JOIN packs pk ON pk.id = r.pack_id JOIN shop_listings sl ON sl.id = r.listing_id
  JOIN shops s ON s.id = r.shop_id JOIN categories c ON c.id = p.category_id
  LEFT JOIN packs tk ON tk.id = r.mapped_pack_id LEFT JOIN master_products tp ON tp.id = tk.product_id`;

/** A11: the queue, oldest first so none waits behind newer ones; flagged ones lead. `resolved` is the answered ones, newest first. */
export async function listAdminRequests(db: Pool, status: "pending" | "resolved"): Promise<AdminProductRequest[]> {
  const order = status === "pending" ? "r.flagged DESC, r.created_at, r.id" : "r.resolved_at DESC, r.id DESC";
  const { rows } = await db.query<AdminProductRequest>(`${adminSql} WHERE (r.status = 'pending') = ($1 = 'pending') ORDER BY ${order} LIMIT 200`, [status]);
  return rows;
}

type Locked = { id: string; shopId: string; productId: string; packId: string; listingId: string; name: string; hasImage: boolean; baseUnit: string; status: string; counterPrice: string; mrp: string };
export type Outcome = { code: "NOT_FOUND" | "PRODUCT_REQUEST_RESOLVED" | "PRODUCT_IMAGE_REQUIRED" | "PACK_ALREADY_LISTED" | "VALIDATION_FAILED" } | { request: AdminProductRequest };

async function lockPending(client: PoolClient, id: string): Promise<Locked | { code: "NOT_FOUND" | "PRODUCT_REQUEST_RESOLVED" }> {
  const { rows: [row] } = await client.query<Locked>(
    `SELECT r.id, r.shop_id AS "shopId", r.product_id AS "productId", r.pack_id AS "packId", r.listing_id AS "listingId", p.name, r.status, p.base_unit AS "baseUnit",
       (p.image_256_key IS NOT NULL AND p.image_512_key IS NOT NULL AND p.image_1024_key IS NOT NULL) AS "hasImage", sl.counter_price::text AS "counterPrice", sl.mrp::text AS mrp
     FROM product_requests r JOIN master_products p ON p.id = r.product_id JOIN shop_listings sl ON sl.id = r.listing_id WHERE r.id = $1 FOR UPDATE OF r`, [id]);
  if (!row) return { code: "NOT_FOUND" };
  return row.status === "pending" ? row : { code: "PRODUCT_REQUEST_RESOLVED" };
}

async function finish(client: PoolClient, request: Locked, adminId: string, at: Date, action: string, status: "approved" | "mapped" | "rejected", detail: { reason?: string; excludedGood?: boolean; packId?: string },
  words: { title: string; body: string }): Promise<Outcome> {
  await client.query(
    `UPDATE product_requests SET status = $2, reason = $3, excluded_good = $4, mapped_pack_id = $5, resolved_by = $6, resolved_at = $7 WHERE id = $1`,
    [request.id, status, detail.reason ?? null, detail.excludedGood ?? false, detail.packId ?? null, adminId, at]);
  await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'product_request', $4)",
    [adminId, action, request.id, detail.reason ?? `Product request ${status}`]);
  await notifyShop(client, request.shopId, status === "rejected" ? "product_request_rejected" : "product_request_approved", words.title, words.body, at);
  const { rows: [saved] } = await client.query<AdminProductRequest>(`${adminSql} WHERE r.id = $1`, [request.id]);
  if (!saved) throw new Error("A resolved product request is missing");
  return { request: saved };
}

/**
 * Counter bills sync under the shop's row lock (routes/sync.ts), so taking it here too puts each sale wholly before a map or removal, or
 * after it, when it is held as not listed. A move of the stock then never misses a sale that was billed at the same moment.
 */
const lockShop = (client: PoolClient, request: Locked) => client.query("SELECT 1 FROM shops WHERE id = $1 FOR UPDATE", [request.shopId]);

/** Publishes the temporary product, so customers see it. It needs its three image sizes first, which Admin adds on the product. */
export async function approveProductRequest(client: PoolClient, id: string, adminId: string, at: Date): Promise<Outcome> {
  const request = await lockPending(client, id);
  if ("code" in request) return request;
  if (!request.hasImage) return { code: "PRODUCT_IMAGE_REQUIRED" };
  await client.query("UPDATE master_products SET published = true WHERE id = $1", [request.productId]);
  return finish(client, request, adminId, at, "product_request.approve", "approved", {}, { title: "Product approved", body: `${request.name} is now in the YGo catalog.` });
}

/**
 * Points the shop at a catalog pack instead (CAT-3). The shop's current stock moves to its new listing of that pack through two
 * paired movements, and the temporary listing leaves the counter list; its bills and earlier movements are untouched. Refused when
 * the shop already lists that pack, so no two stocks are merged.
 */
export async function mapProductRequest(client: PoolClient, id: string, packId: string, adminId: string, at: Date): Promise<Outcome> {
  const request = await lockPending(client, id);
  if ("code" in request) return request;
  const { rows: [target] } = await client.query<{ name: string; baseUnit: string; sameSize: boolean }>(
    `SELECT p.name || ' ' || pk.quantity::text || ' ' || p.base_unit AS name, p.base_unit AS "baseUnit",
       pk.quantity = (SELECT quantity FROM packs WHERE id = $2) AS "sameSize" FROM packs pk JOIN master_products p ON p.id = pk.product_id
     JOIN categories c ON c.id = p.category_id LEFT JOIN categories parent ON parent.id = c.parent_id
     WHERE pk.id = $1 AND pk.active AND p.active AND p.published AND c.active AND COALESCE(parent.active, true)`, [packId, request.packId]);
  if (!target) return { code: "NOT_FOUND" };
  // The stock, price and MRP move as they are, so the pack must be the same size: a different size would need a converted price and count.
  if (target.baseUnit !== request.baseUnit || !target.sameSize) return { code: "VALIDATION_FAILED" };
  await lockShop(client, request);
  await client.query("SELECT 1 FROM shop_listings WHERE id = $1 FOR UPDATE", [request.listingId]);
  // The unique index settles a pack the Owner listed a moment ago: no row back means the shop already lists it.
  const { rows: [listing] } = await client.query<{ id: string }>(
    `INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, available) VALUES ($1, $2, $3, $3, $4, false)
     ON CONFLICT (shop_id, pack_id) DO NOTHING RETURNING id`, [request.shopId, packId, request.counterPrice, request.mrp]);
  if (!listing) return { code: "PACK_ALREADY_LISTED" };
  const { rows: [stock] } = await client.query<{ onHand: string }>('SELECT COALESCE(sum(quantity), 0)::text AS "onHand" FROM stock_movements WHERE listing_id = $1', [request.listingId]);
  const onHand = stock?.onHand ?? "0";
  if (Number(onHand) !== 0) {
    await client.query(
      `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity, created_at)
       VALUES ($1, $3, gen_random_uuid(), 'transfer_out', -$4::numeric, $5), ($2, $3, gen_random_uuid(), 'transfer_in', $4::numeric, $5)`,
      [request.listingId, listing?.id, adminId, onHand, at]);
  }
  await client.query("UPDATE shop_listings SET removed_from_counter = true, available = false, updated_at = $2 WHERE id = $1", [request.listingId, at]);
  return finish(client, request, adminId, at, "product_request.map", "mapped", { packId }, { title: "Product approved", body: `${request.name} was matched to ${target.name}. Your stock moved to it.` });
}

/** Rejects with a reason. An excluded good (D-9) leaves the shop's counter list; any other reason leaves it on sale there. */
export async function rejectProductRequest(client: PoolClient, id: string, reason: string, excludedGood: boolean, adminId: string, at: Date): Promise<Outcome> {
  const request = await lockPending(client, id);
  if ("code" in request) return request;
  if (excludedGood) await lockShop(client, request);
  if (excludedGood) await client.query("UPDATE shop_listings SET removed_from_counter = true, available = false, updated_at = $2 WHERE id = $1", [request.listingId, at]);
  return finish(client, request, adminId, at, "product_request.reject", "rejected", { reason, excludedGood }, { title: "Product rejected", body: `${request.name}: ${reason}` });
}
