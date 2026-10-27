import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  CountedPackQuantity,
  ErrorEnvelope,
  OpeningStockBody,
  OpeningStockResponse,
  SaveShopListingBody,
  ShopListingParams,
  ShopListingsResponse,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";

type Shop = { id: string; state: string };
type Auth = { pool: Pool; clock: Clock; secret: string };

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

const catalogSql = `SELECT pk.id AS "packId", p.id AS "productId", p.name, p.brand,
  p.base_unit AS "baseUnit", p.classification, pk.quantity AS "packQuantity", pk.barcode,
  sl.id AS "listingId", sl.online_price AS "onlinePrice", sl.counter_price AS "counterPrice",
  sl.mrp, sl.low_stock_level AS "lowStockLevel", sl.available,
  sl.minimum_order_quantity AS "minimumOrderQuantity", sl.quantity_step AS "quantityStep",
  COALESCE(stock.quantity, '0') AS stock, COALESCE(stock.opening_recorded, false) AS "openingStockRecorded"
  FROM packs pk JOIN master_products p ON p.id = pk.product_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories parent ON parent.id = c.parent_id
  LEFT JOIN shop_listings sl ON sl.pack_id = pk.id AND sl.shop_id = $1
  LEFT JOIN LATERAL (SELECT sum(sm.quantity) AS quantity, bool_or(sm.kind = 'opening') AS opening_recorded
    FROM stock_movements sm WHERE sm.listing_id = sl.id) stock ON true
  WHERE pk.active AND p.active AND p.published AND c.active AND COALESCE(parent.active, true)
  `;

export function registerShopListingRoutes(app: FastifyInstance, { pool, clock, secret }: Auth): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/me/shop-listings", { schema: { response: { 200: ShopListingsResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const result = await withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return notReady(reply);
      const rows = await client.query<Record<string, unknown>>(`${catalogSql} ORDER BY lower(p.name), pk.quantity`, [shop.id]);
      const items = await Promise.all(rows.rows.map(async (row) => {
        if (typeof row.listingId !== "string") return {
          packId: row.packId, productId: row.productId, name: row.name, brand: row.brand,
          baseUnit: row.baseUnit, classification: row.classification, packQuantity: row.packQuantity,
          barcode: row.barcode, listing: null, stock: "0", openingStockRecorded: false,
        };
        const options = await client.query<{ id: string; quantity: string; price: string }>(
          `SELECT id, quantity, price FROM shop_quantity_price_options WHERE listing_id = $1 ORDER BY quantity`,
          [row.listingId],
        );
        return {
          packId: row.packId,
          productId: row.productId,
          name: row.name,
          brand: row.brand,
          baseUnit: row.baseUnit,
          classification: row.classification,
          packQuantity: row.packQuantity,
          barcode: row.barcode,
          stock: row.stock,
          openingStockRecorded: row.openingStockRecorded,
          listing: {
            id: row.listingId,
            onlinePrice: row.onlinePrice,
            counterPrice: row.counterPrice,
            mrp: row.mrp,
            lowStockLevel: row.lowStockLevel,
            available: row.available,
            minimumOrderQuantity: row.minimumOrderQuantity,
            quantityStep: row.quantityStep,
            quantityOptions: options.rows,
          },
        };
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
      if (product.baseUnit === "each" && [body.lowStockLevel, ...body.quantityOptions.map((option) => option.quantity)].some((quantity) => quantity !== "0" && !CountedPackQuantity.safeParse(quantity).success)) {
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
        await client.query("INSERT INTO shop_quantity_price_options (listing_id, quantity, price) VALUES ($1, $2, $3)", [listingId, option.quantity, option.price]);
      }
      const response = await client.query(`${catalogSql} AND pk.id = $2`, [shop.id, packId]);
      const row = response.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error("Saved shop listing disappeared");
      const options = await client.query("SELECT id, quantity, price FROM shop_quantity_price_options WHERE listing_id = $1 ORDER BY quantity", [listingId]);
      await client.query("COMMIT");
      return reply.send({
        packId: row.packId, productId: row.productId, name: row.name, brand: row.brand, baseUnit: row.baseUnit,
        classification: row.classification, packQuantity: row.packQuantity, barcode: row.barcode, stock: row.stock,
        openingStockRecorded: row.openingStockRecorded,
        listing: { id: listingId, onlinePrice: row.onlinePrice, counterPrice: row.counterPrice, mrp: row.mrp,
          lowStockLevel: row.lowStockLevel, available: row.available, minimumOrderQuantity: row.minimumOrderQuantity,
          quantityStep: row.quantityStep, quantityOptions: options.rows },
      });
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
      const listing = await client.query<{ id: string; baseUnit: string }>(
        `SELECT sl.id, p.base_unit AS "baseUnit" FROM shop_listings sl
         JOIN packs pk ON pk.id = sl.pack_id JOIN master_products p ON p.id = pk.product_id
         WHERE sl.shop_id = $1 AND sl.pack_id = $2 FOR UPDATE OF sl`,
        [shop.id, packId],
      );
      const row = listing.rows[0];
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (row.baseUnit === "each" && body.quantity !== "0" && !CountedPackQuantity.safeParse(body.quantity).success) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["quantity"] } });
      }
      const existing = await client.query<{ actorId: string; clientId: string; quantity: string; sameQuantity: boolean; createdAt: Date }>(
        `SELECT actor_id AS "actorId", client_id AS "clientId", quantity, quantity = $2::numeric AS "sameQuantity",
          created_at AS "createdAt" FROM stock_movements WHERE listing_id = $1 AND kind = 'opening' FOR UPDATE`,
        [row.id, body.quantity],
      );
      if (existing.rows[0]) {
        const saved = existing.rows[0];
        if (saved.actorId === who.accountId && saved.clientId === body.clientId && saved.sameQuantity) {
          await client.query("COMMIT");
          return reply.code(200).send({ listingId: row.id, quantity: saved.quantity, recordedAt: saved.createdAt.toISOString() });
        }
        return reply.code(409).send({ error: { code: "OPENING_STOCK_ALREADY_RECORDED" } });
      }
      const inserted = await client.query<{ quantity: string; createdAt: Date }>(
        `INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity)
         VALUES ($1, $2, $3, 'opening', $4) RETURNING quantity, created_at AS "createdAt"`,
        [row.id, who.accountId, body.clientId, body.quantity],
      );
      const movement = inserted.rows[0];
      if (!movement) throw new Error("Opening stock insert returned no row");
      await client.query("COMMIT");
      return reply.code(201).send({ listingId: row.id, quantity: movement.quantity, recordedAt: movement.createdAt.toISOString() });
    }).catch((error: unknown) => {
      if ((error as { constraint?: string }).constraint === "stock_movements_one_opening_idx") {
        return reply.code(409).send({ error: { code: "OPENING_STOCK_ALREADY_RECORDED" } });
      }
      throw error;
    });
  });
}
