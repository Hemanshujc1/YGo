import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import { CatalogImportPreviewResponse, CatalogImportResponse, CATALOG_IMPORT_FILE_LIMITS, ErrorEnvelope } from "@ygo/contracts";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "../adapters/clock";
import type { PreparedProductImage, ProductImageStorage, ProductImageVariants } from "../adapters/product-images";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { CatalogImportFileError, previewCatalogImport, readCatalogImport, validateCatalogImport } from "../catalog-import";
import { deriveKeys } from "../tokens";

export function registerCatalogImportRoutes(app: FastifyInstance, options: { pool: Pool; clock: Clock; secret: string; images?: ProductImageStorage }): void {
  const auth = { ...options, keys: deriveKeys(options.secret) };
  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: CATALOG_IMPORT_FILE_LIMITS.imagesZipBytes, files: 2, fields: 0, parts: 2 } });
    scope.post("/v1/admin/catalog/import/commit", {
      schema: { response: { 200: CatalogImportResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 409: ErrorEnvelope, 503: ErrorEnvelope } },
    }, async (request, reply) => {
      const who = await adminSignedIn(request, reply, auth);
      if (!who) return reply;
      const images = options.images;
      if (!images) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      const uploaded: ProductImageVariants[] = [];
      let committed = false;
      try {
        const files = await readCatalogImport(request);
        // Validate every row and decode every image before any storage write.
        const preparedImages = new Map<string, PreparedProductImage>();
        const checked = await validateCatalogImport(files, options.pool, images, preparedImages);
        if (checked.preview.errors.length) return reply.code(409).send({ error: { code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors: checked.preview.errors } });
        return await withAdminTransaction(options.pool, who.accountId, reply, async (client) => {
          // Reads remain available; block catalog writes and row locks until COMMIT/ROLLBACK.
          await client.query("LOCK TABLE categories, master_products, packs IN EXCLUSIVE MODE");
          const current = await validateCatalogImport(files, client, images, preparedImages);
          if (current.preview.errors.length) return reply.code(409).send({ error: { code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors: current.preview.errors } });
          const result = { productsCreated: 0, productsSkipped: 0, packsCreated: 0, packsSkipped: 0 };
          const products = new Map<string, string>();
          for (const row of current.rows) {
            let productId = products.get(row.identity);
            if (!productId) {
              productId = row.productId ?? randomUUID();
              products.set(row.identity, productId);
              if (row.productId) result.productsSkipped++;
              else {
                const prepared = preparedImages.get(row.productCode)!;
                // Track keys before uploading so partial failures are cleaned up too.
                uploaded.push(images.keys(productId, prepared));
                let stored: Awaited<ReturnType<ProductImageStorage["storePrepared"]>>;
                try { stored = await images.storePrepared(productId, prepared); }
                catch (err) {
                  request.log.error({ err }, "Catalog import image storage failed");
                  reply.code(503);
                  return { error: { code: "UNAVAILABLE" } };
                }
                await client.query(`INSERT INTO master_products
                  (id, name, brand, category_id, base_unit, classification, image_256_key, image_512_key, image_1024_key, published)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
                [productId, row.name, row.brand, row.categoryId, row.baseUnit, row.classification, stored.keys[256], stored.keys[512], stored.keys[1024]]);
                await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'product.create', $2, 'product', 'Product created')", [who.accountId, productId]);
                result.productsCreated++;
              }
            }
            if (row.packId) result.packsSkipped++;
            else {
              const saved = await client.query<{ id: string }>("INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, $2, $3) RETURNING id", [productId, row.quantity, row.barcode]);
              await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'pack.create', $2, 'pack', 'Pack created')", [who.accountId, saved.rows[0]!.id]);
              result.packsCreated++;
            }
          }
          await client.query("COMMIT");
          committed = true;
          return result;
        });
      } catch (error) {
        if (error instanceof CatalogImportFileError) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: error.fields } });
        throw error;
      } finally {
        if (!committed) for (const keys of uploaded) {
          try { await images.remove(keys); }
          catch (err) { request.log.error({ err, keys }, "Catalog import image cleanup failed"); }
        }
      }
    });
    scope.post("/v1/admin/catalog/import/preview", {
      schema: { response: { 200: CatalogImportPreviewResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 503: ErrorEnvelope } },
    }, async (request, reply) => {
      if (!await adminSignedIn(request, reply, auth)) return reply;
      if (!options.images) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      try {
        return await previewCatalogImport(await readCatalogImport(request), options.pool, options.images);
      } catch (error) {
        if (error instanceof CatalogImportFileError) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: error.fields } });
        throw error;
      }
    });
  });
}
