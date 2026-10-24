import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { CountedPackQuantity, CreatePackBody, EditPackBody, ErrorEnvelope, Pack, PackParams, PacksResponse, ProductPacksParams } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

const packColumns = `id, product_id AS "productId", quantity, barcode, active`;

function duplicate(error: unknown, reply: FastifyReply): FastifyReply {
  const constraint = (error as { constraint?: string }).constraint;
  if (constraint === "packs_barcode_idx") return reply.code(409).send({ error: { code: "BARCODE_IN_USE" } });
  if (constraint === "packs_product_quantity_idx") return reply.code(409).send({ error: { code: "PACK_QUANTITY_IN_USE" } });
  throw error;
}

export function registerPackRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const url = "/v1/admin/products/:productId/packs";

  app.get(url, { schema: { params: ProductPacksParams, response: { 200: PacksResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { productId } = request.params as { productId: string };
    const parent = await pool.query("SELECT 1 FROM master_products WHERE id = $1", [productId]);
    if (!parent.rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const result = await pool.query<Pack>(`SELECT ${packColumns} FROM packs WHERE product_id = $1 ORDER BY quantity`, [productId]);
    return { packs: result.rows };
  });

  app.post(url, { schema: { params: ProductPacksParams, body: CreatePackBody, response: { 201: Pack, ...errors } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { productId } = request.params as { productId: string };
    const body = request.body as CreatePackBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      // The product lock also serializes pack writes against base-unit changes.
      const parent = await client.query<{ base_unit: string }>("SELECT base_unit FROM master_products WHERE id = $1 FOR UPDATE", [productId]);
      if (!parent.rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (parent.rows[0].base_unit === "each" && !CountedPackQuantity.safeParse(body.quantity).success) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["quantity"] } });
      }
      const result = await client.query<Pack>(`INSERT INTO packs (product_id, quantity, barcode) VALUES ($1, $2, $3) RETURNING ${packColumns}`, [productId, body.quantity, body.barcode]);
      const saved = result.rows[0];
      if (!saved) throw new Error("Pack insert returned no row");
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'pack.create', $2, 'pack', 'Pack created')", [who.accountId, saved.id]);
      await client.query("COMMIT");
      return reply.code(201).send(saved);
    }).catch((error: unknown) => duplicate(error, reply));
  });

  app.patch(`${url}/:id`, { schema: { params: PackParams, body: EditPackBody, response: { 200: Pack, ...errors } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { productId, id } = request.params as { productId: string; id: string };
    const body = request.body as EditPackBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const parent = await client.query<{ base_unit: string }>("SELECT base_unit FROM master_products WHERE id = $1 FOR UPDATE", [productId]);
      if (!parent.rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const result = await client.query<Pack>(`SELECT ${packColumns} FROM packs WHERE id = $1 AND product_id = $2 FOR UPDATE`, [id, productId]);
      const old = result.rows[0];
      if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const quantity = body.quantity ?? old.quantity;
      if (parent.rows[0].base_unit === "each" && !CountedPackQuantity.safeParse(quantity).success) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["quantity"] } });
      }
      const barcode = body.barcode === undefined ? old.barcode : body.barcode;
      const active = body.active ?? old.active;
      if (old.active && !active && !body.reason) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
      const saved = await client.query<Pack>(
        `UPDATE packs SET quantity = $1, barcode = $2, active = $3 WHERE id = $4
         AND (quantity <> $1::numeric OR barcode IS DISTINCT FROM $2::text OR active <> $3) RETURNING ${packColumns}`,
        [quantity, barcode, active, id],
      );
      if (saved.rowCount) {
        const action = old.active !== active
          ? active ? ["pack.reactivate", "Pack reactivated"] : ["pack.deactivate", body.reason]
          : ["pack.edit", "Pack edited"];
        await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'pack', $4)", [who.accountId, action[0], id, action[1]]);
      }
      await client.query("COMMIT");
      return reply.code(200).send(saved.rows[0] ?? old);
    }).catch((error: unknown) => duplicate(error, reply));
  });
}
