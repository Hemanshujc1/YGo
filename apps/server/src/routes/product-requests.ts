import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  AdminProductRequest, AdminProductRequestsQuery, AdminProductRequestsResponse, CreateProductRequestBody, ErrorEnvelope, MapProductRequestBody,
  ProductRequest, ProductRequestParams, ProductRequestsResponse, RejectProductRequestBody,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { withTransaction } from "../db";
import { approveProductRequest, createProductRequest, listAdminRequests, listShopRequests, mapProductRequest, rejectProductRequest, type Outcome } from "../product-requests";
import { deriveKeys, mobileSignedIn } from "../tokens";

const statusOf = { NOT_FOUND: 404, PRODUCT_REQUEST_RESOLVED: 409, PRODUCT_IMAGE_REQUIRED: 409, PACK_ALREADY_LISTED: 409, VALIDATION_FAILED: 400 } as const;
const taken = { master_products_name_brand_idx: "PRODUCT_NAME_IN_USE", packs_barcode_idx: "BARCODE_IN_USE" } as const;

/**
 * S38 (the Owner's requests) and A11 (Admin's queue) for CAT-3, #62. Only the Owner requests; Staff bill what was requested and are told
 * how it was answered. Only Admin answers: the catalog is Admin's (CAT-1), so an Area Manager is refused.
 */
export function registerProductRequestRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const ownerShop = (accountId: string, client: Pool | import("pg").PoolClient) => client.query<{ id: string; state: string }>(
    `SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id WHERE m.account_id = $1 AND m.role = 'owner' FOR UPDATE OF s`, [accountId]);

  app.get("/v1/shop/product-requests", { schema: { response: { 200: ProductRequestsResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [shop] } = await pool.query<{ id: string }>(
      "SELECT s.id FROM shops s JOIN shop_members m ON m.shop_id = s.id WHERE m.account_id = $1 AND m.role = 'owner'", [who.accountId]);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return listShopRequests(pool, shop.id);
  });

  app.post("/v1/shop/product-requests", { schema: { body: CreateProductRequestBody, response: { 200: ProductRequest, 201: ProductRequest, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as CreateProductRequestBody;
    try {
      return await withTransaction(pool, async (client) => {
        const { rows: [shop] } = await ownerShop(who.accountId, client);
        if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        if (!["approved", "live", "suspended"].includes(shop.state)) return reply.code(409).send({ error: { code: "SHOP_LISTING_NOT_READY" } });
        const made = await createProductRequest(client, shop.id, who.accountId, body);
        if (!made) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["categoryId"] } });
        await client.query("COMMIT");
        return reply.code(made.created ? 201 : 200).send(made.request);
      });
    } catch (error) {
      const code = taken[(error as { constraint?: string }).constraint as keyof typeof taken];
      if (code) return reply.code(409).send({ error: { code } });
      throw error;
    }
  });

  app.get("/v1/admin/product-requests", { schema: { querystring: AdminProductRequestsQuery, response: { 200: AdminProductRequestsResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    return { requests: await listAdminRequests(pool, (request.query as AdminProductRequestsQuery).status) };
  });

  const resolve = (url: string, body: typeof MapProductRequestBody | typeof RejectProductRequestBody | undefined, run: (client: import("pg").PoolClient, id: string, body: never, adminId: string, at: Date) => Promise<Outcome>) =>
    app.post(url, { schema: { params: ProductRequestParams, ...(body ? { body } : {}), response: { 200: AdminProductRequest, ...errors } } }, async (request, reply) => {
      const who = await adminSignedIn(request, reply, auth);
      if (!who) return reply;
      return withAdminTransaction(pool, who.accountId, reply, async (client) => {
        const outcome = await run(client, (request.params as ProductRequestParams).id, request.body as never, who.accountId, clock.now());
        if ("code" in outcome) return reply.code(statusOf[outcome.code]).send({ error: { code: outcome.code } });
        await client.query("COMMIT");
        return reply.code(200).send(outcome.request);
      });
    });
  resolve("/v1/admin/product-requests/:id/approve", undefined, (client, id, _body, adminId, at) => approveProductRequest(client, id, adminId, at));
  resolve("/v1/admin/product-requests/:id/map", MapProductRequestBody, (client, id, body: MapProductRequestBody, adminId, at) => mapProductRequest(client, id, body.packId, adminId, at));
  resolve("/v1/admin/product-requests/:id/reject", RejectProductRequestBody, (client, id, body: RejectProductRequestBody, adminId, at) => rejectProductRequest(client, id, body.reason, body.excludedGood, adminId, at));
}
