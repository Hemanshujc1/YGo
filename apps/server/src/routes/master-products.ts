import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  CreateMasterProductBody,
  EditMasterProductBody,
  ErrorEnvelope,
  MasterProduct,
  MasterProductParams,
  MasterProductsResponse,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { InvalidProductImageError, type PreparedProductImage, type ProductImageStorage, type ProductImageVariants } from "../adapters/product-images";
import { adminSignedIn } from "../admin";
import { deriveKeys } from "../tokens";

const productSql = `SELECT p.id, p.name, p.brand, p.category_id AS "categoryId", c.name AS "categoryName",
  c.active AS "categoryActive", (c.active AND COALESCE(parent.active, true)) AS "categoryEffectiveActive",
  p.base_unit AS "baseUnit", p.classification, p.image_256_key AS "image256Key",
  p.image_512_key AS "image512Key", p.image_1024_key AS "image1024Key", p.active, p.published
  FROM master_products p JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories parent ON parent.id = c.parent_id`;

type ProductRow = Omit<MasterProduct, "imageUrls"> & {
  image256Key: string | null;
  image512Key: string | null;
  image1024Key: string | null;
};
type Auth = { pool: Pool; clock: Clock; secret: string };

async function product(client: PoolClient, id: string, images: ProductImageStorage): Promise<MasterProduct> {
  const result = await client.query<ProductRow>(`${productSql} WHERE p.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Saved master product missing");
  return rowToProduct(row, images);
}

function rowToProduct(row: ProductRow, images: ProductImageStorage): MasterProduct {
  const keys = imageKeys(row);
  if (row.published && !keys) throw new Error("Published master product is missing image keys");
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryActive: row.categoryActive,
    categoryEffectiveActive: row.categoryEffectiveActive,
    baseUnit: row.baseUnit,
    classification: row.classification,
    imageUrls: keys ? images.urls(keys) : null,
    published: row.published,
    active: row.active,
  };
}

function invalidImage(reply: FastifyReply) {
  return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["image"] } });
}

async function isActiveCategory(client: PoolClient, id: string): Promise<boolean> {
  const category = await client.query<{ parentId: string | null; active: boolean }>(
    "SELECT parent_id AS \"parentId\", active FROM categories WHERE id = $1 FOR UPDATE",
    [id],
  );
  const row = category.rows[0];
  if (!row?.active) return false;
  if (!row.parentId) return true;
  const parent = await client.query<{ active: boolean }>("SELECT active FROM categories WHERE id = $1 FOR UPDATE", [row.parentId]);
  return Boolean(parent.rows[0]?.active);
}

function imageKeys(row: ProductRow): ProductImageVariants | null {
  if (!row.image256Key || !row.image512Key || !row.image1024Key) return null;
  return { 256: row.image256Key, 512: row.image512Key, 1024: row.image1024Key };
}

export function registerMasterProductRoutes(app: FastifyInstance, { pool, clock, secret, images }: Auth & { images?: ProductImageStorage }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errorResponses = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 503: ErrorEnvelope };

  app.get("/v1/admin/products", { schema: { response: { 200: MasterProductsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 503: ErrorEnvelope } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    if (!images) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const rows = await pool.query<ProductRow>(`${productSql} ORDER BY lower(p.name), lower(COALESCE(p.brand, ''))`);
    return { products: rows.rows.map((row) => rowToProduct(row, images)) };
  });

  app.post("/v1/admin/products", {
    bodyLimit: 14 * 1024 * 1024,
    schema: { body: CreateMasterProductBody, response: { 201: MasterProduct, ...errorResponses } },
  }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!images) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const body = request.body as CreateMasterProductBody;
    let prepared: PreparedProductImage;
    try {
      prepared = await images.prepare(Buffer.from(body.image, "base64"));
    } catch (error) {
      if (error instanceof InvalidProductImageError) return invalidImage(reply);
      throw error;
    }

    const client = await pool.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [who.accountId]);
      if (!member.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      }
      if (!await isActiveCategory(client, body.categoryId)) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["categoryId"] } });
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO master_products (name, brand, category_id, base_unit, classification)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.name, body.brand ?? null, body.categoryId, body.baseUnit, body.classification],
      );
      const newId = inserted.rows[0]?.id;
      if (!newId) throw new Error("Master product insert returned no ID");
      id = newId;
      await client.query(
        "INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'product.create', $2, 'product', 'Product created')",
        [who.accountId, id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string; constraint?: string }).constraint === "master_products_name_brand_idx") {
        return reply.code(409).send({ error: { code: "PRODUCT_NAME_IN_USE" } });
      }
      throw error;
    } finally {
      client.release();
    }

    let stored: Awaited<ReturnType<ProductImageStorage["storePrepared"]>>;
    try {
      stored = await images.storePrepared(id, prepared);
    } catch (error) {
      request.log.error({ err: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Unknown S3 error" } }, "Product image storage failed");
      return reply.code(503).send({ error: { code: "UNAVAILABLE", draftId: id } });
    }
    await pool.query(
      `UPDATE master_products SET image_256_key = $1, image_512_key = $2, image_1024_key = $3, published = true WHERE id = $4`,
      [stored.keys[256], stored.keys[512], stored.keys[1024], id],
    );
    const savedClient = await pool.connect();
    try {
      return reply.code(201).send(await product(savedClient, id, images));
    } finally {
      savedClient.release();
    }
  });

  app.patch("/v1/admin/products/:id", {
    bodyLimit: 14 * 1024 * 1024,
    schema: { params: MasterProductParams, body: EditMasterProductBody, response: { 200: MasterProduct, ...errorResponses } },
  }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!images) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as { id: string };
    const body = request.body as EditMasterProductBody;
    let stored: Awaited<ReturnType<ProductImageStorage["storePrepared"]>> | undefined;
    if (body.image !== undefined) {
      let prepared: PreparedProductImage;
      try {
        prepared = await images.prepare(Buffer.from(body.image, "base64"));
      } catch (error) {
        if (error instanceof InvalidProductImageError) return invalidImage(reply);
        throw error;
      }
      try {
        stored = await images.storePrepared(id, prepared);
      } catch (error) {
        request.log.error({ err: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Unknown S3 error" } }, "Product image storage failed");
        return reply.code(503).send({ error: { code: "UNAVAILABLE", draftId: id } });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [who.accountId]);
      if (!member.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      }
      const result = await client.query<ProductRow>(`${productSql} WHERE p.id = $1 FOR UPDATE OF p`, [id]);
      const old = result.rows[0];
      if (!old) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      }
      const oldKeys = imageKeys(old);
      if (!oldKeys && !stored) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["image"] } });
      }
      const nextCategory = body.categoryId ?? old.categoryId;
      if (nextCategory !== old.categoryId && !await isActiveCategory(client, nextCategory)) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["categoryId"] } });
      }
      const nextName = body.name ?? old.name;
      const nextBrand = body.brand === undefined ? old.brand : body.brand;
      const nextBaseUnit = body.baseUnit ?? old.baseUnit;
      const nextClassification = body.classification ?? old.classification;
      const nextActive = body.active ?? old.active;
      if ((nextClassification === "counted") !== (nextBaseUnit === "each")) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["baseUnit", "classification"] } });
      }
      const imageChanged = Boolean(stored && stored.keys[256] !== oldKeys?.[256]);
      const attributesChanged = nextName !== old.name || nextBrand !== old.brand || nextCategory !== old.categoryId ||
        nextBaseUnit !== old.baseUnit || nextClassification !== old.classification || nextActive !== old.active;
      const changed = attributesChanged || imageChanged;
      if (!changed) {
        await client.query("COMMIT");
        return reply.code(200).send(await product(client, id, images));
      }
      if (old.active && !nextActive && !body.reason) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
      }
      await client.query(
        `UPDATE master_products SET name = $1, brand = $2, category_id = $3, base_unit = $4,
         classification = $5, active = $6, image_256_key = $7, image_512_key = $8,
         image_1024_key = $9, published = true WHERE id = $10`,
        [nextName, nextBrand, nextCategory, nextBaseUnit, nextClassification, nextActive,
          stored?.keys[256] ?? oldKeys?.[256], stored?.keys[512] ?? oldKeys?.[512], stored?.keys[1024] ?? oldKeys?.[1024], id],
      );
      const action = old.active !== nextActive
        ? nextActive ? ["product.reactivate", "Product reactivated"] : ["product.deactivate", body.reason]
        : ["product.edit", "Product edited"];
      if (old.published || attributesChanged) {
        await client.query(
          "INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'product', $4)",
          [who.accountId, action[0], id, action[1]],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { constraint?: string }).constraint === "master_products_name_brand_idx") {
        return reply.code(409).send({ error: { code: "PRODUCT_NAME_IN_USE" } });
      }
      throw error;
    } finally {
      client.release();
    }

    const saved = await pool.connect();
    try {
      return reply.code(200).send(await product(saved, id, images));
    } finally {
      saved.release();
    }
  });
}
