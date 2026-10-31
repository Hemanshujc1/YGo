import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ErrorEnvelope,
  OpeningStockBody,
  OpeningStockResponse,
  SaveShopListingBody,
  ShopListingParams,
  ShopListingsResponse,
  ShopStockResponse,
  type ShopListingCatalogItem,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { heldOf, stockOf } from "../listings";
import { deriveKeys, mobileSignedIn } from "../tokens";

type Shop = { id: string; state: string };
type Auth = { pool: Pool; clock: Clock; secret: string };
type CatalogRow = {
  packId: string; productId: string; name: string; brand: string | null; baseUnit: ShopListingCatalogItem["baseUnit"];
  classification: ShopListingCatalogItem["classification"]; packQuantity: string; barcode: string | null;
  listingId: string | null; onlinePrice: string | null; counterPrice: string | null; mrp: string | null;
  lowStockLevel: string | null; available: boolean | null; minimumOrderQuantity: string | null; quantityStep: string | null;
  stock: string; held: string; openingStockRecorded: boolean; openingStock: string; outOfStock: boolean;
};

async function ownerShop(client: PoolClient, accountId: string): Promise<Shop | undefined> {
  const result = await client.query<Shop>(
    `SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
     WHERE m.account_id = $1 AND m.role = 'owner' FOR UPDATE OF s`,
    [accountId],
  );
  return result.rows[0];
}

function notReady(reply: { code(status: number): { send(body: unknown): unknown } }) {
  return reply.code(409).send({ error: { code: "SHOP_LISTING_NOT_READY" } });
}

function isWholeBaseUnitQuantity(quantity: string): boolean {
  return !/\.\d*[1-9]/.test(quantity);
}

function requiredListingValue<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Saved shop listing has no ${field}`);
  return value;
}

function projectCatalogItem(
  row: CatalogRow,
  quantityOptions: NonNullable<ShopListingCatalogItem["listing"]>["quantityOptions"] = [],
): ShopListingCatalogItem {
  return {
    packId: row.packId, productId: row.productId, name: row.name, brand: row.brand,
    baseUnit: row.baseUnit, classification: row.classification, packQuantity: row.packQuantity,
    barcode: row.barcode, stock: row.stock, held: row.held, openingStockRecorded: row.openingStockRecorded, openingStock: row.openingStock,
    listing: row.listingId === null ? null : {
      id: row.listingId,
      onlinePrice: requiredListingValue(row.onlinePrice, "online price"),
      counterPrice: requiredListingValue(row.counterPrice, "counter price"),
      mrp: requiredListingValue(row.mrp, "MRP"),
      lowStockLevel: requiredListingValue(row.lowStockLevel, "low-stock level"),
      available: requiredListingValue(row.available, "availability"),
      minimumOrderQuantity: row.minimumOrderQuantity, quantityStep: row.quantityStep, quantityOptions,
    },
  };
}

export const catalogSql = `SELECT pk.id AS "packId", p.id AS "productId", p.name, p.brand,
  p.base_unit AS "baseUnit", p.classification, pk.quantity AS "packQuantity", pk.barcode,
  sl.id AS "listingId", sl.online_price AS "onlinePrice", sl.counter_price AS "counterPrice",
  sl.out_of_stock AS "outOfStock", sl.mrp, sl.low_stock_level AS "lowStockLevel", sl.available,
  sl.minimum_order_quantity AS "minimumOrderQuantity", sl.quantity_step AS "quantityStep",
  ${stockOf("sl")}::text AS stock, ${heldOf("sl")}::text AS held,
  COALESCE(stock.opening_recorded, false) AS "openingStockRecorded", COALESCE(stock.opening_total, 0)::text AS "openingStock"
  FROM packs pk JOIN master_products p ON p.id = pk.product_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories parent ON parent.id = c.parent_id
  LEFT JOIN shop_listings sl ON sl.pack_id = pk.id AND sl.shop_id = $1
  LEFT JOIN LATERAL (SELECT bool_or(sm.kind = 'opening') AS opening_recorded,
      sum(sm.quantity) FILTER (WHERE sm.kind IN ('opening', 'opening_correction')) AS opening_total
    FROM stock_movements sm WHERE sm.listing_id = sl.id) stock ON true
  WHERE pk.active AND p.active AND p.published AND c.active AND COALESCE(parent.active, true)
  `;

export async function applyOpeningStock(client: PoolClient, accountId: string, shopId: string, packId: string, body: OpeningStockBody): Promise<
  { code: "NOT_FOUND" | "VALIDATION_FAILED" | "OPENING_STOCK_ALREADY_RECORDED" } | { status: 200 | 201; result: OpeningStockResponse }
> {
  const listing = await client.query<{ id: string; baseUnit: string }>(
    `SELECT sl.id, p.base_unit AS "baseUnit" FROM shop_listings sl
     JOIN packs pk ON pk.id = sl.pack_id JOIN master_products p ON p.id = pk.product_id
     WHERE sl.shop_id = $1 AND sl.pack_id = $2 FOR UPDATE OF sl`,
    [shopId, packId],
  );
  const row = listing.rows[0];
  if (!row) return { code: "NOT_FOUND" };
  if (row.baseUnit === "each" && !isWholeBaseUnitQuantity(body.quantity)) {
    return { code: "VALIDATION_FAILED" };
}
const existing = await client.query<{ actorId: string; clientId: string; quantity: string; sameQuantity: boolean; createdAt: Date }>(
  `SELECT actor_id AS "actorId", client_id AS "clientId", quantity, quantity = $2::numeric AS "sameQuantity",
    created_at AS "createdAt" FROM stock_movements WHERE listing_id = $1 AND kind = 'opening' FOR UPDATE`,
  [row.id, body.quantity],
);
if (existing.rows[0]) {
  const saved = existing.rows[0];
  if (saved.actorId === accountId && saved.clientId === body.clientId && saved.sameQuantity) {
    return { status: 200, result: { listingId: row.id, quantity: saved.quantity, recordedAt: saved.createdAt.toISOString() } };
  }
  return { code: "OPENING_STOCK_ALREADY_RECORDED" };
}
const inserted = await client.query<{ quantity: string; createdAt: Date }>(
  `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
   VALUES ($1, $2, $3, 'opening', $4) RETURNING quantity, created_at AS "createdAt"`,
  [row.id, accountId, body.clientId, body.quantity],
);
const movement = inserted.rows[0];
if (!movement) throw new Error("Opening stock insert returned no row");
return { status: 201, result: { listingId: row.id, quantity: movement.quantity, recordedAt: movement.createdAt.toISOString() } };
}

/**
 * Correct a recorded opening count to `body.quantity` (#452). Appends one signed `opening_correction` movement
 * of the difference, so the opening row stays and stock on hand is still the sum of movements. The listing row
 * lock serializes two devices: each correction is worked out against the latest committed opening total, so
 * the last one applied wins. Sales and holds since the opening are untouched.
 */
export async function applyOpeningStockCorrection(client: PoolClient, accountId: string, shopId: string, packId: string, body: OpeningStockBody): Promise<
  { code: "NOT_FOUND" | "VALIDATION_FAILED" | "OPENING_STOCK_NOT_RECORDED" } | { status: 200 | 201; result: OpeningStockResponse }
> {
  const listing = await client.query<{ id: string; baseUnit: string }>(
    `SELECT sl.id, p.base_unit AS "baseUnit" FROM shop_listings sl
     JOIN packs pk ON pk.id = sl.pack_id JOIN master_products p ON p.id = pk.product_id
     WHERE sl.shop_id = $1 AND sl.pack_id = $2 FOR UPDATE OF sl`,
    [shopId, packId],
  );
  const row = listing.rows[0];
  if (!row) return { code: "NOT_FOUND" };
  if (row.baseUnit === "each" && !isWholeBaseUnitQuantity(body.quantity)) return { code: "VALIDATION_FAILED" };
  const openingTotal = () => client.query<{ recorded: boolean; total: string }>(
    `SELECT COALESCE(bool_or(kind = 'opening'), false) AS recorded, COALESCE(sum(quantity), 0)::text AS total
     FROM stock_movements WHERE listing_id = $1 AND kind IN ('opening', 'opening_correction')`, [row.id]).then((answer) => answer.rows[0]);
  const same = await client.query<{ kind: string; actorId: string; createdAt: Date; target: string | null }>(
    `SELECT kind, actor_id AS "actorId", created_at AS "createdAt", target_quantity::text AS target
     FROM stock_movements WHERE listing_id = $1 AND client_id = $2`, [row.id, body.clientId]);
  if (same.rows[0]) {
    const saved = same.rows[0];
    if (saved.kind !== "opening_correction" || saved.actorId !== accountId) return { code: "VALIDATION_FAILED" };
    // The same id with another total is a different request, never a retry.
    if (Number(saved.target) !== Number(body.quantity)) return { code: "VALIDATION_FAILED" };
    // A retry of an applied correction answers with the opening total as it stands now.
    return { status: 200, result: { listingId: row.id, quantity: (await openingTotal())?.total ?? "0", recordedAt: saved.createdAt.toISOString() } };
  }
  const before = await openingTotal();
  if (!before?.recorded) return { code: "OPENING_STOCK_NOT_RECORDED" };
  const inserted = await client.query<{ createdAt: Date }>(
    `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity, target_quantity)
     VALUES ($1, $2, $3, 'opening_correction', $4::numeric - $5::numeric, $4::numeric) RETURNING created_at AS "createdAt"`,
    [row.id, accountId, body.clientId, body.quantity, before.total],
  );
  const movement = inserted.rows[0];
  if (!movement) throw new Error("Opening stock correction insert returned no row");
  return { status: 201, result: { listingId: row.id, quantity: (await openingTotal())?.total ?? "0", recordedAt: movement.createdAt.toISOString() } };
}

export function registerShopListingRoutes(app: FastifyInstance, { pool, clock, secret }: Auth): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/me/stock", { schema: { response: { 200: ShopStockResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    return withTransaction(pool, async (client) => {
      const { rows: [shop] } = await client.query<Shop>(`SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
        WHERE m.account_id = $1 AND m.role IN ('owner', 'staff') FOR UPDATE OF s`, [who.accountId]);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "live" && shop.state !== "suspended") return notReady(reply);
      const { rows } = await client.query<CatalogRow>(`${catalogSql} AND sl.id IS NOT NULL ORDER BY lower(p.name), pk.quantity`, [shop.id]);
      return reply.send({ shopId: shop.id, state: shop.state, items: rows.map((row) => ({
        listingId: row.listingId, packId: row.packId, name: row.name, packQuantity: row.packQuantity,
        baseUnit: row.baseUnit, quantity: row.stock, held: row.held, outOfStock: row.outOfStock,
      })) });
    });
  });

  app.get("/v1/me/shop-listings", { schema: { response: { 200: ShopListingsResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const result = await withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return notReady(reply);
      const rows = await client.query<CatalogRow>(`${catalogSql} ORDER BY lower(p.name), pk.quantity`, [shop.id]);
      const items = await Promise.all(rows.rows.map(async (row) => {
        if (!row.listingId) return projectCatalogItem(row);
        const options = await client.query<{ id: string; name: string; quantity: string; price: string }>(
          `SELECT id, name, quantity, price FROM shop_quantity_price_options WHERE listing_id = $1 ORDER BY quantity`,
          [row.listingId],
        );
        return projectCatalogItem(row, options.rows);
      }));
      return reply.send({ items });
    });
    return result;
  });

  app.put("/v1/me/shop-listings/:packId", {
    schema: { params: ShopListingParams, body: SaveShopListingBody, response: { 200: ShopListingsResponse.shape.items.element, ...errors } },
  }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { packId } = request.params as { packId: string };
    const body = request.body as typeof SaveShopListingBody._output;
    return withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return notReady(reply);
      const pack = await client.query<{ baseUnit: string; classification: string }>(
        `SELECT p.base_unit AS "baseUnit", p.classification FROM packs pk
         JOIN master_products p ON p.id = pk.product_id JOIN categories c ON c.id = p.category_id
         LEFT JOIN categories parent ON parent.id = c.parent_id
         WHERE pk.id = $1 AND pk.active AND p.active AND p.published AND c.active AND COALESCE(parent.active, true)
         FOR UPDATE OF pk, p`,
        [packId],
      );
      const product = pack.rows[0];
      if (!product) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (product.classification === "measured" && (!body.minimumOrderQuantity || !body.quantityStep)) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["minimumOrderQuantity", "quantityStep"] } });
      }
      if (product.classification === "counted" && (body.minimumOrderQuantity !== null || body.quantityStep !== null)) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["minimumOrderQuantity", "quantityStep"] } });
      }
      if (product.baseUnit === "each" && [body.lowStockLevel, ...body.quantityOptions.map((option) => option.quantity)].some((quantity) => !isWholeBaseUnitQuantity(quantity))) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["lowStockLevel", "quantityOptions"] } });
      }
      const saved = await client.query<{ id: string }>(
        `INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp, low_stock_level, available, minimum_order_quantity, quantity_step)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (shop_id, pack_id) DO UPDATE SET online_price = EXCLUDED.online_price,
           counter_price = EXCLUDED.counter_price, mrp = EXCLUDED.mrp, low_stock_level = EXCLUDED.low_stock_level,
           available = EXCLUDED.available, minimum_order_quantity = EXCLUDED.minimum_order_quantity,
           quantity_step = EXCLUDED.quantity_step, updated_at = now()
         RETURNING id`,
        [shop.id, packId, body.onlinePrice, body.counterPrice, body.mrp, body.lowStockLevel, body.available,
          body.minimumOrderQuantity, body.quantityStep],
      );
      const listingId = saved.rows[0]?.id;
      if (!listingId) throw new Error("Shop listing save returned no ID");
      await client.query("DELETE FROM shop_quantity_price_options WHERE listing_id = $1", [listingId]);
      for (const option of body.quantityOptions) {
        await client.query("INSERT INTO shop_quantity_price_options (listing_id, name, quantity, price) VALUES ($1, $2, $3, $4)", [listingId, option.name, option.quantity, option.price]);
      }
      const response = await client.query(`${catalogSql} AND pk.id = $2`, [shop.id, packId]);
      const row = response.rows[0] as CatalogRow | undefined;
      if (!row) throw new Error("Saved shop listing disappeared");
      const options = await client.query("SELECT id, name, quantity, price FROM shop_quantity_price_options WHERE listing_id = $1 ORDER BY quantity", [listingId]);
      await client.query("COMMIT");
      return reply.send(projectCatalogItem(row, options.rows));
    });
  });

  app.post("/v1/me/shop-listings/:packId/opening-stock", {
    schema: { params: ShopListingParams, body: OpeningStockBody, response: { 201: OpeningStockResponse, 200: OpeningStockResponse, ...errors } },
  }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { packId } = request.params as { packId: string };
    const body = request.body as typeof OpeningStockBody._output;
    return withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return notReady(reply);
      const answer = await applyOpeningStock(client, who.accountId, shop.id, packId, body);
      if ("code" in answer) return reply.code(answer.code === "NOT_FOUND" ? 404 : answer.code === "VALIDATION_FAILED" ? 400 : 409)
        .send({ error: { code: answer.code, ...(answer.code === "VALIDATION_FAILED" ? { fields: ["quantity"] } : {}) } });
      await client.query("COMMIT");
      return reply.code(answer.status).send(answer.result);
    }).catch((error: unknown) => {
      if ((error as { constraint?: string }).constraint === "stock_movements_one_opening_idx") {
        return reply.code(409).send({ error: { code: "OPENING_STOCK_ALREADY_RECORDED" } });
      }
      throw error;
    });
  });

  app.post("/v1/me/shop-listings/:packId/opening-stock-correction", {
    schema: { params: ShopListingParams, body: OpeningStockBody, response: { 201: OpeningStockResponse, 200: OpeningStockResponse, ...errors } },
  }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { packId } = request.params as { packId: string };
    const body = request.body as typeof OpeningStockBody._output;
    return withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return notReady(reply);
      const answer = await applyOpeningStockCorrection(client, who.accountId, shop.id, packId, body);
      if ("code" in answer) return reply.code(answer.code === "NOT_FOUND" ? 404 : answer.code === "VALIDATION_FAILED" ? 400 : 409)
        .send({ error: { code: answer.code, ...(answer.code === "VALIDATION_FAILED" ? { fields: ["quantity"] } : {}) } });
      await client.query("COMMIT");
      return reply.code(answer.status).send(answer.result);
    });
  });
}
