import multipart from "@fastify/multipart";
import { CatalogImportPreviewResponse, CATALOG_IMPORT_FILE_LIMITS, ErrorEnvelope } from "@ygo/contracts";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "../adapters/clock";
import type { ProductImageStorage } from "../adapters/product-images";
import { adminSignedIn } from "../admin";
import { CatalogImportFileError, previewCatalogImport, readCatalogImport } from "../catalog-import";
import { deriveKeys } from "../tokens";

export function registerCatalogImportRoutes(app: FastifyInstance, options: { pool: Pool; clock: Clock; secret: string; images?: ProductImageStorage }): void {
  const auth = { ...options, keys: deriveKeys(options.secret) };
  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: CATALOG_IMPORT_FILE_LIMITS.imagesZipBytes, files: 2, fields: 0, parts: 2 } });
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
